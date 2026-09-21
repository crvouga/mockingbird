import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  createRuntime,
  JunctionAPI,
  type JunctionRuntime,
  KNOWN_HEADER,
  MISS_HEADER,
  ORDER_NOT_FOUND,
} from "./src/index.js"
import { verifyAgainstReal } from "./src/verify.js"

const params = fcParameters(process.env)
const AUTH = { "x-vital-api-key": "sk_us_test" }
const HOST = "http://mock.local"
const LAB_TEST = "c533549c-1e62-4afe-9a0e-0567a9b2bcc2"

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

let seq = 0
const createUser = async (runtime: JunctionRuntime, headers: Record<string, string> = {}) =>
  (await call(runtime, "POST", "/v2/user", { body: { client_user_id: `obs-${++seq}` }, headers }))
    .body.user_id as string

const orderBody = (userId: string) => ({
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
  order_set: { lab_test_ids: [LAB_TEST] },
})

/** Requests of every kind the runtime answers: vendor, error, unmatched, fault, admin, health. */
const anyRequest = fc.constantFrom(
  { method: "GET", path: "/v3/lab_tests/labs" },
  { method: "GET", path: "/v3/order/00000000-0000-4000-8000-000000000000" },
  { method: "GET", path: "/v2/user/not-a-uuid" },
  { method: "GET", path: "/v9/nothing/here" },
  { method: "POST", path: "/v2/user" },
  { method: "GET", path: "/health" },
  { method: "GET", path: "/__admin/metrics" },
  { method: "GET", path: "/__admin/nope" },
)

describe("M5: the mock identifies itself", () => {
  test("every response carries x-mockingbird with the service and namespace", async () => {
    const runtime = createRuntime()
    await call(runtime, "POST", "/__admin/faults", {
      body: { id: "boom", pathPrefix: "/v3/lab_tests/labs", status: 503, rate: 0.5 },
    })
    await fc.assert(
      fc.asyncProperty(
        anyRequest,
        fc.constantFrom("default", "w1", "w-2"),
        fc.boolean(),
        async (req, ns, authed) => {
          const res = await call(runtime, req.method, req.path, {
            headers: {
              "x-mockingbird-namespace": ns,
              ...(authed ? {} : { "x-vital-api-key": "" }),
            },
          })
          expect(res.headers.get("x-mockingbird")).toMatch(
            new RegExp(`^junction@[^;]+; ns=${ns.replace(/[-]/g, "\\-")}$`),
          )
        },
      ),
      { ...params, numRuns: params.numRuns ?? 60 },
    )
    const invalid = await call(runtime, "GET", "/v3/lab_tests/labs", {
      headers: { "x-mockingbird-namespace": "bad namespace!" },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get("x-mockingbird")).toMatch(/^junction@[^;]+$/)
  }, 30_000)

  test("the journal records a created order's id, and filters by operation, status and time", async () => {
    const runtime = createRuntime()
    await call(runtime, "POST", "/__admin/clock", {
      body: { set: "2026-03-01T00:00:00Z", freeze: true },
    })
    const userId = await createUser(runtime)
    const placed = await call(runtime, "POST", "/v3/order", { body: orderBody(userId) })
    const orderId = (placed.body.order as Json).id as string
    await call(runtime, "GET", `/v3/order/${orderId}`)
    const created = await call(
      runtime,
      "GET",
      "/__admin/requests?operationId=create_order_v3_order_post",
    )
    const entries = created.body.requests as Json[]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.ids).toEqual({ orderId, userId })
    expect(entries[0]?.status).toBe(200)
    expect(entries[0]?.at).toBe("2026-03-01T00:00:00.000Z")
    const read = (
      await call(runtime, "GET", "/__admin/requests?operationId=get_order_v3_order__order_id__get")
    ).body.requests as Json[]
    expect(read[0]?.ids).toEqual({ orderId })
    expect(
      ((await call(runtime, "GET", "/__admin/requests?status=404")).body.requests as Json[]).length,
    ).toBe(0)
    expect(
      (
        (await call(runtime, "GET", "/__admin/requests?since=2026-03-02T00:00:00Z")).body
          .requests as Json[]
      ).length,
    ).toBe(0)
    expect(
      ((await call(runtime, "GET", "/__admin/requests?limit=1")).body.requests as Json[]).length,
    ).toBe(1)
    expect((await call(runtime, "GET", "/__admin/requests?since=yesterday")).status).toBe(400)
    await call(runtime, "DELETE", "/__admin/requests")
    expect((await call(runtime, "GET", "/__admin/requests")).body.requests).toEqual([])
  })

  test("the journal is a per-namespace ring buffer of the configured size", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.constantFrom("a", "b"), { maxLength: 16 }),
        async (size, namespaces) => {
          const runtime = createRuntime({ journalSize: size })
          const sent: Record<string, string[]> = { a: [], b: [] }
          for (const [index, ns] of namespaces.entries()) {
            const path = `/v2/user/resolve/client-${index}`
            await call(runtime, "GET", path, { headers: { "x-mockingbird-namespace": ns } })
            sent[ns]?.push(path)
          }
          for (const ns of ["a", "b"]) {
            const logged = (
              await call(runtime, "GET", "/__admin/requests", {
                headers: { "x-mockingbird-namespace": ns },
              })
            ).body.requests as Json[]
            expect(logged.map((entry) => entry.path)).toEqual((sent[ns] ?? []).slice(-size))
          }
          const all = (await call(runtime, "GET", "/__admin/requests?all=1")).body
            .requests as Json[]
          expect(all.length).toBe(
            Math.min(size, sent.a?.length ?? 0) + Math.min(size, sent.b?.length ?? 0),
          )
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  }, 30_000)

  test("the structured log carries the ids, never bodies", async () => {
    const lines: Json[] = []
    const runtime = createRuntime({ onLog: (entry) => lines.push(entry as unknown as Json) })
    const userId = await createUser(runtime)
    const entry = lines.at(-1) as Json
    expect(entry.operationId).toBe("create_user_v2_user_post")
    expect(entry.ids).toEqual({ userId })
    expect(JSON.stringify(lines)).not.toContain("client_user_id")
  })

  test("a missing user or order keeps Junction's body and adds miss headers", async () => {
    const runtime = createRuntime()
    await createUser(runtime)
    await fc.assert(
      fc.asyncProperty(fc.uuid({ version: 4 }), async (id) => {
        const order = await call(runtime, "GET", `/v3/order/${id}`)
        expect(order.status).toBe(404)
        expect(order.text).toBe(`{"detail":"This order doesn't exist"}`)
        expect(order.headers.get(MISS_HEADER)).toBe(`order ${id}`)
        expect(order.headers.get(KNOWN_HEADER)).toBe("users=1 orders=0")
        const user = await call(runtime, "GET", `/v2/user/${id}`)
        expect(user.text).toBe(`{"detail":"Not found"}`)
        expect(user.headers.get(MISS_HEADER)).toBe(`user ${id}`)
        const resolved = await call(runtime, "GET", "/v2/user/resolve/who%20dis")
        expect(resolved.headers.get(MISS_HEADER)).toBe("user client:who%20dis")
      }),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  }, 30_000)
})

