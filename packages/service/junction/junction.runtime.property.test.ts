import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { defaultCorpus } from "./src/corpus.js"
import { diffCorpus, fingerprintCorpus } from "./src/corpus-tools.js"
import {
  createRuntime,
  createWebhookDispatcher,
  type JunctionRuntime,
  type LabAccountInput,
  ORDER_STATUSES_BY_METHOD,
  resolveTransition,
  signSvix,
  UNKNOWN_ZIP_ERROR_TYPE,
  UNKNOWN_ZIP_STATUS,
  US_STATES,
  verifySvix,
} from "./src/index.js"
import type { SealedCorpus } from "./src/sealed-corpus.js"
import { verifyAgainstReal } from "./src/verify.js"

const params = fcParameters(process.env)
const KEY = { "x-vital-api-key": "sk_us_test" }
const AT_HOME_LABCORP = "b439efda-1e07-4d2c-8afb-51771c7cc0cb"

type Json = Record<string, unknown>

const call = async (
  runtime: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) => {
  const response = await runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: {
        ...KEY,
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

const createUser = async (runtime: JunctionRuntime, namespace?: string) => {
  const headers = namespace ? { "x-mockingbird-namespace": namespace } : {}
  const res = await call(runtime, "POST", "/v2/user", {
    body: { client_user_id: `client-${Math.random().toString(36).slice(2)}` },
    headers,
  })
  expect(res.status).toBe(200)
  return res.body.user_id as string
}

const orderBody = (userId: string, state: string, extra: Json = {}) => ({
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
    city: "Somewhere",
    state,
    zip: "92101",
    country: "US",
  },
  order_set: { lab_test_ids: [AT_HOME_LABCORP] },
  ...extra,
})

const createOrder = async (runtime: JunctionRuntime, state = "CA", extra: Json = {}) => {
  const userId = await createUser(runtime)
  const res = await call(runtime, "POST", "/v3/order", { body: orderBody(userId, state, extra) })
  return { userId, res, orderId: (res.body.order as Json | undefined)?.id as string | undefined }
}

const admin = (runtime: JunctionRuntime, method: string, path: string, body?: unknown) =>
  call(runtime, method, `/__admin${path}`, body !== undefined ? { body } : {})

describe("service contract", () => {
  test("/health needs no vendor key and names the corpus", async () => {
    const runtime = createRuntime({ corpus: defaultCorpus })
    const res = await runtime.fetch(new Request("http://mock.local/health"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Json
    expect(body).toMatchObject({ status: "ok", service: "junction", geo: "corpus" })
    expect(String(body.corpus)).toMatch(/^v1-\d{4}-\d{2}-\d{2}-/)
    const vendor = await runtime.fetch(new Request("http://mock.local/v2/user"))
    expect(vendor.status).toBe(401)
  })

  test("namespaces keep parallel workers' users apart", async () => {
    const runtime = createRuntime()
    const a = await createUser(runtime, "worker-a")
    const inB = await call(runtime, "GET", `/v2/user/${a}`, {
      headers: { "x-mockingbird-namespace": "worker-b" },
    })
    expect(inB.status).toBe(404)
    const inA = await call(runtime, "GET", `/v2/user/${a}`, {
      headers: { "x-mockingbird-namespace": "worker-a" },
    })
    expect(inA.status).toBe(200)
    await admin(runtime, "POST", "/reset?namespace=worker-a")
    const afterReset = await call(runtime, "GET", `/v2/user/${a}`, {
      headers: { "x-mockingbird-namespace": "worker-a" },
    })
    expect(afterReset.status).toBe(404)
  })

  test("a snapshot rolls a namespace back", async () => {
    const runtime = createRuntime()
    const kept = await createUser(runtime)
    const { body } = await admin(runtime, "POST", "/snapshots")
    const dropped = await createUser(runtime)
    await admin(runtime, "POST", `/snapshots/${body.id}/restore`)
    expect((await call(runtime, "GET", `/v2/user/${kept}`)).status).toBe(200)
    expect((await call(runtime, "GET", `/v2/user/${dropped}`)).status).toBe(404)
  })
})

describe("A7 error shapes and faults", () => {
  test("unknown-user 404 bodies are Junction's exact bytes, per route", async () => {
    const runtime = createRuntime()
    const byId = await call(runtime, "GET", "/v2/user/00000000-0000-4000-8000-000000000000")
    expect(byId.status).toBe(404)
    expect(byId.text).toBe('{"detail":"Not found"}')
    const byClientId = await call(runtime, "GET", "/v2/user/resolve/no-such-client-user")
    expect(byClientId.status).toBe(404)
    expect(byClientId.text).toBe('{"detail":"User not found"}')
  })

  test("sandbox_user_quota reproduces the shared-sandbox error byte for byte", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (count) => {
        const runtime = createRuntime()
        const added = await admin(runtime, "POST", "/faults/presets/sandbox_user_quota", { count })
        expect(added.status).toBe(201)
        for (let i = 0; i < count; i++) {
          const res = await call(runtime, "POST", "/v2/user", { body: { client_user_id: `c${i}` } })
          expect(res.status).toBe(400)
          expect(res.text).toBe(
            '{"detail":{"error_type":"INVALID_REQUEST","error_message":"You have reached the maximum of 50 Sandbox users"}}',
          )
        }
        // Retired after `count`; other operations were never affected.
        expect(
          (await call(runtime, "POST", "/v2/user", { body: { client_user_id: "ok" } })).status,
        ).toBe(200)
      }),
      { ...params, numRuns: Math.min(params.numRuns ?? 100, 10) },
    )
  })

  test("an admin-injected fault stays in the namespace that asked for it", async () => {
    const runtime = createRuntime()
    const added = await call(runtime, "POST", "/__admin/faults/presets/sandbox_user_quota", {
      body: { count: 1 },
      headers: { "x-mockingbird-namespace": "worker-a" },
    })
    expect(added.status).toBe(201)
    const create = (namespace: string) =>
      call(runtime, "POST", "/v2/user", {
        body: { client_user_id: "c" },
        headers: { "x-mockingbird-namespace": namespace },
      })
    // worker-b is untouched; worker-a takes the one injected failure, then recovers.
    expect((await create("worker-b")).status).toBe(200)
    expect((await create("worker-a")).status).toBe(400)
    expect((await create("worker-a")).status).toBe(200)
  })
})

