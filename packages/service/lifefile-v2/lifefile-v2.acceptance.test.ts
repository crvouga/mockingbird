import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import liveErrors from "./corpus/live-errors.json" with { type: "json" }
import statusesCorpus from "./corpus/statuses.json" with { type: "json" }
import { createRuntime, PRODUCTION_STATUSES, SANDBOX_STATUSES } from "./src/index.js"
import { consumer, orderBody } from "./test/consumer.js"

const BASE = "http://lifefile.local"
const T0 = Date.parse("2026-11-24T22:57:51.000Z")

const boot = (options: Parameters<typeof createRuntime>[0] = {}) => {
  const clock = createClock()
  clock.set(T0)
  clock.freeze()
  const runtime = createRuntime({ latency: "none", clock, ...options })
  const fetch = (request: Request) => runtime.fetch(request)
  const client = consumer(BASE, fetch, { now: clock.now })
  return { runtime, clock, fetch, client }
}

const raw = async (
  fetch: (r: Request) => Promise<Response>,
  method: string,
  path: string,
  init: {
    token?: string | null
    vendor?: string | null
    body?: unknown
    form?: Record<string, string>
  } = {},
) => {
  const headers = new Headers({ accept: "application/json" })
  if (init.vendor !== null) headers.set("x-vendor-id", init.vendor ?? "10001")
  if (init.token) headers.set("authorization", `Bearer ${init.token}`)
  let body: string | undefined
  if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded")
    body = new URLSearchParams(init.form).toString()
  } else if (init.body !== undefined) {
    headers.set("content-type", "application/json")
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body)
  }
  const response = await fetch(
    new Request(`${BASE}/api/v2${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  )
  const text = await response.text()
  let json: unknown = text
  try {
    json = JSON.parse(text)
  } catch {}
  return {
    status: response.status,
    headers: response.headers,
    json: json as Record<string, unknown>,
  }
}

const tokenFor = async (fetch: (r: Request) => Promise<Response>) => {
  const issued = await raw(fetch, "POST", "/auth/token", {
    form: {
      grant_type: "client_credentials",
      client_id: "lifefile-client",
      client_secret: "lifefile-secret",
    },
  })
  return issued.json.access_token as string
}

const UUID_A = "f120f5b8-09fd-4b7d-a01b-08c4ec85bc25"
const UUID_B = "ff3510e2-f987-43db-a903-18a033e48755"

describe("sign-in (OAuth2 client credentials)", () => {
  test("a token answers 200 with the recorded shape: one day, scope *, Bearer", async () => {
    const { fetch } = boot()
    const issued = await raw(fetch, "POST", "/auth/token", {
      form: {
        grant_type: "client_credentials",
        client_id: "lifefile-client",
        client_secret: "lifefile-secret",
      },
    })
    expect(issued.status).toBe(200)
    expect(issued.json).toEqual({
      access_token: expect.any(String),
      token_type: "Bearer",
      expires_in: 86400,
      scope: "*",
    })
    expect((issued.json.access_token as string).split(".")).toHaveLength(3)
    expect(issued.headers.get("x-ratelimit-limit")).toBe("120")
  })

  test("credentials in the Basic header work too, and explicit form fields win", async () => {
    const { fetch } = boot()
    const response = await fetch(
      new Request(`${BASE}/api/v2/auth/token`, {
        method: "POST",
        headers: {
          "x-vendor-id": "10001",
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa("lifefile-client:lifefile-secret")}`,
        },
        body: "grant_type=client_credentials",
      }),
    )
    expect(response.status).toBe(200)
  })

  test.each([
    [
      "wrong secret",
      { client_secret: "nope" },
      "10001",
      401,
      { error: "invalid_client", error_description: "Invalid Credentials" },
    ],
    [
      "no X-Vendor-ID",
      {},
      null,
      422,
      { error: "invalid_request", error_description: "Validation Error" },
    ],
    [
      "grant_type password",
      { grant_type: "password" },
      "10001",
      422,
      { error: "invalid_request", error_description: "Validation Error" },
    ],
    [
      "missing grant_type",
      { grant_type: "" },
      "10001",
      422,
      { error: "invalid_request", error_description: "Validation Error" },
    ],
    [
      "another vendor",
      {},
      "99999",
      401,
      { error: "invalid_client", error_description: "Invalid Credentials" },
    ],
  ] as const)("%s → %i", async (_name, override, vendor, status, body) => {
    const { fetch } = boot()
    const form: Record<string, string> = {
      grant_type: "client_credentials",
      client_id: "lifefile-client",
      client_secret: "lifefile-secret",
      ...override,
    }
    if (form.grant_type === "") delete form.grant_type
    const issued = await raw(fetch, "POST", "/auth/token", { form, vendor })
    expect(issued.status).toBe(status)
    expect(issued.json).toEqual(body)
  })

  test("bearer errors carry the recorded messages and data", async () => {
    const { fetch } = boot()
    const token = await tokenFor(fetch)
    expect((await raw(fetch, "GET", "/ping", {})).json).toEqual({
      type: "error",
      message: "Authorization header is expected to reference a Bearer authentication",
      data: null,
    })
    const malformed = await raw(fetch, "GET", "/ping", { token: "not-a-jwt" })
    expect(malformed.status).toBe(401)
    expect(malformed.json).toEqual({
      type: "error",
      message: "Invalid authorization token: Wrong number of segments",
      data: [],
    })
    const noVendor = await raw(fetch, "GET", "/ping", { token, vendor: null })
    expect(noVendor.status).toBe(401)
    expect(noVendor.json).toEqual({
      type: "error",
      message: "X-Vendor-ID header is required",
      data: null,
    })
    const forged = await raw(fetch, "GET", "/ping", { token: `${token.slice(0, -4)}AAAA` })
    expect(forged.status).toBe(401)
  })

  test("a token dies after one hour idle on the mock clock, but lives while used", async () => {
    const { fetch, clock } = boot()
    const token = await tokenFor(fetch)
    for (let i = 0; i < 3; i++) {
      clock.advance(50 * 60_000)
      expect((await raw(fetch, "GET", "/ping", { token })).status).toBe(200)
    }
    clock.advance(60 * 60_000 + 1_000)
    const idle = await raw(fetch, "GET", "/ping", { token })
    expect(idle.status).toBe(401)
    expect(idle.json.type).toBe("error")
  })

  test("a token dies one day after issue even when used every few minutes", async () => {
    const { fetch, clock } = boot()
    const token = await tokenFor(fetch)
    for (let used = 0; used < 24 * 60; used += 50) {
      clock.advance(50 * 60_000)
      const ping = await raw(fetch, "GET", "/ping", { token })
      if (used + 50 >= 24 * 60) expect(ping.status).toBe(401)
      else expect(ping.status).toBe(200)
    }
  })

  test("the consumer refreshes once on a 401 and carries on", async () => {
    const { client, clock } = boot()
    expect((await client.call("GET", "/ping")).ok).toBe(true)
    clock.advance(56 * 60_000)
    const after = await client.call("GET", "/ping")
    expect(after.ok).toBe(true)
    expect(client.tokens.tokenRequests).toBe(2)
  })

  test("a secret expires 30 days after it was issued: no new tokens, invalid_client", async () => {
    const { fetch, clock } = boot()
    await tokenFor(fetch)
    clock.advance(30 * 86_400_000 + 1_000)
    const issued = await raw(fetch, "POST", "/auth/token", {
      form: {
        grant_type: "client_credentials",
        client_id: "lifefile-client",
        client_secret: "lifefile-secret",
      },
    })
    expect(issued.status).toBe(401)
    expect(issued.json).toEqual({
      error: "invalid_client",
      error_description: "Invalid Credentials",
    })
  })

  test("rotating the secret revokes every token and only the new secret signs in", async () => {
    const { fetch } = boot()
    const first = await tokenFor(fetch)
    const second = await tokenFor(fetch)
    const rotated = await raw(fetch, "POST", "/auth/secret/rotate", { token: first })
    expect(rotated.status).toBe(200)
    const secret = (rotated.json.data as { secret: string }).secret
    expect(typeof secret).toBe("string")
    expect(rotated.json).toMatchObject({
      type: "success",
      message: "API user secret rotated successfully.",
      data: { userName: "lifefile-client", secret: expect.any(String), revokedTokenCount: 2 },
    })
    expect((await raw(fetch, "GET", "/ping", { token: first })).status).toBe(401)
    expect((await raw(fetch, "GET", "/ping", { token: second })).status).toBe(401)
    expect(
      (
        await raw(fetch, "POST", "/auth/token", {
          form: {
            grant_type: "client_credentials",
            client_id: "lifefile-client",
            client_secret: "lifefile-secret",
          },
        })
      ).status,
    ).toBe(401)
    const fresh = await raw(fetch, "POST", "/auth/token", {
      form: {
        grant_type: "client_credentials",
        client_id: "lifefile-client",
        client_secret: secret,
      },
    })
    expect(fresh.status).toBe(200)
  })

  test("DELETE /auth/token revokes only the token that called it", async () => {
    const { fetch } = boot()
    const first = await tokenFor(fetch)
    const second = await tokenFor(fetch)
    const revoked = await raw(fetch, "DELETE", "/auth/token", { token: first })
    expect(revoked.json).toEqual({
      type: "success",
      message: "API token revoked successfully.",
      data: [],
    })
    expect((await raw(fetch, "GET", "/ping", { token: first })).status).toBe(401)
    expect((await raw(fetch, "GET", "/ping", { token: second })).status).toBe(200)
  })

  test("/auth/me reports the user, the token's times in Pacific offset, and the live privileges", async () => {
    const { fetch } = boot()
    const token = await tokenFor(fetch)
    const me = await raw(fetch, "GET", "/auth/me", { token })
    expect(me.status).toBe(200)
    expect(me.json).toMatchObject({
      type: "success",
      message: "Success.",
      data: {
        apiUser: {
          id: 200001,
          userName: "lifefile-client",
          vendorId: 10001,
          userGroup: "api-practice",
        },
        token: {
          authType: "api_user_v2_jwt",
          issuedAt: "2026-11-24T14:57:51-08:00",
          expiresAt: "2026-11-25T14:57:51-08:00",
          lastUsedOn: "2026-11-24T14:57:51-08:00",
        },
      },
    })
    const privileges = (me.json.data as { privileges: { id: string }[] }).privileges.map(
      (p) => p.id,
    )
    expect(privileges).toContain("orders.create")
    expect(privileges).not.toContain("practices.shipping-services.list")
    expect(privileges).toHaveLength(19)
  })

  test("ping echoes the method", async () => {
    const { fetch } = boot()
    const token = await tokenFor(fetch)
    expect((await raw(fetch, "GET", "/ping", { token })).json).toEqual({
      type: "success",
      message: "Success.",
      data: { http_method: "GET", ssl_client_verify: null },
    })
  })
})