describe("M9: unknown-order 404 bodies, per operation", () => {
  const requestFor = (
    operationId: string,
    id: string,
  ): { method: string; path: string; body?: unknown } => {
    const base = `/v3/order/${id}`
    const key = { booking_key: "00000000-0000-4000-8000-00000000b00c" }
    const reason = { cancellation_reason_id: "00000000-0000-4000-8000-00000000c0de" }
    const table: Record<string, { method: string; path: string; body?: unknown }> = {
      get_order_v3_order__order_id__get: { method: "GET", path: base },
      cancel_order_v3_order__order_id__cancel_post: { method: "POST", path: `${base}/cancel` },
      simulate_order_v3_order__order_id__test_post: {
        method: "POST",
        path: `${base}/test?final_status=completed.at_home_phlebotomy.completed`,
      },
      get_order_requisition_pdf_v3_order__order_id__requisition_pdf_get: {
        method: "GET",
        path: `${base}/requisition/pdf`,
      },
      get_result_raw_v3_order__order_id__result_get: { method: "GET", path: `${base}/result` },
      get_result_metadata_v3_order__order_id__result_metadata_get: {
        method: "GET",
        path: `${base}/result/metadata`,
      },
      get_result_pdf_v3_order__order_id__result_pdf_get: {
        method: "GET",
        path: `${base}/result/pdf`,
      },
    }
    for (const kind of ["phlebotomy", "psc"]) {
      const prefix = kind === "phlebotomy" ? "phlebotomy" : "psc"
      table[`get_${prefix}_appointment_v3_order__order_id__${prefix}_appointment_get`] = {
        method: "GET",
        path: `${base}/${kind}/appointment`,
      }
      table[`book_${prefix}_appointment_v3_order__order_id__${prefix}_appointment_book_post`] = {
        method: "POST",
        path: `${base}/${kind}/appointment/book`,
        body: key,
      }
      table[
        `reschedule_${prefix}_appointment_v3_order__order_id__${prefix}_appointment_reschedule_patch`
      ] = { method: "PATCH", path: `${base}/${kind}/appointment/reschedule`, body: key }
      table[`cancel_${prefix}_appointment_v3_order__order_id__${prefix}_appointment_cancel_patch`] =
        { method: "PATCH", path: `${base}/${kind}/appointment/cancel`, body: reason }
    }
    const entry = table[operationId]
    if (!entry) throw new Error(`no request for ${operationId}`)
    return entry
  }

  test("every order-scoped operation answers its recorded body, operation named in the journal", async () => {
    const api = new JunctionAPI()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...Object.keys(ORDER_NOT_FOUND)),
        fc.uuid({ version: 4 }),
        async (operationId, id) => {
          const req = requestFor(operationId, id)
          const res = await call(
            api,
            req.method,
            req.path,
            req.body !== undefined ? { body: req.body } : {},
          )
          expect(res.status).toBe(404)
          expect(res.body).toEqual({ detail: ORDER_NOT_FOUND[operationId] })
          expect(res.headers.get(MISS_HEADER)).toBe(`order ${id}`)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 60 },
    )
  }, 30_000)

  test("verify compares each unknown-order 404 exactly", async () => {
    const runtime = createRuntime()
    const seen: string[] = []
    const report = await verifyAgainstReal({
      realKey: "sk_us_fake",
      mock: runtime,
      corpus: {
        version: 2,
        recordedAt: "2026-09-20T00:00:00.000Z",
        source: "test",
        observations: {},
        catalog: { labTests: [], labs: [], expectedResults: {} },
        labAccounts: [],
      },
      skipDrift: true,
      minIntervalMs: 0,
      // The "real" side is the mock too, so only the steps' coverage is under test here.
      fetch: (request) => {
        seen.push(`${request.method} ${new URL(request.url).pathname}`)
        return runtime.fetch(request)
      },
    })
    expect(report.divergences.filter((d) => d.check.startsWith("unknown order 404"))).toEqual([])
    expect(seen.filter((line) => /\/v3\/order\/[0-9a-f-]{36}/.test(line)).length).toBe(
      Object.keys(ORDER_NOT_FOUND).length,
    )
  })
})
