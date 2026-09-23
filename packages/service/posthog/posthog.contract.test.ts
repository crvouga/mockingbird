import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { createRuntime, POSTHOG_PRESETS } from "./src/index.js"

const HOST = "http://posthog.mock"

const harness = () => {
  const runtime = createRuntime()
  const call = (path: string, init: RequestInit = {}) =>
    runtime.fetch(new Request(`${HOST}${path}`, init))
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "PUT") =>
    call(`/__admin${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const flagsOf = async (response: Response) =>
    ((await response.json()) as { flags: Record<string, { variant: string | null }> }).flags
  return { runtime, call, post, admin, flagsOf }
}

describe("contract: health, header, routing", () => {
  test("/health is open and every response carries x-mockingbird", async () => {
    const { call, post } = harness()
    const health = await call("/health")
    expect(health.status).toBe(200)
    expect(((await health.json()) as { service: string }).service).toBe("posthog")
    const flags = await post("/flags/?v=2", { token: "phc_x", distinct_id: "1" })
    expect(flags.headers.get("x-mockingbird")).toMatch(/^posthog@.+; ns=default$/)
  })

  test("/flags/ and /flags answer the same route; unknown paths are 404 JSON and counted", async () => {
    const { post, call, admin, flagsOf } = harness()
    await admin("/flags/a", { default: true })
    const withSlash = await flagsOf(await post("/flags/?v=2", { token: "t", distinct_id: "1" }))
    const without = await flagsOf(await post("/flags?v=2", { api_key: "t", distinct_id: "1" }))
    expect(withSlash).toEqual(without)
    const missing = await call("/nope")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ type: "invalid_request", code: "not_found" })
    const metrics = (await (await admin("/metrics")).json()) as { unmatched?: unknown }
    expect(JSON.stringify(metrics)).toContain("/nope")
  })

  test("legacy vs v2 shapes by route and version", async () => {
    const { post, admin } = harness()
    await admin("/flags/a", { default: "b", payload: { x: 1 } })
    const body = { token: "t", distinct_id: "1" }
    const v2 = (await (await post("/flags/?v=2", body)).json()) as Record<string, unknown>
    expect(v2.flags).toMatchObject({
      a: {
        key: "a",
        enabled: true,
        variant: "b",
        reason: { code: "condition_match" },
        metadata: { id: 1, version: 1, payload: '{"x":1}' },
      },
    })
    expect(v2.featureFlags).toBeUndefined()
    const v1 = (await (await post("/flags/", body)).json()) as Record<string, unknown>
    expect(v1).toMatchObject({ featureFlags: { a: "b" }, featureFlagPayloads: { a: '{"x":1}' } })
    const decide4 = (await (await post("/decide/?v=4", body)).json()) as Record<string, unknown>
    expect(decide4.flags).toBeDefined()
  })

  test("errors: no token → 401, no distinct_id → 400, undecodable body → 400", async () => {
    const { post, call } = harness()
    expect((await post("/flags/?v=2", { distinct_id: "1" })).status).toBe(401)
    expect((await post("/flags/?v=2", { token: "t" })).status).toBe(400)
    const garbage = await call("/batch/", {
      method: "POST",
      headers: { "content-encoding": "gzip", "content-type": "application/json" },
      body: new Uint8Array([0x1f, 0x8b, 1, 2, 3]),
    })
    expect(garbage.status).toBe(400)
    expect((await post("/batch/", { batch: [{ event: "x" }] })).status).toBe(401)
    expect((await call("/api/surveys/")).status).toBe(401)
  })

  test("bodies: Content-Encoding gzip, raw gzip text/plain, base64 data= form, bare array", async () => {
    const { call, admin } = harness()
    const json = JSON.stringify({ api_key: "t", batch: [{ event: "gz", distinct_id: "d" }] })
    await call("/batch/", {
      method: "POST",
      headers: { "content-encoding": "gzip", "content-type": "application/json" },
      body: gzipSync(json),
    })
    await call("/e/?compression=gzip-js", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: gzipSync(
        JSON.stringify([{ event: "gzjs", properties: { token: "t", distinct_id: "d" } }]),
      ),
    })
    const b64 = Buffer.from(
      JSON.stringify({ event: "b64", properties: { token: "t", distinct_id: "d" } }),
    ).toString("base64")
    await call("/i/v0/e/?compression=base64", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(b64)}`,
    })
    const events = (await (await admin("/events?distinct_id=d")).json()) as {
      events: { event: string }[]
    }
    expect(events.events.map((e) => e.event)).toEqual(["gz", "gzjs", "b64"])
  })
})