describe("creating orders", () => {
  test("the reply is {orderId} only, with no fastTrack field", async () => {
    const { client } = boot()
    const created = await client.createOrder(orderBody())
    expect(created).toEqual({ ok: true, status: 200, data: { orderId: 50000001 } })
  })

  test("nothing is deduplicated: same message id, same rx uuid and a byte-identical body each make a new order", async () => {
    const { client } = boot()
    const first = await client.createOrder(orderBody({ uuid: UUID_A }))
    const sameMessage = await client.createOrder(orderBody({ uuid: UUID_B }))
    const sameRx = await client.createOrder(orderBody({ uuid: UUID_A, messageId: 805892245 }))
    const identical = await client.createOrder(orderBody({ uuid: UUID_A }))
    const ids: number[] = [first, sameMessage, sameRx, identical].map((r) =>
      r.ok ? r.data.orderId : 0,
    )
    expect(new Set(ids).size).toBe(4)
    const found = await client.findByRxUuid(UUID_A)
    const expected = [ids[3], ids[2], ids[0]] as number[]
    expect(found.ok && found.data.data.map((o) => o.id)).toEqual(expected)
    const upper = await client.findByRxUuid(UUID_A.toUpperCase())
    expect(upper.ok && upper.data.data.map((o) => o.id)).toEqual(expected)
    expect(found.ok && found.data).toMatchObject({
      total: 3,
      perPage: 20,
      currentPage: 1,
      lastPage: 1,
    })
  })

  test.each([
    [
      "two lines with one uuid",
      orderBody({
        rxs: [
          { ...orderBody().order.rxs[0], uuid: UUID_A },
          { ...orderBody().order.rxs[0], uuid: UUID_A.toUpperCase() },
        ],
      }),
      {
        "order.rxs.0.uuid": ["Each RX UUID must be unique within the order (case-insensitive)."],
        "order.rxs.1.uuid": ["Each RX UUID must be unique within the order (case-insensitive)."],
      },
    ],
    [
      "missing scheduleCode",
      orderBody({ scheduleCode: null }),
      { "order.rxs.0.scheduleCode": ["The order.rxs.0.scheduleCode field is required."] },
    ],
    [
      "patient last name of 31 characters",
      orderBody({ lastName: "G".repeat(31) }),
      {
        "order.patient.lastName": [
          "The order.patient.last name may not be greater than 30 characters.",
        ],
      },
    ],
    [
      "shipping address line of 61 characters",
      orderBody({ addressLine1: "A".repeat(61) }),
      {
        "order.shipping.addressLine1": [
          "The order.shipping.address line1 may not be greater than 60 characters.",
        ],
      },
    ],
    [
      "a uuid that is not one",
      orderBody({ uuid: "not-a-uuid" }),
      { "order.rxs.0.uuid": ["The order.rxs.0.uuid must be a valid UUID."] },
    ],
  ])("%s → 422 keyed by field", async (_name, body, data) => {
    const { client, runtime } = boot()
    const result = await client.createOrder(body)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      category: "validation",
      httpStatus: 422,
      fields: Object.keys(data).sort(),
    })
    const { fetch } = boot()
    const token = await tokenFor(fetch)
    const reply = await raw(fetch, "POST", "/orders", { token, body })
    expect(reply.json).toEqual({ type: "error", message: "Validation Error", data })
    expect(runtime.instance().orders()).toHaveLength(0)
  })

  test("a missing location, and an empty body, answer only the location error", async () => {
    const { fetch } = boot()
    const token = await tokenFor(fetch)
    const body = orderBody() as { order: Record<string, unknown> }
    delete body.order.location
    for (const sent of [body, {}]) {
      const reply = await raw(fetch, "POST", "/orders", { token, body: sent })
      expect(reply.status).toBe(422)
      expect(reply.json).toEqual({
        type: "error",
        message: "Validation Error",
        data: { "order.location.id": ["The order location id field is required."] },
      })
    }
  })

  test("an unknown location is 422 with its id; another practice is 403 with its id", async () => {
    const { fetch } = boot()
    const token = await tokenFor(fetch)
    const location = await raw(fetch, "POST", "/orders", {
      token,
      body: orderBody({ locationId: 999999 }),
    })
    expect(location.status).toBe(422)
    expect(location.json).toEqual({
      type: "error",
      message: "Invalid order location id received: '999999'",
      data: null,
    })
    const practice = await raw(fetch, "POST", "/orders", {
      token,
      body: orderBody({ practiceId: 1 }),
    })
    expect(practice.status).toBe(403)
    expect(practice.json).toEqual({
      type: "error",
      message: "This API user is not allowed to create an order for Practice ID 1.",
      data: null,
    })
  })

  test.each([
    [
      "schedule code L",
      (b: ReturnType<typeof orderBody>) => ({
        ...b,
        order: { ...b.order, rxs: [{ ...b.order.rxs[0], scheduleCode: "L" }] },
      }),
    ],
    [
      "an unformatted phone",
      (b: ReturnType<typeof orderBody>) => ({
        ...b,
        order: { ...b.order, patient: { ...b.order.patient, phoneHome: "5125550111" } },
      }),
    ],
    [
      "no patient phones",
      (b: ReturnType<typeof orderBody>) => {
        const { phoneHome: _h, phoneMobile: _m, ...patient } = b.order.patient
        return { ...b, order: { ...b.order, patient } }
      },
    ],
    [
      "no shipping block",
      (b: ReturnType<typeof orderBody>) => {
        const { shipping: _s, ...order } = b.order
        return { ...b, order }
      },
    ],
    [
      "a California address",
      (b: ReturnType<typeof orderBody>) => ({
        ...b,
        order: {
          ...b.order,
          shipping: { ...b.order.shipping, state: "CA", city: "Sacramento", zipCode: "95814" },
        },
      }),
    ],
    [
      "a text message id",
      (b: ReturnType<typeof orderBody>) => ({ ...b, message: { ...b.message, id: "abc" } }),
    ],
    [
      "an unknown shipping service",
      (b: ReturnType<typeof orderBody>) => ({
        ...b,
        order: { ...b.order, shipping: { ...b.order.shipping, service: 123456 } },
      }),
    ],
    [
      "an unknown lfProductID",
      (b: ReturnType<typeof orderBody>) => ({
        ...b,
        order: { ...b.order, rxs: [{ ...b.order.rxs[0], lfProductID: 1 }] },
      }),
    ],
    [
      "payor pat",
      (b: ReturnType<typeof orderBody>) => ({
        ...b,
        order: { ...b.order, billing: { payorType: "pat" } },
      }),
    ],
  ])("the API does not check %s", async (_name, change) => {
    const { client } = boot()
    const created = await client.createOrder(change(orderBody()))
    expect(created.ok).toBe(true)
  })
})

