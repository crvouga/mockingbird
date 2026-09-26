/**
 * Portability, proven by running it: the published entry (`dist/index.js`) and every runtime
 * dependency are bundled for the browser platform — any `node:` import or Node global would
 * fail the bundle — and served from Cloudflare's `workerd` (through Miniflare) with no Node
 * compatibility flags. A real V8 isolate without Node, Bun or Deno APIs then answers the
 * OAuth2 and FHIR flows a client runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { build } from "esbuild"
import { Miniflare } from "miniflare"

const dist = join(import.meta.dir, "dist", "index.js")

const WORKER = `
import { createRuntime, DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from ${JSON.stringify(dist)}
let runtime
export default {
  async fetch(request) {
    runtime ??= createRuntime({ baseUrl: "https://medplum.worker/" })
    const url = new URL(request.url)
    if (url.pathname === "/__probe") {
      return Response.json({
        hasProcess: typeof globalThis.process !== "undefined" && typeof globalThis.process.versions?.node === "string",
        hasBuffer: typeof globalThis.Buffer !== "undefined",
        hasBun: typeof globalThis.Bun !== "undefined",
        clientId: DEFAULT_CLIENT_ID,
        clientSecret: DEFAULT_CLIENT_SECRET,
      })
    }
    return runtime.fetch(request)
  },
}
`

let mf: Miniflare
let script = ""

beforeAll(async () => {
  if (!existsSync(dist)) throw new Error("build first: bun run build")
  const result = await build({
    stdin: { contents: WORKER, resolveDir: import.meta.dir, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["worker", "browser"],
    target: "es2022",
    write: false,
    logLevel: "silent",
  })
  script = result.outputFiles[0]?.text ?? ""
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: "medplum",
          type: "worker",
          compatibilityDate: "2025-01-01",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: script } },
          },
        },
      },
    ],
  } as ConstructorParameters<typeof Miniflare>[0])
}, 120_000)

afterAll(async () => {
  await mf?.dispose()
})

const call = async (path: string, init?: RequestInit) => {
  const response = await mf.dispatchFetch(
    `https://medplum.worker${path}`,
    init as Parameters<Miniflare["dispatchFetch"]>[1],
  )
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep text
  }
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are arbitrary JSON in tests
  return { status: response.status, headers: response.headers, body: body as any }
}

describe("portability: the published bundle in workerd (no Node APIs)", () => {
  test("the bundle has no Node, Bun or Deno imports", () => {
    expect(script.length).toBeGreaterThan(0)
    expect(script).not.toMatch(/from\s*["']node:/)
    expect(script).not.toMatch(/\brequire\s*\(\s*["']/)
  })

  test("the isolate is not Node, Bun or Deno", async () => {
    const probe = await call("/__probe")
    expect(probe.body.hasProcess).toBe(false)
    expect(probe.body.hasBun).toBe(false)
  })

  test("health, sign-in, FHIR CRUD, search and GraphQL all work", async () => {
    const probe = await call("/__probe")
    expect((await call("/health")).status).toBe(200)
    expect((await call("/healthcheck")).body.ok).toBe(true)

    const token = await call("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: probe.body.clientId,
        client_secret: probe.body.clientSecret,
      }).toString(),
    })
    expect(token.status).toBe(200)
    const auth = {
      authorization: `Bearer ${token.body.access_token}`,
      "content-type": "application/fhir+json",
    }

    const created = await call("/fhir/R4/Patient", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        resourceType: "Patient",
        name: [{ given: ["Ada"], family: "Lovelace" }],
        birthDate: "1815-12-10",
      }),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get("location")).toBe(
      `https://medplum.worker/fhir/R4/Patient/${created.body.id}`,
    )

    const invalid = await call("/fhir/R4/Patient", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ resourceType: "Patient", birthDate: "not a date" }),
    })
    expect(invalid.status).toBe(400)
    expect(invalid.body.issue[0].details.text).toBe("Invalid date format")

    const search = await call("/fhir/R4/Patient?name=love&_total=accurate", { headers: auth })
    expect(search.body.total).toBe(1)
    expect(search.body.entry[0].resource.id).toBe(created.body.id)

    const patched = await call(`/fhir/R4/Patient/${created.body.id}`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json-patch+json" },
      body: JSON.stringify([{ op: "add", path: "/gender", value: "female" }]),
    })
    expect(patched.body.gender).toBe("female")

    const history = await call(`/fhir/R4/Patient/${created.body.id}/_history`, { headers: auth })
    expect(history.body.total).toBe(2)

    const graphql = await call("/fhir/R4/$graphql", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ query: '{ PatientList(name: "ada") { id gender } }' }),
    })
    expect(graphql.body.data.PatientList).toEqual([{ id: created.body.id, gender: "female" }])

    const upload = await call("/fhir/R4/Binary", {
      method: "POST",
      headers: { ...auth, "content-type": "text/plain" },
      body: "bytes",
    })
    expect(upload.status).toBe(201)
    const download = await mf.dispatchFetch(upload.body.url as string)
    expect(await download.text()).toBe("bytes")
  }, 60_000)
})