describe("contract: namespaces", () => {
  test("by header, by /ns/<name> prefix, and by token in every carrier", async () => {
    const { call, post, admin } = harness()
    await admin("/credentials", { credentials: { phc_mapped: "mapped", phx_personal: "mapped" } })
    await admin("/flags/k?namespace=mapped", { default: "mapped" })
    await admin("/flags/k?namespace=hdr", { default: "hdr" })
    await admin("/flags/k?namespace=prefixed", { default: "prefixed" })
    await admin("/flags/k", { default: "default" })
    const value = async (response: Response) =>
      ((await response.json()) as { flags: { k?: { variant: string } } }).flags.k?.variant
    expect(await value(await post("/flags/?v=2", { token: "phc_mapped", distinct_id: "1" }))).toBe(
      "mapped",
    )
    expect(await value(await post("/flags?v=2", { api_key: "phc_mapped", distinct_id: "1" }))).toBe(
      "mapped",
    )
    expect(await value(await post("/flags/?v=2", { token: "phc_other", distinct_id: "1" }))).toBe(
      "default",
    )
    expect(
      await value(
        await post(
          "/flags/?v=2",
          { token: "phc_mapped", distinct_id: "1" },
          { "x-mockingbird-namespace": "hdr" },
        ),
      ),
    ).toBe("hdr")
    expect(
      await value(await post("/ns/prefixed/flags/?v=2", { token: "phc_mapped", distinct_id: "1" })),
    ).toBe("prefixed")
    // The /array/{token}/config path, ?token=, a batch's first event, and a personal key.
    expect((await call("/array/phc_mapped/config")).headers.get("x-mockingbird")).toEndWith(
      "ns=mapped",
    )
    expect((await call("/api/surveys/?token=phc_mapped")).headers.get("x-mockingbird")).toEndWith(
      "ns=mapped",
    )
    const batch = await post("/e/", [
      { event: "e", properties: { token: "phc_mapped", distinct_id: "z" } },
    ])
    expect(batch.headers.get("x-mockingbird")).toEndWith("ns=mapped")
    const listed = await call("/api/projects/1/feature_flags/", {
      headers: { authorization: "Bearer phx_personal" },
    })
    expect(
      ((await listed.json()) as { results: { key: string }[] }).results.map((f) => f.key),
    ).toEqual(["k"])
    // Admin routes under a prefix reach the same namespace.
    const viaPrefix = (await (await call("/ns/prefixed/__admin/flags")).json()) as {
      flags: { default: string }[]
    }
    expect(viaPrefix.flags[0]?.default).toBe("prefixed")
  })

  test("reset clears one namespace only", async () => {
    const { admin, runtime } = harness()
    await admin("/flags/k?namespace=a", { default: true })
    await admin("/flags/k?namespace=b", { default: true })
    await runtime.fetch(new Request(`${HOST}/__admin/reset?namespace=a`, { method: "POST" }))
    const list = async (ns: string) =>
      ((await (await admin(`/flags?namespace=${ns}`)).json()) as { flags: unknown[] }).flags.length
    expect(await list("a")).toBe(0)
    expect(await list("b")).toBe(1)
  })
})

describe("contract: presets, journal, admin errors", () => {
  test("every preset is listed and applies through POST /__admin/faults", async () => {
    const { admin, post } = harness()
    const listed = (await (await admin("/faults/presets")).json()) as {
      presets: { name: string }[]
    }
    expect(listed.presets.map((p) => p.name).sort()).toEqual(Object.keys(POSTHOG_PRESETS).sort())
    const body = { token: "t", distinct_id: "1" }
    const cases: [string, (r: Response) => Promise<void>][] = [
      ["flags_5xx", async (r) => expect(r.status).toBe(500)],
      [
        "flags_429",
        async (r) => {
          expect(r.status).toBe(429)
          expect(r.headers.get("retry-after")).toBe("1")
        },
      ],
      [
        "errors_while_computing",
        async (r) =>
          expect(((await r.json()) as Record<string, unknown>).errorsWhileComputingFlags).toBe(
            true,
          ),
      ],
      [
        "quota_limited",
        async (r) =>
          expect(await r.json()).toMatchObject({ flags: {}, quotaLimited: ["feature_flags"] }),
      ],
    ]
    for (const [preset, check] of cases) {
      expect((await admin("/faults", { preset, count: 1 }, "POST")).status).toBe(201)
      await check(await post("/flags/?v=2", body))
      // count: 1 → the next call is healthy again.
      expect((await post("/flags/?v=2", body)).status).toBe(200)
      // Each preset also armed a /decide rule; retire it before the next preset.
      await admin("/faults", undefined, "DELETE")
    }
    await admin("/faults", { preset: "flags_hang", count: 1 }, "POST")
    const started = performance.now()
    expect((await post("/decide/?v=3", { api_key: "t", distinct_id: "1" })).status).toBe(200)
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_400)
    await admin("/faults", { preset: "capture_5xx", count: 1 }, "POST")
    expect((await post("/i/v0/e/", { api_key: "t", event: "x" })).status).toBe(500)
  }, 10_000)

  test("the journal records metadata only: no emails, payloads or event properties", async () => {
    const { post, admin } = harness()
    await post("/flags?v=2", {
      api_key: "t",
      distinct_id: "p1",
      person_properties: { email: "patient@example.test" },
    })
    await post("/i/v0/e/", {
      api_key: "t",
      event: "note_added",
      distinct_id: "p1",
      properties: { diagnosis: "confidential-dx" },
    })
    const journal = JSON.stringify(await (await admin("/requests")).json())
    expect(journal).toContain("EvaluateFlags")
    expect(journal).toContain("CaptureEventV0")
    expect(journal).not.toContain("patient@example.test")
    expect(journal).not.toContain("confidential-dx")
  })

  test("admin errors use the mockingbird_admin shape", async () => {
    const { admin } = harness()
    const bad = await admin("/flags/x", { overrides: [{ value: true }] })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { type: "mockingbird_admin" } })
    expect((await admin("/flags/missing", undefined, "DELETE")).status).toBe(404)
    expect((await admin("/flags/import", { env: "staging" }, "POST")).status).toBe(400)
    expect((await admin("/events?since=yesterday")).status).toBe(400)
    const listing = (await (await admin("")).json()) as Record<string, unknown>
    for (const route of [
      "PUT /flags/:key",
      "POST /flags/import",
      "POST /flags/bump",
      "GET /events",
    ]) {
      expect(JSON.stringify(listing)).toContain(route)
    }
  })
})