describe("reading orders", () => {
  test("an order reads back with the recorded shape, null-filled, starting on new", async () => {
    const { client } = boot()
    const created = await client.createOrder(orderBody())
    const id = created.ok ? created.data.orderId : 0
    const order = await client.order(id)
    expect(order.ok).toBe(true)
    if (!order.ok) return
    expect(order.data).toMatchObject({
      id,
      createdOn: "2026-11-24 14:57:51",
      lastUpdatedOn: "2026-11-24 14:57:51",
      general: {
        memo: "SYNTHETIC TEST - not a real patient",
        referenceId: "ref-0001",
        statusId: "new",
      },
      location: { id: 100001 },
      prescriber: {
        id: null,
        npi: "1234567893",
        dea: null,
        middleName: null,
        address2: null,
        fax: null,
      },
      practice: { id: 900001, name: "Sandbox API Practice - SBX-PRA-SYNTHETIC0001" },
      patient: { id: null, middleName: null, address2: null, address3: null, phoneWork: null },
      shipping: { addressLine2: null, addressLine3: null, service: null, handlingService: null },
      billing: { payorType: "doc" },
    })
    expect(Object.keys(order.data.shipping as object)).toHaveLength(14)
    const rx = (order.data.rxs as Record<string, unknown>[])[0]
    expect(rx).toMatchObject({
      fillId: null,
      rxNumber: null,
      note: null,
      uuid: UUID_A,
      scheduleCode: "O",
    })
    expect(rx).not.toHaveProperty("dateWritten")
    const status = await client.status(id)
    expect(status).toEqual({ ok: true, status: 200, data: { id: "new", label: "New Order" } })
    const shipping = await client.shipping(id)
    expect(shipping.ok && Object.keys(shipping.data)).toHaveLength(22)
  })

  test("missing and non-numeric orders answer the recorded errors", async () => {
    const { fetch } = boot()
    const token = await tokenFor(fetch)
    for (const path of ["/orders/1", "/orders/1/status"]) {
      const missing = await raw(fetch, "GET", path, { token })
      expect(missing.status).toBe(404)
      expect(missing.json).toEqual({ type: "error", message: "Record not found", data: null })
    }
    const text = await raw(fetch, "GET", "/orders/abc", { token })
    expect(text.status).toBe(422)
    expect(text.json).toEqual({
      type: "error",
      message: "Validation Error",
      data: { orderId: ["The order id must be an integer."] },
    })
  })

  test("the list is newest first, paginates with the recorded shape and filters by memo and status", async () => {
    const { client, fetch } = boot()
    const ids: number[] = []
    for (let i = 0; i < 7; i++) {
      const r = await client.createOrder(orderBody({ uuid: crypto.randomUUID() }))
      ids.push(r.ok ? r.data.orderId : 0)
    }
    const token = await tokenFor(fetch)
    const page = await raw(fetch, "GET", "/orders?perPage=5&page=2", { token })
    expect(page.json.data).toMatchObject({ total: 7, perPage: 5, currentPage: 2, lastPage: 2 })
    expect((page.json.data as { data: { id: number }[] }).data.map((o) => o.id)).toEqual([
      ids[1],
      ids[0],
    ] as number[])
    const memo = await raw(
      fetch,
      "GET",
      `/orders?${new URLSearchParams({ "filter[general][memo]": "synthetic test", perPage: "50" })}`,
      { token },
    )
    expect((memo.json.data as { total: number }).total).toBe(7)
    const none = await raw(
      fetch,
      "GET",
      `/orders?${new URLSearchParams({ "filter[general][statusId]": "del", perPage: "5" })}`,
      { token },
    )
    expect(none.json.data).toEqual({ data: [], total: 0, perPage: 5, currentPage: 1, lastPage: 1 })
  })
})