describe("A6 geo realism", () => {
  const covered = [
    ...new Set(
      Object.keys(defaultCorpus.observations).flatMap((key) => {
        const zip = /\/v3\/order\/area\/info\?.*zip_code=(\d{5})/.exec(key)?.[1]
        return zip ? [zip] : []
      }),
    ),
  ]

  test("covered ZIPs answer from the recording", async () => {
    const runtime = createRuntime({ corpus: defaultCorpus })
    const zip = covered[0] as string
    const res = await call(runtime, "GET", `/v3/order/area/info?zip_code=${zip}&radius=100`)
    expect(res.status).toBe(200)
    const recorded =
      defaultCorpus.observations[`GET /v3/order/area/info?radius=100&zip_code=${zip}`]
    expect(res.body).toEqual(recorded?.body as Json)
  })

  test("an unknown ZIP fails loudly in corpus mode instead of inventing coverage", async () => {
    // Reads are side-effect free, so one runtime per mode serves every run.
    const strict = createRuntime({ corpus: defaultCorpus })
    const synthetic = createRuntime({ corpus: defaultCorpus, geo: "synthetic" })
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^\d{5}$/).filter((zip) => !covered.includes(zip)),
        async (zip) => {
          const res = await call(strict, "GET", `/v3/order/area/info?zip_code=${zip}`)
          expect(res.status).toBe(UNKNOWN_ZIP_STATUS)
          expect((res.body.detail as Json).error_type).toBe(UNKNOWN_ZIP_ERROR_TYPE)
          expect((res.body.detail as Json).zip_code).toBe(zip)
          const psc = await call(strict, "GET", `/v3/order/psc/info?zip_code=${zip}&lab_id=4`)
          expect(psc.status).toBe(UNKNOWN_ZIP_STATUS)
          expect((await call(synthetic, "GET", `/v3/order/area/info?zip_code=${zip}`)).status).toBe(
            200,
          )
        },
      ),
      { ...params, numRuns: Math.min(params.numRuns ?? 100, 25) },
    )
  })

  test("psc/info at an unrecorded radius is the wider recording filtered by distance (#140)", async () => {
    // Drop every default-radius (25-mile) PSC recording, then derive each from the 100-mile
    // one: it must equal what the sandbox recorded at 25 miles.
    const pscDefaults = Object.keys(defaultCorpus.observations).filter(
      (key) => key.startsWith("GET /v3/order/psc/info?") && !key.includes("radius="),
    )
    expect(pscDefaults.length).toBeGreaterThan(100)
    const observations = Object.fromEntries(
      Object.entries(defaultCorpus.observations).filter(([key]) => !pscDefaults.includes(key)),
    )
    const runtime = createRuntime({ corpus: { ...defaultCorpus, observations } })
    let derived = 0
    for (const key of pscDefaults) {
      const query = new URLSearchParams(key.slice(key.indexOf("?") + 1))
      query.set("radius", "100")
      query.sort()
      const wide = defaultCorpus.observations[`GET /v3/order/psc/info?${query}`]
      if (!wide) continue
      const res = await call(runtime, "GET", `${key.slice("GET ".length)}&radius=25`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual(defaultCorpus.observations[key]?.body as Json)
      derived += 1
    }
    expect(derived).toBe(pscDefaults.length)
  })

  test("a covered ZIP never gets invented sites or labs at another radius (#140)", async () => {
    const runtime = createRuntime({ corpus: defaultCorpus })
    const recorded = (key: string) => defaultCorpus.observations[key]?.body as Json
    // radius=25 is the default radius, so it is the default-radius recording.
    const psc25 = await call(
      runtime,
      "GET",
      "/v3/order/psc/info?lab_id=13&zip_code=02108&radius=25",
    )
    expect(psc25.body).toEqual(recorded("GET /v3/order/psc/info?lab_id=13&zip_code=02108"))
    expect(psc25.body.patient_service_centers).toEqual([])
    const area25 = await call(runtime, "GET", "/v3/order/area/info?zip_code=02108&radius=25")
    expect(area25.body).toEqual(recorded("GET /v3/order/area/info?zip_code=02108"))
    // Smaller radii filter the smallest wider recording; 50 miles filters the 100-mile one.
    const quest100 = recorded("GET /v3/order/psc/info?lab_id=4&radius=100&zip_code=02108")
    const within = (body: Json, miles: number) =>
      (body.patient_service_centers as Json[]).filter((site) => Number(site.distance) < miles)
    const quest50 = await call(
      runtime,
      "GET",
      "/v3/order/psc/info?lab_id=4&zip_code=02108&radius=50",
    )
    expect(quest50.status).toBe(200)
    expect(quest50.body.patient_service_centers).toEqual(within(quest100, 50))
    const quest10 = await call(
      runtime,
      "GET",
      "/v3/order/psc/info?lab_id=4&zip_code=02108&radius=10",
    )
    expect(quest10.body.patient_service_centers).toEqual(
      within(recorded("GET /v3/order/psc/info?lab_id=4&zip_code=02108"), 10),
    )
    // within_radius counts cannot be derived: the corpus error, not an invented answer.
    for (const radius of [10, 20, 50]) {
      const area = await call(runtime, "GET", `/v3/order/area/info?zip_code=02108&radius=${radius}`)
      expect(area.status).toBe(UNKNOWN_ZIP_STATUS)
      expect((area.body.detail as Json).error_type).toBe(UNKNOWN_ZIP_ERROR_TYPE)
    }
  })

  test("a malformed ZIP is still Junction's 422, not the corpus error", async () => {
    const runtime = createRuntime({ corpus: defaultCorpus })
    expect((await call(runtime, "GET", "/v3/order/area/info?zip_code=abc")).status).toBe(422)
  })
})

