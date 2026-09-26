import { describe, expect, test } from "bun:test"
import { createRuntime, PRISM_PRESETS, scanResults } from "./src/index.js"
import { createServer } from "./src/server.js"
import { type Fetch, PrismConsumer, type SubjectInput, uploadCapture } from "./test/consumer.js"

const API = "http://prism.mock"
const KEY = "prism-test-key"
const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50])
const subject: SubjectInput = {
  token: "member-token-1",
  sex: "female",
  region: "north_america",
  birthDate: "1990-06-15",
  weight: { value: 150, unit: "lb" },
  height: { value: 66, unit: "in" },
  researchConsent: false,
  termsOfService: { accepted: true, version: "2026-01" },
}

const harness = (apiUrl = API, apiKey = KEY) => {
  const runtime = createRuntime()
  runtime.clock.set(Date.parse("2026-09-20T12:00:00.000Z"))
  runtime.clock.freeze()
  const fetchImpl: Fetch = (input, init) => runtime.fetch(new Request(input, init))
  const prism = new PrismConsumer({ PRISM_API_URL: apiUrl, PRISM_API_KEY: apiKey }, fetchImpl)
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  /** Subject → scan → upload target, as the initiate endpoint does. */
  const start = async (consumer = prism) => {
    await consumer.upsertSubject(subject)
    const scan = await consumer.createScan({
      subjectToken: subject.token,
      devicePlatform: "ios",
      captureMethod: "native",
    })
    if (scan.status !== "ok") throw new Error("createScan failed")
    const target = await consumer.getScanUploadTarget(scan.data.externalId)
    if (target.status !== "ok") throw new Error("upload target failed")
    return { id: scan.data.externalId, url: target.data.url, expiresAt: target.data.expiresAt }
  }
  return { runtime, fetchImpl, prism, admin, start }
}