describe("status writes", () => {
  const created = async (client: ReturnType<typeof consumer>, locationId = 100001) => {
    const r = await client.createOrder(orderBody({ uuid: crypto.randomUUID(), locationId }))
    return r.ok ? r.data.orderId : 0
  }

  test("any existing code is accepted in any order, even back to new after del", async () => {
    const { client, clock } = boot()
    const id = await created(client)
    clock.advance(5_000)
    for (const status of ["pen", "b18d8", "pro", "cmpro", "rec", "new", "del", "pen"]) {
      expect(await client.setStatus(id, status)).toEqual({
        ok: true,
        status: 200,
        data: { status },
      })
      expect((await client.status(id)).ok && (await client.status(id))).toMatchObject({
        data: { id: status },
      })
    }
  })

  test("an unknown code is 404 with the code in the message, and the status stays", async () => {
    const { client, fetch, clock } = boot()
    const id = await created(client)
    clock.advance(5_000)
    await client.setStatus(id, "pen")
    const token = await tokenFor(fetch)
    for (const code of ["zzzzz", "3c59d"]) {
      const reply = await raw(fetch, "PUT", `/orders/${id}/status`, {
        token,
        body: { status: code },
      })
      expect(reply.status).toBe(404)
      expect(reply.json).toEqual({
        type: "error",
        message: `Order Status ID '${code}' does not exist`,
        data: null,
      })
    }
    expect(await client.status(id)).toMatchObject({ data: { id: "pen", label: "Pending Orders" } })
  })

  test("the production catalog accepts its own codes (3c59d) and refuses sandbox-only ones", async () => {
    const { client, clock } = boot({ settings: { catalog: "production" } })
    const id = await created(client, 100101)
    clock.advance(5_000)
    expect((await client.setStatus(id, "3c59d")).ok).toBe(true)
    expect((await client.setStatus(id, "b3644")).ok).toBe(false)
  })

  test("del right after create lands on b3644 with the fast-track reply; a second del sticks", async () => {
    const { client } = boot()
    const id = await created(client)
    const first = await client.setStatus(id, "del")
    expect(first).toEqual({
      ok: true,
      status: 200,
      data: {
        order_status_changed: 1,
        original_order_status: "new",
        current_order_status: "b3644",
        process_fast_track_result: [],
      },
    })
    expect(await client.status(id)).toMatchObject({
      data: { id: "b3644", label: "New EMR interfaces" },
    })
    expect(await client.setStatus(id, "del")).toMatchObject({ data: { status: "del" } })
  })

  test("the consumer's cancel reads back and sends del once more, ending on del", async () => {
    const { client } = boot()
    const id = await created(client)
    expect(await client.cancel(id)).toEqual({ landed: "del", attempts: 2 })
  })

  test.each([
    [
      "after one status read",
      async (
        c: ReturnType<typeof consumer>,
        id: number,
        _clock: ReturnType<typeof createClock>,
      ) => {
        await c.status(id)
      },
    ],
    [
      "after 5 s",
      async (
        _c: ReturnType<typeof consumer>,
        _id: number,
        clock: ReturnType<typeof createClock>,
      ) => {
        clock.advance(5_000)
      },
    ],
    [
      "after 20 s",
      async (
        _c: ReturnType<typeof consumer>,
        _id: number,
        clock: ReturnType<typeof createClock>,
      ) => {
        clock.advance(20_000)
      },
    ],
  ])("del %s is a plain del", async (_name, gap) => {
    const { client, clock } = boot()
    const id = await created(client)
    await gap(client, id, clock)
    expect(await client.setStatus(id, "del")).toEqual({
      ok: true,
      status: 200,
      data: { status: "del" },
    })
    expect(await client.status(id)).toMatchObject({ data: { id: "del", label: "Deleted" } })
    expect(await client.setStatus(id, "del")).toMatchObject({ data: { status: "del" } })
  })

  test("an untouched order moves itself to the intake status shortly after create, in the sandbox only", async () => {
    const sandbox = boot()
    const id = await created(sandbox.client)
    expect(await sandbox.client.status(id)).toMatchObject({ data: { id: "new" } })
    sandbox.clock.advance(600)
    expect(await sandbox.client.status(id)).toMatchObject({ data: { id: "b3644" } })
    const production = boot({ settings: { catalog: "production" } })
    const other = await created(production.client, 100101)
    production.clock.advance(60_000)
    expect(await production.client.status(other)).toMatchObject({ data: { id: "new" } })
  })

  test("a status written by the API is never overwritten by intake", async () => {
    const { client, clock } = boot()
    const id = await created(client)
    await client.status(id)
    await client.setStatus(id, "pen")
    clock.advance(60_000)
    expect(await client.status(id)).toMatchObject({ data: { id: "pen" } })
  })
})

