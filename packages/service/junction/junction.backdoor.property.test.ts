import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  createRuntime,
  DEFAULT_LIMITS,
  FAULT_PRESETS,
  JunctionAPI,
  type JunctionRuntime,
  sandboxUserQuotaBody,
} from "./src/index.js"

const params = fcParameters(process.env)
const AUTH = { "x-vital-api-key": "sk_us_test" }
const HOST = "http://mock.local"
const LAB_TEST = "c533549c-1e62-4afe-9a0e-0567a9b2bcc2" // walk-in CMP, Labcorp
const AT_HOME = "b439efda-1e07-4d2c-8afb-51771c7cc0cb" // at-home lipid panel, Labcorp

type Json = Record<string, unknown>

const call = async (
  target: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) => {
  const response = await target.fetch(
    new Request(`${HOST}${path}`, {
      method,
      headers: {
        ...AUTH,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  )
  const text = await response.text()
  let body: unknown = text
  try {
    body = text === "" ? null : JSON.parse(text)
  } catch {}
  return { status: response.status, body: body as Json, text, headers: response.headers }
}

const admin = (
  runtime: JunctionRuntime,
  method: string,
  path: string,
  body?: unknown,
  ns?: string,
) =>
  call(runtime, method, `/__admin${path}`, {
    ...(body !== undefined ? { body } : {}),
    ...(ns ? { headers: { "x-mockingbird-namespace": ns } } : {}),
  })

let seq = 0
const createUser = (target: { fetch(request: Request): Promise<Response> }) =>
  call(target, "POST", "/v2/user", { body: { client_user_id: `backdoor-${++seq}` } })

const orderBody = (userId: string, labTestId = LAB_TEST) => ({
  user_id: userId,
  patient_details: {
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "1990-01-01",
    gender: "female",
    phone_number: "+14155551234",
    email: "ada@example.com",
  },
  patient_address: {
    first_line: "1 Main St",
    city: "San Diego",
    state: "CA",
    zip: "92101",
    country: "US",
  },
  order_set: { lab_test_ids: [labTestId] },
})

describe("M4: sandbox limits are off by default", () => {
  test("a default instance creates 500 users without a cap", async () => {
    const api = new JunctionAPI()
    for (let i = 0; i < 500; i++) expect((await createUser(api)).status).toBe(200)
  }, 120_000)

  test("GET /__admin/limits on a default instance reports every limit off", async () => {
    const runtime = createRuntime()
    const res = await admin(runtime, "GET", "/limits")
    expect(res.body).toEqual({ limits: { ...DEFAULT_LIMITS } })
    expect(Object.values(DEFAULT_LIMITS).every((value) => value === null || value === false)).toBe(
      true,
    )
  })

  test("maxUsers counts live users: the next create fails with the sandbox body, a delete frees a slot", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async (max) => {
        const api = new JunctionAPI({ limits: { maxUsers: max } })
        const ids: string[] = []
        for (let i = 0; i < max; i++) {
          const res = await createUser(api)
          expect(res.status).toBe(200)
          ids.push(res.body.user_id as string)
        }
        const over = await createUser(api)
        expect(over.status).toBe(400)
        expect(over.body).toEqual(sandboxUserQuotaBody(max))
        expect((await call(api, "DELETE", `/v2/user/${ids[0]}`)).status).toBe(200)
        expect((await createUser(api)).status).toBe(200)
        expect((await createUser(api)).status).toBe(400)
      }),
      { ...params, numRuns: params.numRuns ?? 15 },
    )
  }, 30_000)

  test("maxUsers: 50 reproduces the sandbox error byte for byte", async () => {
    const api = new JunctionAPI({ limits: { maxUsers: 50 } })
    for (let i = 0; i < 50; i++) await createUser(api)
    const over = await createUser(api)
    expect(over.status).toBe(400)
    expect(over.text).toBe(
      '{"detail":{"error_type":"INVALID_REQUEST","error_message":"You have reached the maximum of 50 Sandbox users"}}',
    )
    expect(over.body).toEqual(FAULT_PRESETS.sandbox_user_quota?.body as Json)
  }, 30_000)

  test("PUT /__admin/limits is per namespace and survives that namespace's reset", async () => {
    const runtime = createRuntime()
    const set = await admin(runtime, "PUT", "/limits", { maxUsers: 1 }, "capped")
    expect((set.body.limits as Json).maxUsers).toBe(1)
    const inCapped = { headers: { "x-mockingbird-namespace": "capped" } }
    const create = (init = {}) =>
      call(runtime, "POST", "/v2/user", { body: { client_user_id: `ns-${++seq}` }, ...init })
    expect((await create(inCapped)).status).toBe(200)
    expect((await create(inCapped)).status).toBe(400)
    expect((await create()).status).toBe(200)
    expect((await create()).status).toBe(200)
    await call(runtime, "POST", "/__admin/reset?namespace=capped")
    expect((await create(inCapped)).status).toBe(200)
    expect((await create(inCapped)).status).toBe(400)
    await admin(runtime, "PUT", "/limits", { maxUsers: null }, "capped")
    expect((await create(inCapped)).status).toBe(200)
    const bad = await admin(runtime, "PUT", "/limits", { maxUsers: -1 })
    expect(bad.status).toBe(400)
    expect((await admin(runtime, "PUT", "/limits", { bogus: 1 })).status).toBe(400)
  })

  test("simulateRequiresSandbox refuses simulate for a non-sandbox key only", async () => {
    const api = new JunctionAPI({ limits: { simulateRequiresSandbox: true } })
    const user = (await createUser(api)).body.user_id as string
    const order = await call(api, "POST", "/v3/order", { body: orderBody(user, AT_HOME) })
    const id = (order.body.order as Json).id as string
    const path = `/v3/order/${id}/test?final_status=completed.at_home_phlebotomy.completed`
    const production = await call(api, "POST", path, {
      headers: { "x-vital-api-key": "pk_live_x" },
    })
    expect(production.status).toBe(400)
    expect((await call(api, "POST", path)).status).toBe(200)
  })

  test("rateLimitPerSecond answers 429 past the budget", async () => {
    const api = new JunctionAPI({ limits: { rateLimitPerSecond: 3 } })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await call(api, "GET", "/v3/lab_tests/labs")).status)
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses.slice(3)).toEqual([429, 429])
  })
})

