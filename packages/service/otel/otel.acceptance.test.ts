import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, DEFAULT_ORGANIZATIONS, OTEL_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  buildBloodworkOpsO2Sql,
  countErrors,
  createO2Client,
  type Fetch,
  HOP_PAGE_SIZE,
  hopFromOpenObserveHit,
  type LogInput,
  logsExport,
  O2_RECIPES,
  OpenObserveBloodworkClient,
  searchAllHopHits,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const HOST = "http://otel.mock"
const INGEST_TOKEN = "otel-ingest-token"
const O2_AUTH = btoa("agent@gogeviti.com:o2-password")
const DEV_ORG = DEFAULT_ORGANIZATIONS.find((o) => o.name === "development")?.identifier as string
const PROD_ORG = DEFAULT_ORGANIZATIONS.find((o) => o.name === "production")?.identifier as string

const BACKEND = {
  "service.name": "backend",
  "service.version": "3f2c9ab",
  "deployment.environment.name": "local",
}

const harness = (settings: Parameters<typeof createRuntime>[0] = {}) => {
  const runtime = createRuntime(settings)
  const fetchImpl: Fetch = (input, init) => runtime.fetch(new Request(input, init))
  const exportLogs = async (logs: LogInput[], resource: Record<string, string> = BACKEND) =>
    fetchImpl(`${HOST}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify(logsExport(resource, logs)),
    })
  const admin = async (path: string, body?: unknown) =>
    runtime.fetch(
      new Request(`${HOST}/__admin${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const bloodwork = new OpenObserveBloodworkClient({ baseUrl: HOST, auth: O2_AUTH, fetchImpl })
  const agent = createO2Client({ basicAuth: O2_AUTH, baseUrl: HOST, fetchImpl })
  return { runtime, fetchImpl, exportLogs, admin, bloodwork, agent }
}

const hourAgo = () => Date.now() - 3_600_000

describe("S18.2 receiver", () => {
  test("JSON logs and traces answer {partialSuccess:{}}; a missing bearer token is 401", async () => {
    const { fetchImpl, exportLogs } = harness()
    const logs = await exportLogs([{ event: "initial_credit_reconcile_completed" }])
    expect(logs.status).toBe(200)
    expect(await logs.json()).toEqual({ partialSuccess: {} })
    const traces = await fetchImpl(`${HOST}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({ resourceSpans: [] }),
    })
    expect(await traces.json()).toEqual({ partialSuccess: {} })
    const anonymous = await fetchImpl(`${HOST}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(logsExport(BACKEND, [{ event: "x" }])),
    })
    expect(anonymous.status).toBe(401)
    const wrongType = await fetchImpl(`${HOST}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${INGEST_TOKEN}` },
      body: "hello",
    })
    expect(wrongType.status).toBe(415)
  })

  test("only the configured OTEL_AUTH_TOKEN is accepted once one is set", async () => {
    const { fetchImpl } = harness({ settings: { ingestTokens: [INGEST_TOKEN] } })
    const post = (token: string) =>
      fetchImpl(`${HOST}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(logsExport(BACKEND, [{ event: "x" }])),
      })
    expect((await post("wrong")).status).toBe(401)
    expect((await post(INGEST_TOKEN)).status).toBe(200)
  })

  test("resource attributes are flattened with the service_ prefix; attributes lowercased", async () => {
    const { exportLogs, admin } = harness()
    await exportLogs([
      {
        event: "bloodwork_entitlement_granted",
        attributes: { clientUserId: 9, "http.status_code": 200, granted: true },
      },
    ])
    const { logs } = (await (await admin("/logs?event=bloodwork_entitlement_granted")).json()) as {
      logs: Record<string, unknown>[]
    }
    expect(logs[0]).toMatchObject({
      _org: DEV_ORG,
      _stream: "default",
      service_name: "backend",
      service_service_version: "3f2c9ab",
      service_deployment_environment_name: "local",
      event: "bloodwork_entitlement_granted",
      clientuserid: 9,
      http_status_code: 200,
      granted: true,
      severity_text: "info",
    })
  })

  test("log bodies are never stored unless keepBodies; the journal holds no bodies", async () => {
    const plain = harness()
    await plain.exportLogs([{ event: "chat_turn", body: "prompt: my potassium is 7.1" }])
    const stored = JSON.stringify(plain.runtime.instance().logs())
    expect(stored).not.toContain("potassium")
    const journal = JSON.stringify(await (await plain.admin("/requests")).json())
    expect(journal).not.toContain("potassium")
    const debug = harness({ settings: { keepBodies: true } })
    await debug.exportLogs([{ event: "chat_turn", body: "local debugging body" }])
    expect(debug.runtime.instance().logs()[0]?.row.body).toBe("local debugging body")
  })

  test("production exports land in the production org; everything else in development", async () => {
    const { exportLogs, runtime } = harness()
    await exportLogs([{ event: "a" }], { ...BACKEND, "deployment.environment.name": "production" })
    await exportLogs([{ event: "b" }])
    expect(
      runtime
        .instance()
        .logs()
        .map((l) => [l.row.event, l.org]),
    ).toEqual([
      ["a", PROD_ORG],
      ["b", DEV_ORG],
    ])
  })

  test("metrics are accepted and counted, never stored", async () => {
    const { fetchImpl, admin, runtime } = harness()
    const response = await fetchImpl(`${HOST}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({
        resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "a" }, { name: "b" }] }] }],
      }),
    })
    expect(await response.json()).toEqual({ partialSuccess: {} })
    expect(await (await admin("/otlp-metrics")).json()).toMatchObject({ requests: 1, metrics: 2 })
    expect(runtime.instance().logs()).toEqual([])
  })

  test("gzip-compressed exports are inflated", async () => {
    const { fetchImpl, runtime } = harness()
    const body = Bun.gzipSync(
      new TextEncoder().encode(JSON.stringify(logsExport(BACKEND, [{ event: "zipped" }]))),
    )
    const response = await fetchImpl(`${HOST}/v1/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        authorization: `Bearer ${INGEST_TOKEN}`,
      },
      body,
    })
    expect(response.status).toBe(200)
    expect(runtime.instance().logs()[0]?.row.event).toBe("zipped")
  })

  test("retry presets answer 429 (retry-after), 502, 503, 504; 500 and 401 are the drop path", async () => {
    const expected: Record<string, number> = {
      rate_limited: 429,
      bad_gateway: 502,
      unavailable: 503,
      gateway_timeout: 504,
      server_error: 500,
      unauthorized: 401,
    }
    for (const [preset, status] of Object.entries(expected)) {
      const { runtime, exportLogs } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      const failed = await exportLogs([{ event: "x" }])
      expect(failed.status).toBe(status)
      if (status === 429) expect(failed.headers.get("retry-after")).toBe("1")
      expect((await exportLogs([{ event: "x" }])).status).toBe(200)
      expect(runtime.instance().logs()).toHaveLength(1)
    }
  })

  test("partial_success rejects the batch with a count and stores nothing", async () => {
    const { runtime, exportLogs } = harness()
    runtime.applyPreset("partial_success", "default", { count: 1 })
    const response = await exportLogs([{ event: "a" }, { event: "b" }])
    expect(await response.json()).toMatchObject({ partialSuccess: { rejectedLogRecords: "2" } })
    expect(runtime.instance().logs()).toEqual([])
  })
})

describe("S18.3 O2 search through the backend bloodwork-ops client", () => {
  const seed = async (h: ReturnType<typeof harness>) => {
    await h.exportLogs([
      {
        event: "junction_order_placed",
        attributes: { clientUserId: 9, vitalOrderId: "ord_1", labSlug: "quest" },
        timeMs: Date.now() - 60_000,
      },
      {
        event: "junction_order_failed",
        severityText: "ERROR",
        severityNumber: 17,
        attributes: {
          clientUserId: 9,
          code: "vendor_rejected",
          statusCode: 422,
          vendorCategory: "4xx",
        },
        timeMs: Date.now() - 30_000,
      },
      {
        event: "bloodwork_entitlement_granted",
        attributes: { clientUserId: 12, entitlementId: "44" },
        timeMs: Date.now() - 10_000,
      },
      { attributes: { note: "no event field" } },
    ])
  }

  test("identifier lookup, schema fields, and the hop SQL return the right hits newest first", async () => {
    const h = harness()
    await seed(h)
    expect(await h.bloodwork.resolveOrgIdentifier("development")).toBe(DEV_ORG)
    const fields = await h.bloodwork.streamFields("development")
    expect(fields?.has("clientuserid")).toBe(true)
    expect(fields?.has("vitalorderid")).toBe(true)
    // Never ingested: dropped from the query instead of failing it with 400.
    expect(fields?.has("labresultid")).toBe(false)
    const sql = buildBloodworkOpsO2Sql(
      {
        vitalOrderIds: ["ord_1"],
        labResultIds: ["lr-1"],
        entitlementIds: [],
        orderIds: [],
        clientUserIds: ["9"],
      },
      fields,
    ) as string
    expect(sql).toBe(
      `SELECT * FROM "default" WHERE event IS NOT NULL AND (vitalorderid IN ('ord_1') OR clientuserid IN ('9')) ORDER BY _timestamp DESC`,
    )
    const { hits, truncated, pages } = await searchAllHopHits(h.bloodwork, {
      org: "development",
      sql,
      startMs: hourAgo(),
      endMs: Date.now(),
    })
    expect(truncated).toBe(false)
    expect(pages).toBe(1)
    const hops = hits.map(hopFromOpenObserveHit)
    expect(hops.map((hop) => hop?.event)).toEqual([
      "junction_order_failed",
      "junction_order_placed",
    ])
    expect(hops[0]?.severity).toBe("error")
    expect(hops[0]?.correlation).toMatchObject({
      clientUserId: 9,
      code: "vendor_rejected",
      statusCode: 422,
    })
    expect(hops[1]?.correlation).toMatchObject({ vitalOrderId: "ord_1", labSlug: "quest" })
  })

  test("an unknown field is a 400 (camelCase columns, never-ingested columns)", async () => {
    const h = harness()
    await seed(h)
    const camel = await h.agent.search({
      org: "development",
      sql: `SELECT * FROM "default" WHERE clientUserId = '9'`,
      sinceMs: 3_600_000,
    })
    expect(camel).toMatchObject({ ok: false, status: 400 })
    expect((camel as { error: string }).error).toContain("No field named clientUserId")
    // Without the schema filter, the ops feed's hop query 400s on labresultid and the client throws.
    const unfiltered = buildBloodworkOpsO2Sql({
      vitalOrderIds: ["ord_1"],
      labResultIds: ["lr-1"],
      entitlementIds: [],
      orderIds: [],
    }) as string
    await expect(
      h.bloodwork.searchSql({
        org: "development",
        sql: unfiltered,
        startMs: hourAgo(),
        endMs: Date.now(),
      }),
    ).rejects.toThrow("openobserve HTTP 400")
  })

  test("LIMIT/from paging: 2 500 hops come back in three pages of 1 000", async () => {
    const h = harness()
    const now = Date.now()
    const logs: LogInput[] = Array.from({ length: 2_500 }, (_, i) => ({
      event: "bloodwork_reconcile_decision",
      attributes: { clientUserId: 7, attempt: i },
      timeMs: now - 1_000 - i,
    }))
    for (let i = 0; i < logs.length; i += 500) await h.exportLogs(logs.slice(i, i + 500))
    const sql = buildBloodworkOpsO2Sql({
      vitalOrderIds: [],
      labResultIds: [],
      entitlementIds: [],
      orderIds: [],
      clientUserIds: ["7"],
    }) as string
    const result = await searchAllHopHits(h.bloodwork, {
      org: "development",
      sql,
      startMs: now - 3_600_000,
      endMs: now,
    })
    expect(HOP_PAGE_SIZE).toBe(1_000)
    expect(result.pages).toBe(3)
    expect(result.truncated).toBe(false)
    expect(result.hits).toHaveLength(2_500)
    // Newest first: attempt 0 was emitted latest.
    expect(result.hits[0]?.attempt).toBe(0)
    expect(result.hits.at(-1)?.attempt).toBe(2_499)
    // A SQL LIMIT caps the hits before paging.
    const limited = await h.bloodwork.searchSql({
      org: "development",
      sql: `${sql} LIMIT 5`,
      startMs: now - 3_600_000,
      endMs: now,
      size: 1_000,
    })
    expect(limited.map((hit) => hit.attempt)).toEqual([0, 1, 2, 3, 4])
  })

  test("more than 10 pages is truncated at 10", async () => {
    const h = harness()
    const now = Date.now()
    await h.exportLogs(
      Array.from({ length: 25 }, (_, i) => ({
        event: "e",
        attributes: { orderId: "1", i },
        timeMs: now - 100 - i,
      })),
    )
    const result = await searchAllHopHits(
      h.bloodwork,
      {
        org: "development",
        sql: `SELECT * FROM "default" WHERE event IS NOT NULL AND (orderid IN ('1')) ORDER BY _timestamp DESC`,
        startMs: now - 60_000,
        endMs: now,
      },
      2,
    )
    expect(result).toMatchObject({ truncated: true, pages: 10 })
    expect(result.hits).toHaveLength(20)
  })

  test("the time window bounds the hits (start_time/end_time in µs)", async () => {
    const h = harness()
    const now = Date.now()
    await h.exportLogs([
      { event: "old", attributes: { orderId: "1" }, timeMs: now - 7_200_000 },
      { event: "new", attributes: { orderId: "1" }, timeMs: now - 1_000 },
    ])
    const hits = await h.bloodwork.searchSql({
      org: "development",
      sql: `SELECT * FROM "default" WHERE orderid = '1'`,
      startMs: hourAgo(),
      endMs: now,
    })
    expect(hits.map((hit) => hit.event)).toEqual(["new"])
  })
})

describe("S18.3 O2 search through agent-investigate recipes", () => {
  test("errors-recent, logs-for-trace, errors-after-version filter on severity_text, trace_id, version", async () => {
    const h = harness()
    const trace = "0af7651916cd43dd8448eb211c80319c"
    await h.exportLogs([
      {
        event: "a",
        severityText: "ERROR",
        traceId: trace,
        spanId: "b7ad6b7169203331",
        body: "boom",
        timeMs: Date.now() - 3_000,
      },
      {
        event: "b",
        severityText: "INFO",
        traceId: trace,
        spanId: "b7ad6b7169203332",
        timeMs: Date.now() - 2_000,
      },
      { event: "c", severityText: "FATAL", timeMs: Date.now() - 1_000 },
    ])
    await h.exportLogs([{ event: "noise", severityText: "ERROR" }], {
      "service.name": "claude-code",
      "deployment.environment.name": "local",
    })
    const recent = await h.agent.search({
      org: "development",
      sql: O2_RECIPES["errors-recent"](),
      sinceMs: 3_600_000,
    })
    expect(recent.ok && recent.rows.map((r) => r.severity_text)).toEqual(["FATAL", "ERROR"])
    // Bodies are not stored: the selected column is simply absent from each hit.
    expect(recent.ok && recent.rows.every((r) => !("body" in r))).toBe(true)

    const byTrace = await h.agent.search({
      org: "development",
      sql: O2_RECIPES["logs-for-trace"]({ traceId: trace }),
      sinceMs: 3_600_000,
    })
    expect(byTrace.ok && byTrace.rows.map((r) => r.span_id)).toEqual([
      "b7ad6b7169203331",
      "b7ad6b7169203332",
    ])

    const byVersion = await h.agent.search({
      org: "development",
      sql: O2_RECIPES["errors-after-version"]({ version: "3f2c9ab" }),
      sinceMs: 3_600_000,
    })
    expect(byVersion.ok && byVersion.rowCount).toBe(2)
  })

  test("bloodwork-errors, junction-order-failures (GROUP BY/COUNT) and junction-member-timeline", async () => {
    const h = harness()
    const now = Date.now()
    await h.exportLogs([
      {
        event: "junction_order_failed",
        severityText: "ERROR",
        // Every recipe column must exist in the schema, trace_id included (else 400).
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        attributes: {
          clientUserId: 9,
          code: "vendor_rejected",
          statusCode: 422,
          vendorCategory: "4xx",
          path: "p",
          reason: "r",
          attempt: 1,
          trigger: "t",
          reconcileRunId: "run",
          vitalOrderId: "v",
          labResultId: "l",
          orderId: "o",
        },
        timeMs: now - 3_000,
      },
      {
        event: "junction_order_failed",
        severityText: "ERROR",
        attributes: {
          clientUserId: 9,
          code: "vendor_rejected",
          statusCode: 422,
          vendorCategory: "4xx",
        },
        timeMs: now - 2_000,
      },
      {
        event: "junction_order_failed",
        severityText: "ERROR",
        attributes: { clientUserId: 12, code: "timeout", statusCode: 504, vendorCategory: "5xx" },
        timeMs: now - 1_000,
      },
      { event: "junction_order_placed", attributes: { clientUserId: 9 }, timeMs: now - 500 },
    ])
    const errors = await h.agent.search({
      org: "development",
      sql: O2_RECIPES["bloodwork-errors"](),
      sinceMs: 3_600_000,
    })
    expect(errors.ok && errors.rowCount).toBe(3)

    const failures = await h.agent.search({
      org: "development",
      sql: O2_RECIPES["junction-order-failures"](),
      sinceMs: 3_600_000,
    })
    expect(failures.ok && failures.rows).toEqual([
      { code: "vendor_rejected", statuscode: 422, vendorcategory: "4xx", clientuserid: 9, n: 2 },
      { code: "timeout", statuscode: 504, vendorcategory: "5xx", clientuserid: 12, n: 1 },
    ])

    const timeline = await h.agent.search({
      org: "development",
      sql: O2_RECIPES["junction-member-timeline"]({ clientUserId: "9" }),
      sinceMs: 3_600_000,
    })
    expect(timeline.ok && timeline.rows.map((r) => r.event)).toEqual([
      "junction_order_failed",
      "junction_order_failed",
      "junction_order_placed",
    ])
  })

  test("errors-by-user needs every column it names: userid never ingested is a 400", async () => {
    const h = harness()
    await h.exportLogs([{ event: "x", severityText: "ERROR", attributes: { clientUserId: 9 } }])
    const missing = await h.agent.search({
      org: "development",
      sql: O2_RECIPES["errors-by-user"]({ userId: "9" }),
      sinceMs: 3_600_000,
    })
    expect(missing).toMatchObject({ ok: false, status: 400 })
    await h.exportLogs([
      {
        event: "y",
        severityText: "ERROR",
        attributes: { userId: 9 },
        body: "user 9",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      },
    ])
    const found = await h.agent.search({
      org: "development",
      sql: O2_RECIPES["errors-by-user"]({ userId: "9" }),
      sinceMs: 3_600_000,
    })
    expect(found.ok && found.rowCount).toBe(2)
  })

  test("streamFields reports the schema, and a malformed stream is a 404 the client surfaces", async () => {
    const h = harness()
    await h.exportLogs([{ event: "x", attributes: { clientUserId: 1 } }])
    const fields = await h.agent.streamFields({ org: "development" })
    expect(fields.ok && [...fields.fields].sort()).toEqual(
      expect.arrayContaining([
        "_timestamp",
        "clientuserid",
        "event",
        "service_name",
        "severity_text",
      ]),
    )
    expect(await h.agent.streamFields({ org: "development", stream: "nope" })).toMatchObject({
      ok: false,
      status: 404,
    })
  })
})

describe("S18.3 auth quirks", () => {
  test("the org display name in the path is a bare 401, like real O2 (release-conductor)", async () => {
    const h = harness()
    await h.exportLogs([{ event: "x", severityText: "ERROR" }], {
      ...BACKEND,
      "deployment.environment.name": "production",
    })
    await expect(
      countErrors({ baseUrl: HOST, auth: O2_AUTH }, hourAgo(), Date.now(), h.fetchImpl),
    ).rejects.toThrow("openobserve HTTP 401")
    const raw = await h.fetchImpl(`${HOST}/api/production/_search`, {
      method: "POST",
      headers: { authorization: `Basic ${O2_AUTH}`, "content-type": "application/json" },
      body: JSON.stringify({ query: { sql: 'SELECT * FROM "default"' } }),
    })
    expect(await raw.text()).toBe("Unauthorized Access")
    // The same query by identifier works: the release-conductor fix.
    const fixed = await h.fetchImpl(`${HOST}/api/${PROD_ORG}/_search`, {
      method: "POST",
      headers: { authorization: `Basic ${O2_AUTH}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: {
          sql: `SELECT service_name, count(*) AS n FROM "default" WHERE severity_text IN ('ERROR','FATAL') GROUP BY service_name`,
        },
      }),
    })
    expect(((await fixed.json()) as { hits: unknown[] }).hits).toEqual([
      { service_name: "backend", n: 1 },
    ])
  })

  test("search needs Basic auth; configured users are enforced", async () => {
    const { fetchImpl } = harness({
      settings: { searchUsers: [{ username: "agent", password: "pw" }] },
    })
    const call = (auth?: string) =>
      fetchImpl(
        `${HOST}/api/organizations`,
        auth ? { headers: { authorization: `Basic ${auth}` } } : {},
      )
    expect((await call()).status).toBe(401)
    expect((await call(btoa("agent:nope"))).status).toBe(401)
    expect((await call(btoa("agent:pw"))).status).toBe(200)
  })

  test("a failed identifier lookup falls back to the display name (and so 401s)", async () => {
    const h = harness({ settings: { searchUsers: [{ username: "agent", password: "pw" }] } })
    const client = new OpenObserveBloodworkClient({
      baseUrl: HOST,
      auth: btoa("agent:wrong"),
      fetchImpl: h.fetchImpl,
    })
    expect(await client.resolveOrgIdentifier("development")).toBe("development")
  })
})