describe("shipping changes", () => {
  test("PUT {shipping: {...}} merges into the order's shipping", async () => {
    const { client } = boot()
    const created = await client.createOrder(orderBody())
    const id = created.ok ? created.data.orderId : 0
    const put = await client.setShipping(id, {
      addressLine1: "300 Fake St",
      zipCode: "78702",
      recipientPhone: "(512) 555-0112",
    })
    expect(put).toEqual({ ok: true, status: 200, data: null })
    const shipping = await client.shipping(id)
    expect(shipping.ok && shipping.data).toMatchObject({
      addressLine1: "300 Fake St",
      zipCode: "78702",
      recipientPhone: "(512) 555-0112",
      recipientEmail: "patient@example.com",
    })
  })

  test("a bare shipping object crashes the vendor with the recorded 500 and changes nothing", async () => {
    const { client, fetch } = boot()
    const created = await client.createOrder(orderBody())
    const id = created.ok ? created.data.orderId : 0
    const token = await tokenFor(fetch)
    const bare = await raw(fetch, "PUT", `/orders/${id}/shipping`, {
      token,
      body: { addressLine1: "300 Fake St" },
    })
    expect(bare.status).toBe(500)
    expect(bare.json.type).toBe("error")
    expect(bare.json.message).toBe("Server Error: shipping must be an object, null given")
    expect((await client.shipping(id)).ok && (await client.shipping(id))).toMatchObject({
      data: { addressLine1: "200 Fake St" },
    })
  })
})