describe("create_order with the deprecated top-level lab_test_id (#141)", () => {
  const { order_set: _orderSet, ...withoutOrderSet } = orderBody("", "CA")
  const post = async (runtime: JunctionRuntime, extra: Json) => {
    const userId = await createUser(runtime)
    return call(runtime, "POST", "/v3/order", {
      body: { ...withoutOrderSet, user_id: userId, ...extra },
    })
  }

  test("places the order for that one lab test", async () => {
    const res = await post(createRuntime(), { lab_test_id: AT_HOME_LABCORP })
    expect(res.status).toBe(200)
    expect(((res.body.order as Json).lab_test as Json).id).toBe(AT_HOME_LABCORP)
  })

  test("a malformed or unknown id is Junction's error, never a thrown TypeError", async () => {
    const runtime = createRuntime()
    const malformed = await post(runtime, { lab_test_id: "nope" })
    expect(malformed.status).toBe(422)
    expect(((malformed.body.detail as Json[])[0] as Json).loc).toEqual(["body", "lab_test_id"])
    const unknown = await post(runtime, { lab_test_id: "00000000-0000-4000-8000-000000000000" })
    expect([unknown.status, unknown.body]).toEqual([400, { detail: "Test does not exist" }])
    const neither = await post(runtime, {})
    expect([neither.status, neither.body]).toEqual([
      400,
      { detail: "Either lab_test_id or order_set must be set" },
    ])
  })
})