describe("S18.4 admin", () => {
  test("GET /__admin/logs filters by service, event, severity and trace_id; /spans by service and name", async () => {
    const h = harness()
    await h.exportLogs([
      { event: "a", severityText: "ERROR", traceId: "0af7651916cd43dd8448eb211c80319c" },
      { event: "b", severityText: "info" },
    ])
    await h.exportLogs([{ event: "a" }], { "service.name": "emr-backend" })
    const read = async (query: string) =>
      ((await (await h.admin(`/logs${query}`)).json()) as { logs: Record<string, unknown>[] }).logs
    expect(await read("?service=backend")).toHaveLength(2)
    expect(await read("?event=a")).toHaveLength(2)
    expect(await read("?severity=error")).toHaveLength(1)
    expect(await read("?trace_id=0af7651916cd43dd8448eb211c80319c&service=backend")).toHaveLength(1)
    await h.fetchImpl(`${HOST}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "backend" } }] },
            scopeSpans: [
              {
                scope: { name: "@geviti/telemetry" },
                spans: [
                  {
                    traceId: "0af7651916cd43dd8448eb211c80319c",
                    spanId: "b7ad6b7169203331",
                    name: "reconcile.run",
                    kind: 1,
                    startTimeUnixNano: "1700000000000000000",
                    endTimeUnixNano: "1700000000250000000",
                    attributes: [
                      { key: "geviti.reconcile_run_id", value: { stringValue: "run-1" } },
                    ],
                    status: { code: 2, message: "boom" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })
    const spans = (
      (await (await h.admin("/spans?service=backend&name=reconcile.run")).json()) as {
        spans: Record<string, unknown>[]
      }
    ).spans
    expect(spans[0]).toMatchObject({
      operation_name: "reconcile.run",
      trace_id: "0af7651916cd43dd8448eb211c80319c",
      duration: 250_000,
      span_status: "ERROR",
      geviti_reconcile_run_id: "run-1",
      _timestamp: 1_700_000_000_000_000,
    })
  })

  test("POST /__admin/wait long-polls until the event arrives, and 408s on timeout", async () => {
    const h = harness()
    const waiting = h.admin("/wait", {
      kind: "log",
      where: { event: "initial_credit_reconcile_completed", granted: 1 },
      count: 1,
      timeoutMs: 5_000,
    })
    setTimeout(() => {
      void h.exportLogs([
        { event: "initial_credit_reconcile_completed", attributes: { granted: 1 } },
      ])
    }, 50)
    const done = await waiting
    expect(done.status).toBe(200)
    const body = (await done.json()) as { matched: Record<string, unknown>[] }
    expect(body.matched[0]).toMatchObject({
      event: "initial_credit_reconcile_completed",
      granted: 1,
    })
    const timeout = await h.admin("/wait", {
      kind: "log",
      where: { event: "never" },
      timeoutMs: 60,
    })
    expect(timeout.status).toBe(408)
    // `where` keys may be spelt as the emitter wrote them.
    await h.exportLogs([{ event: "keyed", attributes: { clientUserId: 5 } }])
    const camel = await h.admin("/wait", { where: { clientUserId: 5 }, timeoutMs: 0 })
    expect(camel.status).toBe(200)
  })

  test("namespaces by ingest token and by O2 username meet in one worker's store", async () => {
    const { runtime, fetchImpl } = harness()
    await runtime.fetch(
      new Request(`${HOST}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "worker-a-token": "a", "worker-a": "a" } }),
      }),
    )
    await fetchImpl(`${HOST}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer worker-a-token" },
      body: JSON.stringify(
        logsExport(BACKEND, [{ event: "only_in_a", attributes: { orderId: "1" } }]),
      ),
    })
    const agentA = createO2Client({ basicAuth: btoa("worker-a:x"), baseUrl: HOST, fetchImpl })
    const agentB = createO2Client({ basicAuth: btoa("worker-b:x"), baseUrl: HOST, fetchImpl })
    const sql = `SELECT * FROM "default" WHERE event = 'only_in_a'`
    const a = await agentA.search({ org: "development", sql, sinceMs: 3_600_000 })
    const b = await agentB.search({ org: "development", sql, sinceMs: 3_600_000 })
    expect(a.ok && a.rowCount).toBe(1)
    expect(b.ok && b.rowCount).toBe(0)
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(OTEL_PRESETS)).toEqual(
      expect.arrayContaining([
        "rate_limited",
        "bad_gateway",
        "unavailable",
        "gateway_timeout",
        "server_error",
      ]),
    )
  })

  test("any emitted event is found by the ops feed's IN query on its correlation id", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z][a-z_]{2,30}$/),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (event, orderId) => {
          const h = harness()
          await h.exportLogs([
            { event, attributes: { orderId } },
            { event: "other", attributes: { orderId: `${orderId}x` } },
          ])
          const sql = buildBloodworkOpsO2Sql({
            vitalOrderIds: [],
            labResultIds: [],
            entitlementIds: [],
            orderIds: [orderId],
          }) as string
          const hits = await h.bloodwork.searchSql({
            org: "development",
            sql,
            startMs: hourAgo(),
            endMs: Date.now(),
          })
          expect(hits.map((hit) => [hit.event, hit.orderid])).toEqual([[event, orderId]])
        },
      ),
      { ...params, numRuns: params.numRuns ?? 25 },
    )
  })
})

describe("served over HTTP", () => {
  test("export then search with plain fetch against the node server", async () => {
    const server = await createServer()
    try {
      const response = await fetch(`${server.url}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` },
        body: JSON.stringify(
          logsExport(BACKEND, [{ event: "served", attributes: { orderId: "9" } }]),
        ),
      })
      expect(response.status).toBe(200)
      const bloodwork = new OpenObserveBloodworkClient({
        baseUrl: server.url,
        auth: O2_AUTH,
        fetchImpl: (input, init) => fetch(input, init),
      })
      const hits = await bloodwork.searchSql({
        org: "development",
        sql: `SELECT * FROM "default" WHERE orderid IN ('9')`,
        startMs: hourAgo(),
        endMs: Date.now(),
      })
      expect(hits.map((hit) => hit.event)).toEqual(["served"])
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^otel@/)
    } finally {
      await server.close()
    }
  })
})