describe("M6: inserting users and orders directly", () => {
  test("an inserted user can place orders, and reads back like an API-created one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid({ version: 4 }),
        // Path-safe: "/" and dot segments are normalized away by URL routing, as upstream.
        fc.stringMatching(/^[A-Za-z0-9_@-][A-Za-z0-9_.@-]{0,19}$/),
        async (id, client) => {
          const runtime = createRuntime()
          const inserted = await admin(runtime, "POST", "/users", {
            user_id: id,
            client_user_id: client,
          })
          expect(inserted.status).toBe(201)
          const byId = await call(runtime, "GET", `/v2/user/${id}`)
          expect(byId.status).toBe(200)
          expect(byId.body.client_user_id).toBe(client)
          const resolved = await call(
            runtime,
            "GET",
            `/v2/user/resolve/${encodeURIComponent(client)}`,
          )
          expect(resolved.body).toEqual(byId.body)
          const apiUser = (await createUser(runtime)).body
          expect(Object.keys(byId.body).sort()).toEqual(Object.keys(apiUser).sort())
          const order = await call(runtime, "POST", "/v3/order", { body: orderBody(id) })
          expect(order.status).toBe(200)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  }, 30_000)

  test("duplicate user_id or client_user_id is a 409; bulk inserts all or nothing", async () => {
    const runtime = createRuntime()
    const u = "4a9d7b52-7f1f-4d3a-9d0e-6a1c2b3c4d5e"
    expect(
      (await admin(runtime, "POST", "/users", { user_id: u, client_user_id: "c1" })).status,
    ).toBe(201)
    expect(
      (await admin(runtime, "POST", "/users", { user_id: u, client_user_id: "c2" })).status,
    ).toBe(409)
    expect((await admin(runtime, "POST", "/users", { client_user_id: "c1" })).status).toBe(409)
    const bulk = await admin(runtime, "POST", "/users/bulk", {
      users: [{ client_user_id: "b1" }, { client_user_id: "b2" }, { client_user_id: "c1" }],
    })
    expect(bulk.status).toBe(409)
    expect((await call(runtime, "GET", "/v2/user/resolve/b1")).status).toBe(404)
    const ok = await admin(runtime, "POST", "/users/bulk", {
      users: [{ client_user_id: "b1" }, { client_user_id: "b2" }],
    })
    expect(ok.status).toBe(201)
    expect((ok.body.users as Json[]).length).toBe(2)
    expect(
      (await admin(runtime, "POST", "/users", { client_user_id: "x", user_id: "nope" })).status,
    ).toBe(400)
  })

  test("DELETE /__admin/users/:id leaves no tombstone", async () => {
    const runtime = createRuntime()
    const u = "5b0e8c63-8a2a-4e4b-8e1f-7b2d3c4d5e6f"
    await admin(runtime, "POST", "/users", { user_id: u, client_user_id: "gone" })
    expect((await admin(runtime, "DELETE", `/users/${u}`)).status).toBe(200)
    const read = await call(runtime, "GET", `/v2/user/${u}`)
    expect(read.status).toBe(404)
    expect(read.body).toEqual({ detail: "Not found" })
    expect((await admin(runtime, "DELETE", `/users/${u}`)).status).toBe(404)
    expect(
      (await admin(runtime, "POST", "/users", { user_id: u, client_user_id: "gone" })).status,
    ).toBe(201)
  })

  test("an order inserted as completed reads back completed, with its attached result", async () => {
    const runtime = createRuntime()
    const u = "6c1f9d74-9b3b-4f5c-9f20-8c3e4d5e6f70"
    await admin(runtime, "POST", "/users", { user_id: u, client_user_id: "results" })
    const inserted = await admin(runtime, "POST", "/orders", {
      user_id: u,
      lab_test_id: AT_HOME,
      status: "completed",
      result_fixture: { results: [{ name: "LDL", result: "250" }], interpretation: "abnormal" },
    })
    expect(inserted.status).toBe(201)
    const id = inserted.body.id as string
    const read = await call(runtime, "GET", `/v3/order/${id}`)
    expect(read.status).toBe(200)
    expect(read.body.status).toBe("completed")
    expect((read.body.last_event as Json).status).toBe("completed.at_home_phlebotomy.completed")
    const listed = await call(runtime, "GET", `/v3/orders?user_id=${u}`)
    expect((listed.body.orders as Json[]).map((order) => order.id)).toEqual([id])
    const results = await call(runtime, "GET", `/v3/order/${id}/result`)
    expect(results.status).toBe(200)
    expect(JSON.stringify(results.body)).toContain("250")
  })

  test("inserted orders have create_order's shape and honour the mock clock", async () => {
    const runtime = createRuntime()
    await admin(runtime, "POST", "/clock", { set: "2026-01-02T03:04:05Z" })
    const user = (await createUser(runtime)).body.user_id as string
    const viaApi = (await call(runtime, "POST", "/v3/order", { body: orderBody(user) })).body
      .order as Json
    const viaAdmin = (
      await admin(runtime, "POST", "/orders", { user_id: user, lab_test_id: LAB_TEST })
    ).body
    expect(Object.keys(viaAdmin).sort()).toEqual(
      Object.keys({ ...viaApi, result_types: null }).sort(),
    )
    expect(viaAdmin.created_at).toBe("2026-01-02T03:04:05+00:00")
    const backdated = await admin(runtime, "POST", "/orders", {
      user_id: user,
      lab_test_id: LAB_TEST,
      created_at: "2025-06-01T00:00:00Z",
    })
    expect(backdated.body.created_at).toBe("2025-06-01T00:00:00+00:00")
  })

  test("references are checked: unknown users and lab tests are refused", async () => {
    const runtime = createRuntime()
    const user = (await createUser(runtime)).body.user_id as string
    const noUser = await admin(runtime, "POST", "/orders", {
      user_id: "7d2a0e85-0c4c-4a6d-8a31-9d4f5e6f7081",
      lab_test_id: LAB_TEST,
    })
    expect(noUser.status).toBe(404)
    const noTest = await admin(runtime, "POST", "/orders", {
      user_id: user,
      lab_test_id: "00000000-0000-4000-8000-000000000000",
    })
    expect(noTest.status).toBe(404)
    const badStatus = await admin(runtime, "POST", "/orders", {
      user_id: user,
      lab_test_id: LAB_TEST,
      status: "shipped",
    })
    expect(badStatus.status).toBe(400)
  })

  test("no webhook fires for fixtures unless emitWebhooks is true", async () => {
    const runtime = createRuntime()
    const u = "8e3b1f96-1d5d-4b7e-9b42-0e5f6a7b8c92"
    await admin(runtime, "POST", "/users", { user_id: u, client_user_id: "hooks" })
    await admin(runtime, "POST", "/orders", {
      user_id: u,
      lab_test_id: LAB_TEST,
      status: "completed",
    })
    await admin(runtime, "POST", "/import", {
      users: [{ client_user_id: "imported" }],
      orders: [{ user_id: u, lab_test_id: LAB_TEST }],
    })
    expect(runtime.instance().webhookEvents()).toEqual([])
    await admin(runtime, "POST", "/orders", {
      user_id: u,
      lab_test_id: LAB_TEST,
      status: "completed",
      emitWebhooks: true,
    })
    const events = runtime
      .instance()
      .webhookEvents()
      .map((event) => event.event_type)
    expect(events[0]).toBe("labtest.order.created")
    expect(events.slice(1).every((type) => type === "labtest.order.updated")).toBe(true)
  })

  test("import loads users then orders atomically, and fixtures re-apply on reset", async () => {
    const u = "9f4c2a07-2e6e-4c8f-8c53-1f6a7b8c9da3"
    const fixtures = {
      users: [{ user_id: u, client_user_id: "boot" }],
      orders: [{ user_id: u, lab_test_id: LAB_TEST, status: "completed" }],
    }
    const runtime = createRuntime({ fixtures })
    const inNs = { headers: { "x-mockingbird-namespace": "w2" } }
    for (const init of [{}, inNs]) {
      expect((await call(runtime, "GET", `/v2/user/${u}`, init)).status).toBe(200)
      const orders = await call(runtime, "GET", `/v3/orders?user_id=${u}`, init)
      expect((orders.body.orders as Json[])[0]?.status).toBe("completed")
    }
    await call(runtime, "POST", "/__admin/reset?all=1")
    expect((await call(runtime, "GET", `/v2/user/${u}`)).status).toBe(200)
    const partial = await admin(runtime, "POST", "/import", {
      users: [{ client_user_id: "half" }],
      orders: [{ user_id: "a05d3b18-3f7f-4d90-9d64-2a7b8c9daeb4", lab_test_id: LAB_TEST }],
    })
    expect(partial.status).toBe(404)
    expect((await call(runtime, "GET", "/v2/user/resolve/half")).status).toBe(404)
    expect(() => new JunctionAPI({ fixtures: { users: [{ client_user_id: "" }] } })).toThrow(
      /junction fixtures/,
    )
  })
})