describe("A5 lab accounts", () => {
  const LABCORP_47 = US_STATES.filter((s) => !["NY", "NJ", "RI"].includes(s))
  const accounts: LabAccountInput[] = [
    { id: "acct-labcorp-47", lab: "labcorp", states: LABCORP_47, account_name: "Labcorp 47-state" },
    { id: "acct-labcorp-west", lab: "labcorp", states: ["CA", "AZ"] },
    { id: "acct-quest", lab: "quest" },
  ]

  test("orders route, accept and reject lab_account_id against configured accounts", async () => {
    const runtime = createRuntime({ labAccounts: accounts })
    const listed = await call(runtime, "GET", "/v3/lab_test/lab_account")
    expect((listed.body.data as Json[]).map((a) => a.id)).toEqual(accounts.map((a) => a.id))

    const ambiguous = await createOrder(runtime, "CA")
    expect(ambiguous.res.status).toBe(400)
    expect(ambiguous.res.body.detail).toMatch(/Multiple active lab accounts/)

    const wrongLab = await createOrder(runtime, "CA", { lab_account_id: "acct-quest" })
    expect(wrongLab.res.status).toBe(400)
    expect(wrongLab.res.body.detail).toBe("Lab account is not associated with lab labcorp")

    const unknown = await createOrder(runtime, "CA", { lab_account_id: "acct-nope" })
    expect(unknown.res.body.detail).toBe("Lab account does not exist")

    const outOfState = await createOrder(runtime, "TX", { lab_account_id: "acct-labcorp-west" })
    expect(outOfState.res.status).toBe(400)
    expect(outOfState.res.body.detail).toMatch(/not available in state TX/)

    const ok = await createOrder(runtime, "TX", { lab_account_id: "acct-labcorp-47" })
    expect(ok.res.status).toBe(200)
    // Junction's order has no lab_account_id; the mock reports it only through /__admin.
    expect("lab_account_id" in (ok.res.body.order as Json)).toBe(false)
    expect(runtime.instance().orderLabAccount(ok.orderId as string)).toBe("acct-labcorp-47")
  })

  test("with one active account for the lab, an omitted id selects it", async () => {
    const runtime = createRuntime({ labAccounts: [accounts[0] as LabAccountInput] })
    const order = await createOrder(runtime, "TX")
    expect(order.res.status).toBe(200)
  })

  test("accounts reconfigure at runtime and survive a reset", async () => {
    const runtime = createRuntime()
    const put = await admin(runtime, "PUT", "/lab-accounts", { accounts: [accounts[2]] })
    expect((put.body.data as Json[]).map((a) => a.id)).toEqual(["acct-quest"])
    await admin(runtime, "POST", "/reset")
    const listed = await call(runtime, "GET", "/v3/lab_test/lab_account")
    expect((listed.body.data as Json[]).map((a) => a.id)).toEqual(["acct-quest"])
    const bad = await admin(runtime, "PUT", "/lab-accounts", {
      accounts: [{ id: "x", lab: "quest", states: ["ZZ"] }],
    })
    expect(bad.status).toBe(400)
  })
})

