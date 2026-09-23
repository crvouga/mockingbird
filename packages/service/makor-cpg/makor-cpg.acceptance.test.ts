import { describe, expect, test } from "bun:test"
import { createRuntime, MAKOR_CPG_PRESETS, NO_CARE_PLAN_MESSAGE } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  CpgApi,
  generateReviewScript,
  generateUserSummary,
  getLatestUserSummary,
  getReviewByLabTest,
  handleGenerate,
  MakorAiClient,
  regenerateReviewScript,
} from "./test/consumer.js"

const HOST = "http://makor-cpg.mock"
const KEY = "mk-test-key"

const harness = (options: Parameters<typeof createRuntime>[0] = {}) => {
  const runtime = createRuntime(options)
  const send = (request: Request) => runtime.fetch(request)
  const backend = new MakorAiClient({ url: HOST, apiKey: KEY }, send)
  const emr = new CpgApi(HOST, KEY, send)
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "PUT") =>
    runtime.fetch(
      new Request(`${HOST}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, backend, emr, admin, send }
}

const order = (n: number) => ({
  carePlanId: "cp_1652",
  invoiceId: `in_${n}`,
  wholeScriptsOrderId: `WS-${n}`,
  submitSuccess: true,
  orderDate: "2026-09-01",
  status: "Complete",
  tracking: [{ number: `1Z${n}`, link: "https://ups.example/track", carrier: "UPS" }],
  shipMethod: "STANDARD",
  supplements: [{ sku: "MAG-200", quantity: 1, itemTime: "PM", name: "Magnesium" }],
  billingCycle: n,
  needsPolling: false,
  lastPolled: "2026-09-02T00:00:00.000Z",
  pricingSnapshot: {
    context: { currency: "usd", plusUser: false, computedAt: "2026-09-01", memberState: "TX" },
    pricing: {},
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  activeCarePlan: true,
})

describe("S15 acceptance: the backend MakorAiClientService against the mock", () => {
  test("a 404 'no care plan' is the normal answer: null, logged at warn (not error)", async () => {
    const { backend } = harness()
    expect(await backend.getCurrentCarePlan(1652)).toBeNull()
    expect(backend.logs.map((l) => l.level)).toEqual(["warn", "warn"])
    expect(backend.logs[0]?.message).toContain(`-> 404`)
    expect(backend.logs[0]?.message).toContain(NO_CARE_PLAN_MESSAGE)
  })

  test("a seeded care plan passes the backend's schema; plus-user toggles it", async () => {
    const { backend, admin } = harness()
    await admin("/care-plans/1652", {
      status: "Approved",
      state: "CA",
      pricing: { discount_percent: 10, discount_type: "plus" },
    })
    const plan = await backend.getCurrentCarePlan(1652)
    expect(plan).toMatchObject({
      carePlanId: "cp_1652",
      status: "Approved",
      state: "CA",
      pricing: { subtotal_cents: 18_900, discount_percent: 10, discount_type: "plus" },
    })
    expect(await backend.updatePlusUser(1652, true)).toMatchObject({ success: true })
    expect(
      ((await (await admin("/care-plans/1652")).json()) as { plusUser: boolean }).plusUser,
    ).toBe(true)
    // No plan: the PATCH is a warn-level 404 and returns null.
    expect(await backend.updatePlusUser(7, true)).toBeNull()
  })

  test("bloodwork webhook: 202 is success; anything else warns and returns null", async () => {
    const { backend, admin, runtime } = harness()
    expect(await backend.postMakorAiBloodworkResultsReceived(1652, "lab_res_1")).toEqual({
      success: true,
      message: "Webhook received and processed successfully",
    })
    const received = (await (await admin("/bloodwork")).json()) as {
      webhooks: { userId: string; labResultsId: string }[]
    }
    expect(received.webhooks).toEqual([
      expect.objectContaining({ userId: "1652", labResultsId: "lab_res_1" }),
    ])
    runtime.applyPreset("bloodwork_not_accepted", "default", { count: 1 })
    expect(await backend.postMakorAiBloodworkResultsReceived(1652, "lab_res_2")).toBeNull()
    expect(backend.logs.at(-1)?.level).toBe("warn")
  })

  test("subscription status and cancel (no live callers: cheap but schema-valid)", async () => {
    const { backend, admin } = harness()
    expect(await backend.getSubscriptionStatus(1652)).toEqual({
      success: true,
      data: { hasActiveSubscription: false, message: "No active subscription found for this user" },
    })
    expect(await backend.cancelSubscription(1652)).toMatchObject({
      success: true,
      data: { success: false },
    })
    await admin("/subscriptions/1652", { status: "active" })
    expect(await backend.getSubscriptionStatus(1652)).toMatchObject({
      success: true,
      data: { user_id: "1652", status: "active" },
    })
    expect(await backend.cancelSubscription(1652)).toEqual({
      success: true,
      data: {
        subscription_id: "sub_mock_1652",
        status: "canceled",
        message: "Subscription cancelled",
      },
    })
    expect(await backend.cancelSubscription(1652)).toMatchObject({
      data: { alreadyCancelled: true },
    })
    expect(await backend.getSubscriptionStatus(1652)).toMatchObject({
      data: { hasActiveSubscription: false },
    })
  })

  test("Wholescripts order history pages with page/count", async () => {
    const { backend, admin } = harness()
    expect(await backend.getOrderHistory(1652)).toEqual({
      data: [],
      page: 1,
      count: 10,
      total: 0,
      totalPages: 0,
    })
    await admin("/wholescripts-orders/1652", [order(1), order(2), order(3)])
    const page = await backend.getOrderHistory(1652, { page: 2, count: 2 })
    expect(page).toMatchObject({ page: 2, count: 2, total: 3, totalPages: 2 })
    const rows = (page?.data ?? []) as { wholeScriptsOrderId: string }[]
    expect(rows.map((o) => o.wholeScriptsOrderId)).toEqual(["WS-3"])
  })

  test("presets: invalid care-plan shape, wrong route (error-level 404), unauthorized, server error", async () => {
    const a = harness()
    await a.admin("/care-plans/1", {})
    a.runtime.applyPreset("care_plan_invalid_shape", "default", { count: 1 })
    expect(await a.backend.getCurrentCarePlan(1)).toBeNull()
    expect(a.backend.logs[0]).toEqual({
      level: "error",
      message:
        "Invalid response format from Makor AI API: /api/care-plans/current-care-plan-details/1",
    })

    const b = harness()
    b.runtime.applyPreset("route_missing", "default", { count: 1 })
    expect(await b.backend.getCurrentCarePlan(1)).toBeNull()
    expect(b.backend.logs[0]?.level).toBe("error")

    const c = harness()
    c.runtime.applyPreset("unauthorized")
    expect(await c.backend.getCurrentCarePlan(1)).toBeNull()
    expect(c.backend.logs[0]?.message).toContain("-> 401")
    expect(c.backend.logs[0]?.level).toBe("warn")

    const d = harness()
    d.runtime.applyPreset("server_error")
    expect(await d.backend.getCurrentCarePlan(1)).toBeNull()
    expect(d.backend.logs[0]?.level).toBe("error")
  })

  test("x-api-key auth: missing or unknown key is 401; the key maps to a namespace", async () => {
    const { admin, send } = harness()
    const noKey = await send(new Request(`${HOST}/api/subscription/status/1`))
    expect(noKey.status).toBe(401)
    await admin("/settings", { apiKeys: ["mk-right"] })
    const wrong = new MakorAiClient({ url: HOST, apiKey: "mk-wrong" }, send)
    expect(await wrong.getSubscriptionStatus(1)).toBeNull()
    expect(wrong.logs[0]?.message).toContain("Invalid API key")
    await admin("/settings", { apiKeys: [] })

    await admin("/credentials", { credentials: { "mk-worker-a": "a", "mk-worker-b": "b" } })
    await admin("/care-plans/1652?namespace=a", {})
    const a = new MakorAiClient({ url: HOST, apiKey: "mk-worker-a" }, send)
    const b = new MakorAiClient({ url: HOST, apiKey: "mk-worker-b" }, send)
    expect(await a.getCurrentCarePlan(1652)).not.toBeNull()
    expect(await b.getCurrentCarePlan(1652)).toBeNull()
  })
})

describe("S15 acceptance: the EMR frontend (browser-direct) against the mock", () => {
  test("generate-user-summary returns at once; the stored summary is then the most recent", async () => {
    const { emr, runtime } = harness()
    expect(await getLatestUserSummary(emr, "cpg-42")).toBeNull()
    expect(emr.consoleErrors).toEqual([]) // 404 is suppressed, not logged
    const started = performance.now()
    const summary = await generateUserSummary(emr, {
      user_id: "cpg-42",
      intake_forms: [{ title: "Intake", content: "Patient reports fatigue." }],
      free_text_entries: [{ entry_id: "n1", text: "Visit note text." }],
    })
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(summary.user_id).toBe("cpg-42")
    expect(summary.summary.general_summary[0]).toContain("1 intake form(s) and 1 visit note(s)")
    // Nothing the caller sent is echoed back.
    expect(JSON.stringify(summary)).not.toContain("fatigue")
    const latest = await getLatestUserSummary(emr, "cpg-42")
    expect(latest).toMatchObject({ cpgUserId: "cpg-42", isMostRecent: true, summary })
    expect(Date.parse(latest?.createdAt ?? "")).toBeLessThanOrEqual(runtime.clock.now())
  })

  test("summary fixtures via admin; seeded summaries; generation failure", async () => {
    const { emr, admin, runtime } = harness()
    const fixture = {
      userId: "cpg-7",
      summary: {
        general_summary: ["Fixture paragraph."],
        past_visits: ["Visit 1"],
        intake_summary: [],
      },
      biomarker_analysis: { trends: {}, tests_analyzed: 2, all_tests_analysis: [] },
    }
    expect((await admin("/fixtures/summary", fixture)).status).toBe(200)
    const generated = await generateUserSummary(emr, { user_id: "cpg-7" })
    expect(generated).toEqual({
      user_id: "cpg-7",
      summary: fixture.summary,
      biomarker_analysis: fixture.biomarker_analysis,
    })
    await admin("/summaries", { cpgUserId: "cpg-8", createdAt: "2026-01-01T00:00:00.000Z" }, "POST")
    expect((await getLatestUserSummary(emr, "cpg-8"))?.createdAt).toBe("2026-01-01T00:00:00.000Z")
    runtime.applyPreset("generation_failed", "default", { count: 1 })
    await expect(generateUserSummary(emr, { user_id: "cpg-9" })).rejects.toMatchObject({
      response: { status: 500 },
    })
  })

  test("review script: 404 means none; generate returns at once and moves processing → complete on the mock clock", async () => {
    const { emr, admin, runtime } = harness()
    runtime.clock.freeze()
    expect(await getReviewByLabTest(emr, "1652", "lab_a")).toBeNull()
    await admin("/settings", { processingMs: 45_000 })
    const accepted = await generateReviewScript(emr, "1652", "lab_a", {
      intakeForm: "private intake text",
      chartingNotes: [{ content: "private chart note" }],
      demographics: { first_name: "Ada", age: 40, state: "TX" },
    })
    expect(accepted).toMatchObject({
      status: "processing",
      reviewType: "initial",
      scriptContent: null,
    })
    // The panel tells the clinician to come back.
    await admin("/settings", { processingMs: 45_000 })
    expect((await handleGenerate(emr, "1652", "lab_b")).error).toBe(
      "Review generation is still processing. Please try again shortly.",
    )
    expect((await getReviewByLabTest(emr, "1652", "lab_a"))?.status).toBe("processing")
    runtime.clock.advance(44_999)
    expect((await getReviewByLabTest(emr, "1652", "lab_a"))?.status).toBe("processing")
    runtime.clock.advance(1)
    const done = await getReviewByLabTest(emr, "1652", "lab_a")
    expect(done?.status).toBe("complete")
    expect(done?.scriptContent).toMatchObject({
      labFindings: {
        thyroid: expect.any(Array),
        stressAdrenal: expect.any(Array),
        metabolicBloodSugar: expect.any(Array),
        inflammationImmune: expect.any(Array),
        nutrientStatus: expect.any(Array),
      },
      nutritionRecommendations: expect.any(Array),
      fiberGuidance: { included: true, categories: expect.any(Array) },
    })
    // The second lab test for the same user is comparative.
    expect((await getReviewByLabTest(emr, "1652", "lab_b"))?.reviewType).toBe("comparative")
    // Inputs are never stored or journaled.
    const everything = JSON.stringify([
      await (await admin("/reviews")).json(),
      await (await admin("/requests")).json(),
    ])
    expect(everything).not.toContain("private")
    expect(everything).not.toContain("Ada")
  })

  test("with processingMs 0 the panel shows the script straight away; regenerate replaces it", async () => {
    const { emr, admin } = harness()
    const fixture = {
      overview: { summary: "Fixture overview", patterns: ["p1"] },
      labFindings: {
        thyroid: [
          {
            marker: "TSH",
            value: "4.9",
            previousValue: "3.1",
            status: "trending_high",
            interpretation: "Rising",
          },
        ],
        stressAdrenal: [],
        metabolicBloodSugar: [],
        inflammationImmune: [],
        nutrientStatus: [],
      },
      symptomsVsLabChanges: [],
      nutritionRecommendations: [],
      fiberGuidance: { included: false, categories: [] },
      supplementRecommendations: [],
      lifestyleRecommendations: [],
      reflectionQuestions: [],
    }
    await admin("/fixtures/review-script", { userId: "1652", scriptContent: fixture })
    const shown = await handleGenerate(emr, "1652", "lab_x")
    expect(shown.error).toBeNull()
    expect(shown.script).toMatchObject({
      status: "complete",
      isMostRecent: true,
      scriptContent: fixture,
    })
    const again = await regenerateReviewScript(emr, "1652", "lab_x")
    expect(again).toMatchObject({ status: "complete", reviewType: "initial" })
    expect((await getReviewByLabTest(emr, "1652", "lab_x"))?.id).toBe(again.reviewId)
    // Regenerating something that was never generated is a 404.
    await expect(regenerateReviewScript(emr, "1652", "lab_never")).rejects.toMatchObject({
      statusCode: 404,
      message: "No review script found for this lab test",
    })
  })

  test("generation_failed: 500 with status failed; the panel shows errorMessage (errorMessage > message > error)", async () => {
    const { emr, runtime } = harness()
    runtime.applyPreset("generation_failed", "default", { count: 1 })
    const panel = await handleGenerate(emr, "1652", "lab_f")
    expect(panel.error).toBe("Review generation failed: upstream model error (mock)")
    expect((await getReviewByLabTest(emr, "1652", "lab_f"))?.status).toBe("failed")
    await expect(generateReviewScript(emr, " ", "lab")).rejects.toThrow("Invalid userId")
  })

  test("CORS: preflight OPTIONS is answered permissively and every response carries allow-origin", async () => {
    const { send, runtime } = harness()
    const preflight = await send(
      new Request(`${HOST}/api/async-review-script/generate`, {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3001",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-api-key",
        },
      }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3001")
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type,x-api-key")
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST")
    // Fault responses, 401s and health also carry it, so the browser sees the real status.
    runtime.applyPreset("server_error", "default", { count: 1 })
    const faulted = await send(
      new Request(`${HOST}/api/v2/user-summary/x`, {
        headers: { origin: "http://emr.local", "x-api-key": KEY },
      }),
    )
    expect(faulted.status).toBe(500)
    expect(faulted.headers.get("access-control-allow-origin")).toBe("http://emr.local")
    const unauth = await send(new Request(`${HOST}/api/v2/user-summary/x`))
    expect(unauth.status).toBe(401)
    expect(unauth.headers.get("access-control-allow-origin")).toBe("*")
    expect(
      (await send(new Request(`${HOST}/health`))).headers.get("access-control-allow-origin"),
    ).toBe("*")
  })
})

describe("served over HTTP", () => {
  test("slow_generation models the 30-50 s latency; the EMR's own timeout turns it into ECONNABORTED", async () => {
    expect(MAKOR_CPG_PRESETS.slow_generation?.rules?.[0]?.latencyMs).toBe(40_000)
    const server = await createServer()
    try {
      server.runtime.applyPreset("slow_generation", "default", { latencyMs: 300, count: 1 })
      // The summary call's own 50 s timeout, scaled down with the latency.
      const emr = new CpgApi(server.url, KEY, (r) => fetch(r))
      const slow = emr.request(
        "POST",
        "/api/v2/generate-user-summary",
        { user_id: "u" },
        undefined,
        50,
      )
      await expect(slow).rejects.toMatchObject({ code: "ECONNABORTED" })
      // Past the preset's count, generation answers at once again.
      expect((await generateUserSummary(emr, { user_id: "u" })).user_id).toBe("u")
    } finally {
      await server.close()
    }
  })

  test("the EMR flow works against the node server, including a real preflight", async () => {
    const server = await createServer({ settings: { processingMs: 0 } })
    try {
      const preflight = await fetch(`${server.url}/api/v2/generate-user-summary`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3001", "access-control-request-method": "POST" },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3001")
      const emr = new CpgApi(server.url, KEY, (r) => fetch(r))
      await generateUserSummary(emr, { user_id: "http-user" })
      expect((await getLatestUserSummary(emr, "http-user"))?.isMostRecent).toBe(true)
      expect((await handleGenerate(emr, "http-user", "lab_http")).script?.status).toBe("complete")
      const backend = new MakorAiClient({ url: server.url, apiKey: KEY }, (r) => fetch(r))
      expect(await backend.postMakorAiBloodworkResultsReceived(1, "lab")).not.toBeNull()
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^makor-cpg@/)
    } finally {
      await server.close()
    }
  })
})