describe("M7: lenient identity", () => {
  test("strict (the default) refuses an unknown user", async () => {
    const api = new JunctionAPI()
    const res = await call(api, "POST", "/v3/order", {
      body: orderBody("b16e4c29-4a8a-4ea1-8e75-3b8c9daebfc5"),
    })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ detail: "User does not exist on this team" })
  })

  test("adopt-users creates any unknown UUID user on first use, but never an order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid({ version: 4 }),
        fc.uuid({ version: 4 }),
        async (userId, orderId) => {
          const runtime = createRuntime({ identity: "adopt-users" })
          const placed = await call(runtime, "POST", "/v3/order", { body: orderBody(userId) })
          expect(placed.status).toBe(200)
          const user = await call(runtime, "GET", `/v2/user/${userId}`)
          expect(user.status).toBe(200)
          expect(user.body.user_id).toBe(userId)
          const listed = await call(runtime, "GET", `/v3/orders?user_id=${userId}`)
          expect(listed.status).toBe(200)
          expect((await call(runtime, "GET", `/v3/order/${orderId}`)).status).toBe(404)
          const journal = await admin(
            runtime,
            "GET",
            "/requests?operationId=create_order_v3_order_post",
          )
          const entries = journal.body.requests as Json[]
          expect(entries.at(-1)?.adopted).toBe(true)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 15 },
    )
  }, 30_000)

  test("a malformed id is not adopted, and PUT /__admin/identity switches per namespace", async () => {
    const runtime = createRuntime()
    expect((await admin(runtime, "GET", "/identity")).body).toEqual({ identity: "strict" })
    expect(
      (await admin(runtime, "PUT", "/identity", { mode: "adopt-users" }, "loose")).status,
    ).toBe(200)
    const loose = { headers: { "x-mockingbird-namespace": "loose" } }
    const unknown = "c27f5d3a-5b9b-4fb2-9f86-4c9daebfc0d6"
    expect(
      (await call(runtime, "POST", "/v3/order", { body: orderBody(unknown), ...loose })).status,
    ).toBe(200)
    expect((await call(runtime, "POST", "/v3/order", { body: orderBody(unknown) })).status).toBe(
      404,
    )
    // Validation refuses a malformed id before identity is consulted, as in strict mode.
    expect(
      (await call(runtime, "POST", "/v3/order", { body: orderBody("not-a-uuid"), ...loose }))
        .status,
    ).toBe(422)
    expect((await admin(runtime, "PUT", "/identity", { mode: "lenient" })).status).toBe(400)
  })
})