describe("A8 order control", () => {
  test("transition aliases resolve to real contract statuses", () => {
    for (const [method, statuses] of Object.entries(ORDER_STATUSES_BY_METHOD)) {
      for (const alias of ["completed", "cancelled", "failed", "requisition_created"]) {
        const resolved = resolveTransition(method, alias)
        expect("status" in resolved).toBe(true)
        if ("status" in resolved) {
          const [phase, m, event] = resolved.status.split(".")
          expect(m).toBe(method)
          expect(statuses).toContain(`${phase}.${event}`)
        }
      }
    }
    expect("error" in resolveTransition("walk_in_test", "collected")).toBe(true)
    expect(resolveTransition("testkit", "at_lab")).toEqual({
      status: "sample_with_lab.testkit.delivered_to_lab",
    })
  })

  test("an admin transition completes an order with a named result and webhooks it", async () => {
    const runtime = createRuntime()
    const { orderId } = await createOrder(runtime)
    expect(orderId).toBeDefined()
    const before = await call(runtime, "GET", `/v3/order/${orderId}/result`)
    expect(before.status).toBe(404)
    const moved = await admin(runtime, "POST", `/orders/${orderId}/transition`, {
      to: "completed",
      result: "abnormal",
    })
    expect(moved.status).toBe(200)
    expect(moved.body.status).toBe("completed.at_home_phlebotomy.completed")
    const result = await call(runtime, "GET", `/v3/order/${orderId}/result`)
    expect(result.status).toBe(200)
    expect((result.body.metadata as Json).interpretation).toBe("abnormal")
    const last = runtime.instance().webhookEvents().at(-1)
    expect(last?.event_type).toBe("labtest.order.updated")
    expect(last?.data.status).toBe("completed")
  })

  test("an exact result fixture and PDF replace the generated ones", async () => {
    const runtime = createRuntime()
    const { orderId } = await createOrder(runtime)
    await admin(runtime, "POST", `/orders/${orderId}/transition`, { to: "completed" })
    const lines = [{ name: "Glucose", value: 250, unit: "mg/dL", interpretation: "critical" }]
    const pdf = Buffer.from("%PDF-1.4 fixture").toString("base64")
    const put = await admin(runtime, "PUT", `/results/${orderId}`, {
      name: "hyperglycemia",
      results: lines,
      pdf_base64: pdf,
    })
    expect(put.status).toBe(200)
    const raw = await call(runtime, "GET", `/v3/order/${orderId}/result`)
    expect(raw.body.results).toEqual(lines)
    const pdfRes = await runtime.fetch(
      new Request(`http://mock.local/v3/order/${orderId}/result/pdf`, { headers: KEY }),
    )
    expect(await pdfRes.text()).toBe("%PDF-1.4 fixture")
  })

  test("advancing the clock makes a delayed simulate transition due", async () => {
    const runtime = createRuntime()
    const { orderId } = await createOrder(runtime)
    const simulate = await call(
      runtime,
      "POST",
      `/v3/order/${orderId}/test?final_status=completed.at_home_phlebotomy.completed&delay=3600`,
    )
    expect(simulate.status).toBe(200)
    const early = await call(runtime, "GET", `/v3/order/${orderId}`)
    expect((early.body.last_event as Json).status).toBe("received.at_home_phlebotomy.ordered")
    await admin(runtime, "POST", "/clock", { advance: "2h" })
    const late = await call(runtime, "GET", `/v3/order/${orderId}`)
    expect((late.body.last_event as Json).status).toBe(
      "received.at_home_phlebotomy.requisition_created",
    )
  })

  test("an invalid target is refused with the valid options", async () => {
    const runtime = createRuntime()
    const { orderId } = await createOrder(runtime)
    const res = await admin(runtime, "POST", `/orders/${orderId}/transition`, { to: "teleported" })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/completed/)
  })
})

