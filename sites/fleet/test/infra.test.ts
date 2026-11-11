import { expect, test } from "bun:test"
import { loadConfig, withVaultSecrets } from "../src/config.js"
import { loadTarget } from "../src/engine.js"
import { memoryObjectStore, type ObjectStore, s3ObjectStore } from "../src/objects.js"
import { createTelemetry } from "../src/telemetry.js"

type Runtime = { fetch(request: Request): Promise<Response> }
const boot = async (name: string, values: Record<string, unknown> = {}) =>
  (await (
    await loadTarget(name)
  ).create(values, { adminKey: undefined, seed: undefined, onLog: undefined })) as Runtime
const viaRuntime = (runtime: Runtime, seen?: Request[]): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as string, init)
    seen?.push(request.clone())
    return runtime.fetch(request)
  }) as typeof fetch

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (value: Uint8Array) => new TextDecoder().decode(value)

/** Every object store must give the engine the same compare-and-swap semantics. */
async function objectStoreContract(store: ObjectStore) {
  expect(await store.get("fleets/a/x/state.json.gz")).toEqual({ status: "missing" })
  const first = await store.put("fleets/a/x/state.json.gz", bytes("one"), null)
  expect(first).toBeString()
  // Creating again must fail: someone else created it first.
  expect(await store.put("fleets/a/x/state.json.gz", bytes("dup"), null)).toBeUndefined()

  const read = await store.get("fleets/a/x/state.json.gz")
  if (read.status !== "found") throw new Error("expected the object")
  expect(text(read.bytes)).toBe("one")
  expect(read.revision).toBe(first as string)
  expect(await store.get("fleets/a/x/state.json.gz", read.revision)).toEqual({
    status: "unchanged",
  })

  const second = await store.put("fleets/a/x/state.json.gz", bytes("two"), read.revision)
  expect(second).toBeString()
  expect(second).not.toBe(first)
  // A writer still holding the old revision loses and changes nothing.
  expect(await store.put("fleets/a/x/state.json.gz", bytes("stale"), read.revision)).toBeUndefined()
  const latest = await store.get("fleets/a/x/state.json.gz", read.revision)
  expect(latest.status === "found" && text(latest.bytes)).toBe("two")

  await store.put("fleets/a/y/state.json.gz", bytes("y"), null)
  await store.put("fleets/b/x/state.json.gz", bytes("other fleet"), null)
  await store.deletePrefix("fleets/a/")
  expect((await store.get("fleets/a/x/state.json.gz")).status).toBe("missing")
  expect((await store.get("fleets/a/y/state.json.gz")).status).toBe("missing")
  expect((await store.get("fleets/b/x/state.json.gz")).status).toBe("found")
  await expect(store.get("../escape")).rejects.toThrow(/invalid object key/)
}

test("memory object store honours the compare-and-swap contract", () =>
  objectStoreContract(memoryObjectStore()))

test("S3 object store honours it against the S3 emulator, inside its prefix only", async () => {
  const s3 = await boot("s3")
  const seen: Request[] = []
  const options = {
    endpoint: "http://s3.test",
    region: "auto",
    accessKeyId: "test",
    secretAccessKey: "test",
    bucket: "shared",
    fetch: viaRuntime(s3, seen),
  }
  expect((await s3.fetch(new Request("http://s3.test/shared", { method: "PUT" }))).ok).toBe(true)
  // Another app's object in the same shared bucket must survive everything this store does.
  await s3.fetch(
    new Request("http://s3.test/shared/other-app/keep.txt", { method: "PUT", body: "keep" }),
  )
  await objectStoreContract(s3ObjectStore({ ...options, prefix: "mockingbird-fleet/" }))
  expect(
    await (await s3.fetch(new Request("http://s3.test/shared/other-app/keep.txt"))).text(),
  ).toBe("keep")
  for (const request of seen) {
    const path = new URL(request.url).pathname
    expect(path === "/shared" || path.startsWith("/shared/mockingbird-fleet/")).toBe(true)
    expect(request.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256")
  }
})

test("telemetry exports traces, metrics and logs as OTLP/HTTP JSON the collector accepts", async () => {
  const collector = await boot("otel", { "ingest-auth": "none" })
  const statuses: Record<string, number> = {}
  const bodies: Record<string, { [key: string]: unknown }> = {}
  const telemetry = createTelemetry({
    endpoint: "http://otel.test",
    serviceName: "mockingbird-fleet",
    intervalMs: 3_600_000,
    write: () => {},
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input as string).pathname
      bodies[path] = JSON.parse(init?.body as string)
      const response = await collector.fetch(new Request(input as string, init))
      statuses[path] = response.status
      return response
    }) as typeof fetch,
  })
  await telemetry.span(
    "GET /f/*",
    { "http.request.method": "GET" },
    async () => {
      await telemetry.span("fleet.state.write", { "state.bytes": 12 }, async () => {}, {
        kind: "client",
      })
      telemetry.log("info", "served", { fleet: "demo" })
    },
    { kind: "server", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
  )
  await telemetry
    .span("failing", {}, async () => {
      throw new Error("boom")
    })
    .catch(() => {})
  telemetry.count("fleet.requests", { target: "stripe" })
  telemetry.record("fleet.request.duration", 12.5, { target: "stripe" })
  await telemetry.close()

  expect(statuses).toEqual({ "/v1/traces": 200, "/v1/logs": 200, "/v1/metrics": 200 })
  const spans = (
    bodies["/v1/traces"] as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[]
    }
  ).resourceSpans[0]?.scopeSpans[0]?.spans as Record<string, unknown>[]
  const server = spans.find((span) => span.name === "GET /f/*")
  const child = spans.find((span) => span.name === "fleet.state.write")
  // The incoming W3C trace context is continued, and children nest under the request span.
  expect(server).toMatchObject({
    traceId: "0af7651916cd43dd8448eb211c80319c",
    parentSpanId: "b7ad6b7169203331",
    kind: 2,
  })
  expect(child).toMatchObject({ traceId: server?.traceId, parentSpanId: server?.spanId, kind: 3 })
  expect(spans.find((span) => span.name === "failing")?.status).toEqual({
    code: 2,
    message: "boom",
  })
  expect(JSON.stringify(bodies["/v1/logs"])).toContain(server?.traceId as string)
})