describe("S25 Prism acceptance: our body-scan adapter against the mock", () => {
  test("without PRISM_API_URL / PRISM_API_KEY every call is unavailable and nothing is sent", async () => {
    const calls: string[] = []
    const prism = new PrismConsumer({}, async (input) => {
      calls.push(input)
      return new Response("{}")
    })
    expect(await prism.upsertSubject(subject)).toEqual({ status: "unavailable" })
    expect(await prism.getScan("x")).toEqual({ status: "unavailable" })
    expect(calls).toEqual([])
    expect(prism.warnings[0]).toEqual({ event: "body_scan.provider_credentials_missing" })
  })

  test("subject upsert, scan, upload, stages, READY, and the completed data our adapter persists", async () => {
    const { prism, start, fetchImpl, admin, runtime } = harness()
    const first = await prism.upsertSubject(subject)
    const again = await prism.upsertSubject({ ...subject, weight: { value: 150, unit: "lb" } })
    expect(first.status).toBe("ok")
    expect(again).toEqual(first)
    const { id, url, expiresAt } = await start()
    expect(Date.parse(expiresAt) - runtime.clock.now()).toBe(15 * 60_000)
    const created = await prism.getScan(id)
    expect(created).toMatchObject({ status: "ok", data: { externalId: id, status: "initiated" } })
    // 150 lb, converted by Prism for unit-system=metric.
    expect(created.status === "ok" && created.data.weightKg).toBeCloseTo(68.04, 2)
    expect(await prism.getScanStageStates(id)).toEqual({ status: "ok", data: [] })
    // Results are not there yet: 404, which our adapter reports as not_found.
    expect(await prism.getCompletedScanData(id)).toEqual({ status: "not_found" })

    expect(await uploadCapture(fetchImpl, url, VIDEO)).toEqual({ type: "upload-complete" })
    expect((await prism.getScan(id)).status === "ok" && (await prism.getScan(id))).toMatchObject({
      data: { status: "processing" },
    })
    const stages = await prism.getScanStageStates(id)
    expect(stages.status === "ok" && stages.data.map((s) => [s.stage, s.status])).toEqual([
      ["captureData", "succeeded"],
      ["body", "started"],
    ])
    expect((await admin(`/scans/${id}/advance`, { to: "READY" })).status).toBe(200)
    const done = await prism.getScanStageStates(id)
    expect(done.status === "ok" && done.data.every((s) => s.status === "succeeded")).toBe(true)
    const scan = await prism.getScan(id)
    expect(scan.status === "ok" && scan.data.status).toBe("complete")

    const completed = await prism.getCompletedScanData(id)
    if (completed.status !== "ok") throw new Error(`expected ok, got ${completed.status}`)
    const record = runtime.instance().scans()[0]
    const expected = scanResults(
      record as never,
      { ...subject, id: "u", createdAt: "", updatedAt: "" },
      runtime.clock.now(),
    )
    expect(completed.data).toMatchObject({
      bodyFatPercentage: expected.bodyfat.bodyfatPercentage,
      leanMass: expected.bodyfat.leanMass,
      fatMass: expected.bodyfat.fatMass,
      waistFit: expected.measurementsMetric.waistFit,
      hipsFit: expected.measurementsMetric.hipsFit,
      bmiPredicted: expected.measurementsMetric.bmiPredicted,
      metabolicAge: expected.healthReport.metabolicAgeReport.metabolicAgeYears,
      chronologicalAgeYears: 36,
      bodyfatMethod: "coco2",
    })
    expect(completed.data.bodyFatPercentage).toBeGreaterThan(20)
    expect(completed.data.assets.map((a) => a.assetType)).toEqual([
      "previewImage",
      "model",
      "canonicalBody",
      "texture",
      "material",
      "stripes",
    ])
    const asset = await fetchImpl(completed.data.assets[0]?.url as string)
    expect(asset.status).toBe(200)
  })

  test("auto-advance walks uploaded scans on the mock clock; failAt fails the scan at that stage", async () => {
    const { prism, start, fetchImpl, admin, runtime } = harness()
    await admin("/settings", { autoAdvance: { afterMs: 10_000 } }, "PUT")
    const a = await start()
    await uploadCapture(fetchImpl, a.url, VIDEO)
    runtime.clock.advance(10_000)
    const mid = await prism.getScanStageStates(a.id)
    expect(mid.status === "ok" && mid.data.map((s) => s.status)).toEqual([
      "succeeded",
      "succeeded",
      "started",
    ])
    runtime.clock.advance(20_000)
    const ready = await prism.getScan(a.id)
    expect(ready.status === "ok" && ready.data.status).toBe("complete")

    await admin("/settings", { autoAdvance: { afterMs: 10_000, failAt: "fittedBody" } }, "PUT")
    const b = await start()
    await uploadCapture(fetchImpl, b.url, VIDEO)
    runtime.clock.advance(60_000)
    const failed = await prism.getScan(b.id)
    expect(failed.status === "ok" && failed.data.status).toBe("failed")
    const stages = await prism.getScanStageStates(b.id)
    expect(
      stages.status === "ok" && stages.data.find((s) => s.stage === "fittedBody")?.status,
    ).toBe("failed")
  })

  test("the presigned upload: expiry, a tampered signature, an empty capture, a second upload URL", async () => {
    const { prism, start, fetchImpl, runtime, admin } = harness()
    const expired = await start()
    runtime.clock.advance(15 * 60_000 + 1)
    expect(await uploadCapture(fetchImpl, expired.url, VIDEO)).toEqual({
      type: "error",
      code: "upload_failed",
      message: "HTTP 403",
    })
    const tampered = await start()
    expect(
      await uploadCapture(
        fetchImpl,
        tampered.url.replace(/signature=[^&]+/, "signature=nope"),
        VIDEO,
      ),
    ).toMatchObject({
      message: "HTTP 403",
    })
    const empty = await start()
    await uploadCapture(fetchImpl, empty.url, new Uint8Array())
    const failed = await prism.getScan(empty.id)
    expect(failed.status === "ok" && failed.data.status).toBe("failed")
    const done = await start()
    await uploadCapture(fetchImpl, done.url, VIDEO)
    // A scan with its capture cannot mint another upload URL (409 → unavailable).
    expect(await prism.getScanUploadTarget(done.id)).toEqual({ status: "unavailable" })
    expect((await admin(`/scans/${done.id}/fail`, {})).status).toBe(200)
  })

  test("presets map onto our adapter's not_found / unavailable outcomes and metabolic-age handling", async () => {
    const outcomes: [string, string][] = [
      ["unauthorized", "unavailable"],
      ["server_error", "unavailable"],
      ["scan_not_found", "not_found"],
      ["schema_drift", "unavailable"],
      ["connection_drop", "unavailable"],
    ]
    for (const [preset, status] of outcomes) {
      const { runtime, prism, start } = harness()
      const { id } = await start()
      runtime.applyPreset(preset, "default", { count: 1 })
      expect((await prism.getScan(id)).status).toBe(status as never)
    }
    const { runtime, prism, start, fetchImpl, admin } = harness()
    const { id, url } = await start()
    await uploadCapture(fetchImpl, url, VIDEO)
    await admin(`/scans/${id}/advance`, { to: "READY" })
    runtime.applyPreset("metabolic_age_missing", "default", { count: 1 })
    const missing = await prism.getCompletedScanData(id)
    expect(missing.status === "ok" && missing.data.metabolicAge).toBeNull()
    runtime.applyPreset("metabolic_age_implausible", "default", { count: 1 })
    const implausible = await prism.getCompletedScanData(id)
    expect(implausible.status === "ok" && implausible.data.metabolicAge).toBe(150)
    expect(prism.warnings.at(-1)).toMatchObject({
      event: "body_scan.metabolic_age_implausible",
      reasons: ["metabolic_age_out_of_range", "age_delta_out_of_range"],
    })
    runtime.applyPreset("upload_forbidden", "default", { count: 1 })
    const next = await start()
    expect((await uploadCapture(fetchImpl, next.url, VIDEO)).type).toBe("error")
    expect(Object.keys(PRISM_PRESETS)).toEqual(
      expect.arrayContaining(["stage_states_slow", "schema_drift"]),
    )
  })

  test("a restricted key is a 401, and unknown users cannot start scans", async () => {
    const { prism, admin } = harness(API, "wrong")
    await admin("/settings", { apiKeys: [KEY] }, "PUT")
    expect(await prism.upsertSubject(subject)).toEqual({ status: "unavailable" })
    const other = harness()
    // A 404 from scan creation is folded into unavailable (toProviderResult).
    expect(
      await other.prism.createScan({ subjectToken: "nobody", devicePlatform: "android" }),
    ).toEqual({
      status: "unavailable",
    })
  })

  test("namespaces by API key, header and /ns/ prefix; presigned URLs keep the namespace", async () => {
    const { runtime, fetchImpl, admin } = harness()
    await admin("/credentials", { credentials: { "key-a": "a", "key-b": "b" } }, "PUT")
    const worker = (key: string, url = API) =>
      new PrismConsumer({ PRISM_API_URL: url, PRISM_API_KEY: key }, fetchImpl)
    const a = worker("key-a")
    await a.upsertSubject(subject)
    const scan = await a.createScan({ subjectToken: subject.token, devicePlatform: "ios" })
    const id = scan.status === "ok" ? scan.data.externalId : ""
    expect((await worker("key-b").getScan(id)).status).toBe("not_found")
    const viaPrefix = worker("any", `${API}/ns/a`)
    expect((await viaPrefix.getScan(id)).status).toBe("ok")
    const target = await viaPrefix.getScanUploadTarget(id)
    const url = target.status === "ok" ? target.data.url : ""
    expect(url).toContain("/ns/a/uploads/")
    expect((await uploadCapture(fetchImpl, url, VIDEO)).type).toBe("upload-complete")
    const viaHeader = await runtime.fetch(
      new Request(`${API}/scans/${id}`, {
        headers: { authorization: "Bearer z", "x-mockingbird-namespace": "a" },
      }),
    )
    expect(((await viaHeader.json()) as { status: string }).status).toBe("PROCESSING")
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/^prism@.*; ns=a$/)
    const journal = await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=a`))
    ).json()
    expect(JSON.stringify(journal)).not.toContain("1990-06-15")
  })
})

describe("served over HTTP", () => {
  test(
    "stage_states_slow: scan-assets past our 5 s timeout is unavailable (a real socket abort)",
    async () => {
      const server = await createServer()
      try {
        const prism = new PrismConsumer({ PRISM_API_URL: server.url, PRISM_API_KEY: KEY }, (i, n) =>
          fetch(i, n),
        )
        await prism.upsertSubject(subject)
        const scan = await prism.createScan({ subjectToken: subject.token, devicePlatform: "ios" })
        const id = scan.status === "ok" ? scan.data.externalId : ""
        server.runtime.applyPreset("stage_states_slow", "default", { count: 1 })
        expect(await prism.getScanStageStates(id)).toEqual({ status: "unavailable" })
        expect(await prism.getScanStageStates(id)).toEqual({ status: "ok", data: [] })
      } finally {
        await server.close()
      }
    },
    { timeout: 20_000 },
  )

  test("the adapter and the capture upload work against the node server; the ticker completes scans", async () => {
    const server = await createServer({ settings: { autoAdvance: { afterMs: 20 } } })
    try {
      const fetchImpl: Fetch = (input, init) => fetch(input, init)
      const prism = new PrismConsumer({ PRISM_API_URL: server.url, PRISM_API_KEY: KEY }, fetchImpl)
      await prism.upsertSubject(subject)
      const scan = await prism.createScan({
        subjectToken: subject.token,
        devicePlatform: "android",
      })
      const id = scan.status === "ok" ? scan.data.externalId : ""
      const target = await prism.getScanUploadTarget(id)
      expect(target.status === "ok" && target.data.url.startsWith(server.url)).toBe(true)
      await uploadCapture(fetchImpl, target.status === "ok" ? target.data.url : "", VIDEO)
      const deadline = Date.now() + 3_000
      let status = ""
      while (status !== "complete" && Date.now() < deadline) {
        const current = await prism.getScan(id)
        status = current.status === "ok" ? current.data.status : ""
        await Bun.sleep(25)
      }
      expect(status).toBe("complete")
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^prism@/)
    } finally {
      await server.close()
    }
  })
})