describe("A10 webhooks", () => {
  const secret = `whsec_${Buffer.from("mockingbird-test-secret-32-bytes!").toString("base64")}`

  /** Svix's documented algorithm, independently: HMAC-SHA256 over "id.timestamp.body". */
  const svixOracle = (id: string, timestamp: string, body: string) =>
    `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64")}`

  test("signatures match Svix's documented scheme", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string({ minLength: 1 }),
        fc.integer({ min: 0 }),
        async (body, id, ts) => {
          expect(await signSvix(secret, id, ts, body)).toBe(svixOracle(id, String(ts), body))
        },
      ),
      params,
    )
  })

  test("deliveries are signed, retried after failure, and replayable", async () => {
    const received: { headers: Headers; body: string }[] = []
    let failuresLeft = 1
    const dispatcher = createWebhookDispatcher({
      url: "https://receiver.test/hooks",
      secret,
      retryDelaysMs: [0, 60_000],
      fetch: async (request) => {
        received.push({ headers: request.headers, body: await request.text() })
        if (failuresLeft-- > 0) return new Response("nope", { status: 500 })
        return new Response("ok")
      },
    })
    const runtime = createRuntime()
    const delivery = dispatcher.publish(
      {
        event_type: "labtest.order.updated",
        data: { id: "o1" },
        team_id: "t",
        user_id: "u",
        client_user_id: "c",
      },
      "default",
    )
    await dispatcher.idle()
    expect(delivery.attempts.map((a) => a.status)).toEqual([500])
    expect(delivery.state).toBe("pending")
    await dispatcher.flush()
    expect(delivery.attempts.map((a) => a.status)).toEqual([500, 200])
    expect(delivery.state).toBe("delivered")
    for (const { headers, body } of received) {
      const id = headers.get("svix-id") as string
      const ts = headers.get("svix-timestamp") as string
      expect(headers.get("svix-signature")).toBe(svixOracle(id, ts, body))
      expect(
        await verifySvix(
          secret,
          {
            "svix-id": id,
            "svix-timestamp": ts,
            "svix-signature": headers.get("svix-signature") as string,
          },
          body,
        ),
      ).toBe(true)
    }
    await dispatcher.replay(delivery.messageId)
    expect(delivery.attempts).toHaveLength(3)
    void runtime
  })

  test("the runtime delivers every order event through the dispatcher", async () => {
    const bodies: string[] = []
    const runtime = createRuntime({
      webhooks: {
        url: "https://receiver.test/hooks",
        secret,
        fetch: async (request) => {
          bodies.push(await request.text())
          return new Response("ok")
        },
      },
    })
    const { orderId } = await createOrder(runtime)
    await runtime.webhooks?.idle()
    const listed = await admin(runtime, "GET", "/webhooks")
    const deliveries = listed.body.deliveries as { state: string; event: { data: Json } }[]
    expect(deliveries.length).toBeGreaterThan(0)
    expect(deliveries.every((d) => d.state === "delivered")).toBe(true)
    expect(deliveries.some((d) => d.event.data.id === orderId)).toBe(true)
    expect(bodies.length).toBe(deliveries.length)
  })
})