describe("reference lists and privileges", () => {
  test("statuses page through the sandbox's 89 codes, and the production catalog's 55", async () => {
    const sandbox = await boot().client.allStatuses()
    expect(sandbox.ok && sandbox.data.map((s) => s.id)).toEqual(SANDBOX_STATUSES.map((s) => s.id))
    expect(sandbox.ok && sandbox.data).toHaveLength(89)
    expect(SANDBOX_STATUSES).toEqual(statusesCorpus.sandbox)
    const production = await boot({ settings: { catalog: "production" } }).client.allStatuses()
    expect(production.ok && production.data).toHaveLength(55)
    expect(PRODUCTION_STATUSES).toEqual(statusesCorpus.production)
  })

  test("shipping services and locations list in the recorded envelope", async () => {
    const { fetch } = boot()
    const token = await tokenFor(fetch)
    const services = await raw(fetch, "GET", "/shipping-services?perPage=50", { token })
    expect(services.json.data).toMatchObject({
      total: 11,
      perPage: 50,
      currentPage: 1,
      lastPage: 1,
    })
    const locations = await raw(fetch, "GET", "/locations", { token })
    expect((locations.json.data as { data: { id: number }[] }).data.map((l) => l.id)).toEqual([
      100001, 100002, 100003,
    ])
    const one = await raw(fetch, "GET", "/locations/100002", { token })
    expect(one.json.data).toMatchObject({ id: 100002, shortName: "LF_North_2" })
  })

  test("privileges the account lacks answer the recorded 403s, and granting one opens it", async () => {
    const { fetch, runtime } = boot()
    const token = await tokenFor(fetch)
    const practice = await raw(fetch, "GET", "/practices/900001/shipping-services?perPage=50", {
      token,
    })
    expect(practice.status).toBe(403)
    expect(practice.json).toEqual({
      type: "error",
      message:
        "The authenticated API user does not have the required privilege 'practices.shipping-services.list'.",
      data: null,
    })
    const configs = await raw(fetch, "GET", "/locations/100001/shipping-configurations", { token })
    expect(configs.status).toBe(403)
    expect(configs.json.message).toBe(
      "The authenticated API user does not have the required privilege 'locations.shipping-configurations.list'.",
    )
    await runtime.fetch(
      new Request(`${BASE}/__admin/api-users`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "lifefile-client",
          secret: "lifefile-secret",
          privileges: ["practices.shipping-services.list"],
        }),
      }),
    )
    const granted = await raw(fetch, "GET", "/practices/900001/shipping-services", {
      token: await tokenFor(fetch),
    })
    expect(granted.status).toBe(200)
    expect((await raw(fetch, "GET", "/orders", { token: await tokenFor(fetch) })).json).toEqual({
      type: "error",
      message: "The authenticated API user does not have the required privilege 'orders.list'.",
      data: null,
    })
  })
})

describe("the recorded error replies (corpus/live-errors.json)", () => {
  test("every recorded error case has an emulator answer with the same status", () => {
    const statuses = liveErrors.errors.map((e) => e.status)
    expect(new Set(statuses)).toEqual(new Set([401, 422, 403, 404, 500]))
    expect(liveErrors.errors.length).toBeGreaterThanOrEqual(20)
  })
})