test("a collector outage never fails the work being traced", async () => {
  const telemetry = createTelemetry({
    endpoint: "http://otel.test",
    serviceName: "x",
    write: () => {},
    fetch: (async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch,
  })
  expect(await telemetry.span("work", {}, async () => 42)).toBe(42)
  await telemetry.close()
})

const hosted = {
  PUBLIC_URL: "https://mockingbird-fleet.chrisvouga.dev",
  DATABASE_URL: "postgres://example",
  S3_ENDPOINT: "https://r2.example",
  S3_REGION: "auto",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "secret",
  S3_BUCKET: "crvouga-production",
  OIDC_ISSUER: "https://auth.chrisvouga.dev/realms/projects",
  OIDC_CLIENT_ID: "app-123",
}

test("configuration follows the hosting contract's variable names and defaults", () => {
  const config = loadConfig(hosted)
  expect(config).toMatchObject({
    port: 8080,
    publicUrl: "https://mockingbird-fleet.chrisvouga.dev",
    fleetUrl: "https://mockingbird-fleet.chrisvouga.dev",
    databaseSchema: "mockingbird_fleet",
    s3Prefix: "mockingbird-fleet/",
    devLogin: false,
    otel: undefined,
  })
  expect(config.oidc?.redirectUri).toBe("https://mockingbird-fleet.chrisvouga.dev/auth/callback")
  const traced = loadConfig({
    ...hosted,
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.example/otlp/",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20abc,x-scope=fleet",
  })
  expect(traced.otel).toEqual({
    endpoint: "https://otlp.example/otlp",
    headers: { Authorization: "Basic abc", "x-scope": "fleet" },
    serviceName: "mockingbird-fleet",
  })
})

test("a hosted boot names every missing variable and refuses unsafe shortcuts", () => {
  const message = (env: Record<string, string>) => {
    try {
      loadConfig(env)
      return ""
    } catch (error) {
      return (error as Error).message
    }
  }
  const bare = message({ PUBLIC_URL: "https://mockingbird-fleet.chrisvouga.dev" })
  for (const name of [
    "DATABASE_URL",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_SECRET_ACCESS_KEY",
    "OIDC_ISSUER",
  ])
    expect(bare).toContain(name)
  // Dev sign-in and in-memory storage exist for loopback only.
  expect(message({ ...hosted, AUTH_DEV_LOGIN: "1" })).toContain("AUTH_DEV_LOGIN")
  expect(message({ ...hosted, PUBLIC_URL: "http://mockingbird-fleet.chrisvouga.dev" })).toContain(
    "https",
  )
  expect(message({ ...hosted, S3_PREFIX: "../other-app" })).toContain("S3_PREFIX")
  expect(message({ ...hosted, DATABASE_SCHEMA: "public; drop" })).toContain("DATABASE_SCHEMA")
  expect(loadConfig({ AUTH_DEV_LOGIN: "1" })).toMatchObject({
    publicUrl: "http://localhost:8080",
    databaseUrl: undefined,
    s3: undefined,
  })
})

test("Vault fills in what the environment does not set, retrying while sealed", async () => {
  const calls: string[] = []
  let attempts = 0
  const env = await withVaultSecrets(
    { VAULT_ADDR: "https://vault.chrisvouga.dev/", VAULT_TOKEN: "t", S3_BUCKET: "from-env" },
    {
      sleep: async () => {},
      fetch: (async (url: string, init: RequestInit) => {
        calls.push(`${url} ${(init.headers as Record<string, string>)["X-Vault-Token"]}`)
        if (attempts++ === 0) return new Response("sealed", { status: 503 })
        return Response.json({
          data: { data: { DATABASE_URL: "postgres://vault", S3_BUCKET: "from-vault" } },
        })
      }) as unknown as typeof fetch,
    },
  )
  expect(calls).toEqual(Array(2).fill("https://vault.chrisvouga.dev/v1/secret/data/personal/prd t"))
  expect(env.DATABASE_URL).toBe("postgres://vault")
  expect(env.S3_BUCKET).toBe("from-env")
  expect(await withVaultSecrets({ PORT: "1" })).toEqual({ PORT: "1" })
  await expect(
    withVaultSecrets(
      { VAULT_ADDR: "https://v", VAULT_TOKEN: "t" },
      {
        sleep: async () => {},
        fetch: (async () => new Response("", { status: 403 })) as unknown as typeof fetch,
      },
    ),
  ).rejects.toThrow(/HTTP 403/)
})