describe("A4 corpus tools", () => {
  test("the fingerprint ignores recording time but not content", async () => {
    const a = await fingerprintCorpus(defaultCorpus)
    const retimed = await fingerprintCorpus({
      ...defaultCorpus,
      recordedAt: "2000-01-01T00:00:00Z",
    })
    expect(retimed).toBe(a)
    const [firstKey] = Object.keys(defaultCorpus.observations)
    const changed: SealedCorpus = {
      ...defaultCorpus,
      observations: {
        ...defaultCorpus.observations,
        [firstKey as string]: { status: 500, headers: {}, body: null },
      },
    }
    expect(await fingerprintCorpus(changed)).not.toBe(a)
  })

  test("diff reports added ZIPs and changed observations", () => {
    const covered = new Set(
      Object.keys(defaultCorpus.observations).flatMap((k) => /zip_code=(\d{5})/.exec(k)?.[1] ?? []),
    )
    const zip = ["00501", "00601", "99950", "96799"].find((z) => !covered.has(z)) as string
    const key = `GET /v3/order/area/info?radius=100&zip_code=${zip}`
    const after: SealedCorpus = {
      ...defaultCorpus,
      observations: {
        ...defaultCorpus.observations,
        [key]: { status: 200, headers: {}, body: {} },
      },
    }
    const diff = diffCorpus(defaultCorpus, after)
    expect(diff.identical).toBe(false)
    expect(diff.zips.added).toEqual([zip])
    expect(diff.observations.added).toEqual([key])
    expect(diffCorpus(defaultCorpus, defaultCorpus).identical).toBe(true)
  })
})

describe("A11 verify", () => {
  const verifyWith = async (tamper?: (path: string, response: Response) => Promise<Response>) => {
    const real = createRuntime({ corpus: defaultCorpus })
    const report = await verifyAgainstReal({
      realKey: "sk_us_fake",
      realUrl: "https://real.test",
      corpus: defaultCorpus,
      mock: createRuntime({ corpus: defaultCorpus }),
      sample: 8,
      orders: true,
      minIntervalMs: 0,
      fetch: async (request) => {
        const response = await real.fetch(request)
        return tamper ? tamper(new URL(request.url).pathname, response) : response
      },
    })
    return { report, real }
  }

  test("--orders shows a team whose omitted billing_type is not client_bill (#137)", async () => {
    const slug = String(defaultCorpus.catalog.labTests[0]?.lab?.slug)
    const labTest = { lab: { slug } }
    const corpus = {
      ...defaultCorpus,
      labAccounts: [
        {
          id: "c0a80000-0000-4000-8000-0000000000c1",
          lab: labTest.lab.slug,
          org_id: "0a0a0000-0000-4000-8000-000000000001",
          status: "active",
          delegated_flow: "not_delegated",
          provider_account_id: "ACME-1",
          account_name: null,
          default_clinical_notes: null,
          business_units: null,
          allowed_billing: { client_bill: ["CA"] },
          team_id_allowlist: ["aaaaaaaa-0000-4000-8000-000000000001"],
        },
      ],
    }
    const real = createRuntime({
      corpus,
      defaultBillingTypes: { [labTest.lab.slug]: "patient_bill_passthrough" },
    })
    const report = await verifyAgainstReal({
      realKey: "sk_us_fake",
      realUrl: "https://real.test",
      corpus,
      mock: createRuntime({ corpus }),
      skipDrift: true,
      orders: true,
      minIntervalMs: 0,
      fetch: (request) => real.fetch(request),
    })
    // The plain order.create routes through the same (only) account, so it diverges too.
    expect(report.divergences.map((d) => [d.check, d.kind, d.real, d.mock])).toEqual([
      ["order.create", "status", 400, 200],
      [
        `order.create via ${labTest.lab.slug} account c0a80000-0000-4000-8000-0000000000c1 with billing_type omitted`,
        "status",
        400,
        200,
      ],
    ])
  })

  test("a faithful mock verifies clean, and the verify user is cleaned up", async () => {
    const { report, real } = await verifyWith()
    expect(report.divergences).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.drift.checked).toBe(8)
    const users = await call(real, "GET", "/v2/user")
    expect((users.body.users as unknown[]).length).toBe(0)
  })

  test("a diverging body is reported with where it differs", async () => {
    const { report } = await verifyWith(async (path, response) =>
      path === "/v2/user/00000000-0000-4000-8000-000000000000"
        ? new Response('{"detail":"User not found."}', { status: 404 })
        : response,
    )
    expect(report.ok).toBe(false)
    expect(report.divergences.map((d) => [d.check, d.kind, d.at])).toEqual([
      ["user.get unknown (documented 404 body)", "body", "$.detail"],
    ])
  })
})
