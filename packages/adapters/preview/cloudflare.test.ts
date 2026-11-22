import { expect, test } from "bun:test"
import type { PreviewDownload } from "./src/artifacts.js"
import {
  createCloudflarePreviews,
  customPreviewOrigin,
  isPreviewOriginOf,
  previewOrigin,
} from "./src/cloudflare.js"

const result = (value: unknown, info?: unknown) =>
  Response.json({ success: true, result: value, ...(info ? { result_info: info } : {}) })
const resource = {
  id: "preview-id",
  name: "pr-12",
  updated_on: "2026-11-15T00:00:00Z",
  urls: ["https://pr-12.preview.example"],
}
const facts = {
  state: "open" as const,
  repository: "owner/repo",
  headRepository: "owner/repo",
  head: "commit-a",
}
const input = {
  name: "pr-12",
  commit: "commit-a",
  files: [
    { path: "/index.html", bytes: new TextEncoder().encode("hello"), contentType: "text/html" },
  ],
  currentPullRequest: async () => facts,
  headers: "/*\n  Cross-Origin-Opener-Policy: same-origin\n",
}

test("deploy uploads only requested assets to a named preview, preserves headers, and retries by content identity", async () => {
  const operations: string[] = []
  let created = false
  let annotation: unknown
  let hash = ""
  const fetch: PreviewDownload = async (url, init) => {
    const request = new Request(url, init)
    const path = new URL(request.url).pathname
    operations.push(`${request.method} ${path}`)
    if (path.endsWith("/previews/pr-12") && request.method === "GET")
      return created ? result(resource) : new Response(null, { status: 404 })
    if (path.endsWith("/previews") && request.method === "POST") {
      expect(new URL(request.url).searchParams.get("ignore_base_config")).toBe("true")
      created = true
      return result(resource)
    }
    if (path.endsWith("/deployments/latest"))
      return annotation ? result({ annotations: annotation }) : new Response(null, { status: 404 })
    if (path.endsWith("/assets-upload-session")) {
      const body = (await request.json()) as {
        manifest: Record<string, { hash: string; size: number }>
      }
      hash = body.manifest["/index.html"]?.hash ?? ""
      expect(hash).toMatch(/^[a-f0-9]{32}$/)
      expect(body.manifest["/index.html"]?.size).toBe(5)
      return result({ jwt: "upload-token", buckets: [[hash]] })
    }
    if (path.endsWith("/assets/upload")) {
      expect(request.headers.get("authorization")).toBe("Bearer upload-token")
      const uploaded = (await request.formData()).get(hash)
      expect(uploaded).toBeInstanceOf(Blob)
      expect(await (uploaded as Blob).text()).toBe("aGVsbG8=")
      return result({ jwt: "completion-token" })
    }
    if (path.endsWith("/previews/preview-id/deployments")) {
      const form = await request.formData()
      const metadata = JSON.parse(String(form.get("metadata")))
      annotation = metadata.annotations
      expect(metadata.env).toEqual({})
      expect(metadata.assets.jwt).toBe("completion-token")
      const headers = form.get("files") as File
      expect(headers.name).toBe("_headers")
      expect(await headers.text()).toBe(input.headers)
      return result({ id: "deployment-a" })
    }
    throw new Error("Unexpected operation")
  }
  const previews = createCloudflarePreviews({
    accountId: "account",
    workerName: "worker",
    token: "account-token",
    fetch,
  })
  expect((await previews.deploy(input)).action).toBe("deployed")
  expect((await previews.deploy(input)).action).toBe("unchanged")
  expect(
    operations.filter((entry) => entry.includes("POST") && entry.endsWith("/deployments")),
  ).toHaveLength(1)
  expect(operations.some((entry) => entry.startsWith("PUT"))).toBe(false)
})
test("failed uploads are terminal and never expose credentials or deploy partial artifacts", async () => {
  const calls: string[] = []
  const fetch: PreviewDownload = async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push(path)
    if (path.endsWith("/previews/pr-12")) return result(resource)
    if (path.endsWith("/deployments/latest")) return new Response(null, { status: 404 })
    if (path.endsWith("/assets-upload-session")) {
      const body = JSON.parse(String(init?.body))
      return result({
        jwt: "never-print-upload-secret",
        buckets: [[body.manifest["/index.html"].hash]],
      })
    }
    return new Response("secret echoed by upstream", { status: 500 })
  }
  const previews = createCloudflarePreviews({
    accountId: "account",
    workerName: "worker",
    token: "never-print-account-secret",
    fetch,
  })
  const error = await previews.deploy(input).then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(String(error)).toBe("Error: Cloudflare preview asset upload failed (HTTP 500)")
  expect(calls.some((path) => path.endsWith("/deployments"))).toBe(false)
})
test("forks and stale heads never deploy; a close during upload removes instead", async () => {
  let calls = 0
  const previews = createCloudflarePreviews({
    accountId: "a",
    workerName: "w",
    token: "secret",
    fetch: async () => {
      calls++
      return new Response(null, { status: 404 })
    },
  })
  expect((await previews.deploy({ ...input, commit: "old" })).action).toBe("skip")
  expect(
    (
      await previews.deploy({
        ...input,
        currentPullRequest: async () => ({ ...facts, headRepository: "fork/repo" }),
      })
    ).action,
  ).toBe("skip")
  expect(calls).toBe(0)
  const operations: string[] = []
  let currentReads = 0
  const changing = createCloudflarePreviews({
    accountId: "a",
    workerName: "w",
    token: "secret",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname
      operations.push(`${init?.method ?? "GET"} ${path}`)
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      if (path.endsWith("/previews/pr-12")) return result(resource)
      if (path.endsWith("/deployments/latest")) return new Response(null, { status: 404 })
      if (path.endsWith("/assets-upload-session")) return result({ jwt: "complete", buckets: [] })
      throw new Error("Unexpected deploy")
    },
  })
  const outcome = await changing.deploy({
    ...input,
    currentPullRequest: async () => ({ ...facts, state: ++currentReads === 1 ? "open" : "closed" }),
  })
  expect(outcome.action).toBe("remove")
  expect(operations.some((entry) => entry.startsWith("DELETE"))).toBe(true)
  expect(operations.some((entry) => entry.endsWith("/deployments"))).toBe(false)
})
test("list follows pagination, deletion of missing previews succeeds, API errors are not empty lists", async () => {
  const pages: number[] = []
  const previews = createCloudflarePreviews({
    accountId: "a",
    workerName: "w",
    token: "secret",
    fetch: async (url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 404 })
      const page = Number(new URL(String(url)).searchParams.get("page"))
      pages.push(page)
      return result([{ ...resource, id: `id-${page}`, name: `pr-${page}` }], { total_pages: 2 })
    },
  })
  expect((await previews.list()).map((entry) => entry.name)).toEqual(["pr-1", "pr-2"])
  expect(pages).toEqual([1, 2])
  await previews.remove("already-absent")
  const refused = createCloudflarePreviews({
    accountId: "a",
    workerName: "w",
    token: "secret",
    fetch: async () => new Response(null, { status: 403 }),
  })
  await expect(refused.list()).rejects.toThrow("HTTP 403")
})

const deployFetch =
  (handle: (request: Request, path: string) => Promise<Response | undefined>): PreviewDownload =>
  async (url, init) => {
    const request = new Request(url, init)
    const path = new URL(request.url).pathname
    const handled = await handle(request, path)
    if (handled) return handled
    if (path.endsWith("/previews/pr-12") && request.method === "GET") return result(resource)
    if (path.endsWith("/deployments/latest")) return new Response(null, { status: 404 })
    if (path.endsWith("/assets-upload-session")) return result({ jwt: "done", buckets: [] })
    if (path.endsWith("/previews/preview-id/deployments")) return result({ id: "deployment-a" })
    throw new Error(`Unexpected ${request.method} ${path}`)
  }
const client = (fetch: PreviewDownload, extra: { uploadConcurrency?: number } = {}) =>
  createCloudflarePreviews({ accountId: "a", workerName: "w", token: "secret", fetch, ...extra })

test("#847 deploy sends _headers as exactly text/plain on every runtime", async () => {
  let raw = ""
  let type = ""
  const previews = client(
    deployFetch(async (request, path) => {
      if (!path.endsWith("/previews/preview-id/deployments")) return undefined
      type = request.headers.get("content-type") ?? ""
      raw = await request.text()
      return result({ id: "deployment-a" })
    }),
  )
  expect((await previews.deploy(input)).action).toBe("deployed")
  expect(type).toMatch(/^multipart\/form-data; boundary=/)
  const part = raw.split(/\r\n--/).find((entry) => entry.includes('filename="_headers"'))
  expect(part).toContain("\r\nContent-Type: text/plain\r\n\r\n")
  expect(part).not.toContain("charset")
  const form = await new Response(raw, { headers: { "content-type": type } }).formData()
  expect(await (form.get("files") as File).text()).toBe(input.headers)
  expect(JSON.parse(String(form.get("metadata"))).assets.jwt).toBe("done")
})

const listing = (handle: (path: string, url: URL) => Response | undefined) =>
  client(async (url) => {
    const parsed = new URL(String(url))
    const handled = handle(parsed.pathname, parsed)
    if (handled) return handled
    throw new Error(`Unexpected ${parsed.pathname}`)
  })
test("#853.1 list resolves to no Previews before the parent Worker's first deploy", async () => {
  const previews = listing(() => new Response(null, { status: 404 }))
  expect(await previews.list()).toEqual([])
})
test("#853.2 list rejects when the Previews endpoint is 404 but the Worker exists", async () => {
  const previews = listing((path) =>
    path.endsWith("/workers/workers/w") ? result({ id: "w" }) : new Response(null, { status: 404 }),
  )
  await expect(previews.list()).rejects.toThrow("Cloudflare preview list failed (HTTP 404)")
})
test("#853.3 list follows result_info.cursor across pages and keeps items without updated_on", async () => {
  const seen: (string | null)[] = []
  const previews = listing((_path, url) => {
    const cursor = url.searchParams.get("cursor")
    seen.push(cursor)
    if (!cursor) return result([{ ...resource, id: "id-1", name: "pr-1" }], { cursor: "next" })
    const { updated_on: _, ...rest } = resource
    return result([{ ...rest, id: "id-2", name: "pr-2", created_on: "2026-11-14T00:00:00Z" }], {
      cursor: "",
    })
  })
  const all = await previews.list()
  expect(all.map((entry) => entry.name)).toEqual(["pr-1", "pr-2"])
  expect(all[1]?.updatedAt).toBe("2026-11-14T00:00:00Z")
  expect(seen).toEqual([null, "next"])
})

const jwt = (payload: Record<string, unknown>) =>
  `e30.${btoa(JSON.stringify(payload)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.sig`
const asset = (name: string, contentType = "text/html") => ({
  path: `/${name}`,
  bytes: new TextEncoder().encode(name),
  contentType,
})
const hashesOf = async (request: Request) =>
  Object.values(
    ((await request.json()) as { manifest: Record<string, { hash: string }> }).manifest,
  ).map((entry) => entry.hash)

test("#848.1 a session with wrangler_single_asset_uploads uploads each asset raw in its own request", async () => {
  const uploads: { hash: string; type: string | null; body: string; auth: string | null }[] = []
  const session = jwt({ wrangler_single_asset_uploads: true })
  let deployedJwt = ""
  let remaining = 0
  const previews = client(
    deployFetch(async (request, path) => {
      if (path.endsWith("/assets-upload-session")) {
        const hashes = await hashesOf(request)
        remaining = hashes.length
        return result({ jwt: session, buckets: [hashes] })
      }
      const single = path.match(/\/workers\/assets\/upload\/([a-f0-9]+)$/)
      if (single) {
        uploads.push({
          hash: single[1] ?? "",
          type: request.headers.get("content-type"),
          body: await request.text(),
          auth: request.headers.get("authorization"),
        })
        return result(--remaining === 0 ? { jwt: "completion-token" } : {})
      }
      if (path.endsWith("/assets/upload")) throw new Error("bucket upload in single mode")
      if (path.endsWith("/previews/preview-id/deployments")) {
        deployedJwt = JSON.parse(String((await request.formData()).get("metadata"))).assets.jwt
        return result({ id: "deployment-a" })
      }
      return undefined
    }),
  )
  const files = [asset("a.html"), asset("b.css", "text/css")]
  expect((await previews.deploy({ ...input, files })).action).toBe("deployed")
  expect(uploads.map(({ body, type }) => [body, type]).sort()).toEqual([
    ["a.html", "text/html"],
    ["b.css", "text/css"],
  ])
  expect(uploads.every((entry) => entry.auth === `Bearer ${session}`)).toBe(true)
  expect(deployedJwt).toBe("completion-token")
})
test("#848.2 a session without the claim uploads base64 buckets", async () => {
  const paths: string[] = []
  const previews = client(
    deployFetch(async (request, path) => {
      if (path.includes("/assets/upload")) paths.push(path)
      if (path.endsWith("/assets-upload-session"))
        return result({ jwt: jwt({ exp: 1 }), buckets: [await hashesOf(request)] })
      if (path.endsWith("/assets/upload")) {
        expect(new URL(request.url).searchParams.get("base64")).toBe("true")
        const form = await request.formData()
        expect([...form.values()]).toHaveLength(2)
        return result({ jwt: "completion-token" })
      }
      return undefined
    }),
  )
  const files = [asset("a.html"), asset("b.html")]
  expect((await previews.deploy({ ...input, files })).action).toBe("deployed")
  expect(paths).toEqual(["/client/v4/accounts/a/workers/assets/upload"])
})
test("#849.1 buckets upload concurrently up to the configured limit, default 3", async () => {
  const run = async (uploadConcurrency?: number) => {
    let inFlight = 0
    let peak = 0
    let uploaded = 0
    const previews = client(
      deployFetch(async (request, path) => {
        if (path.endsWith("/assets-upload-session"))
          return result({ jwt: "session", buckets: (await hashesOf(request)).map((h) => [h]) })
        if (path.endsWith("/assets/upload")) {
          peak = Math.max(peak, ++inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight--
          // Only one response carries the completion JWT, and not the last to finish.
          return result(++uploaded === 2 ? { jwt: "completion-token" } : {})
        }
        return undefined
      }),
      uploadConcurrency === undefined ? {} : { uploadConcurrency },
    )
    const files = Array.from({ length: 7 }, (_, index) => asset(`${index}.html`))
    expect((await previews.deploy({ ...input, files })).action).toBe("deployed")
    expect(uploaded).toBe(7)
    return peak
  }
  expect(await run()).toBe(3)
  expect(await run(5)).toBe(5)
  expect(await run(1)).toBe(1)
  expect(() => client(async () => new Response(), { uploadConcurrency: 0 })).toThrow(
    "uploadConcurrency",
  )
})
test("#849.2 the Preview lookup runs beside the asset upload", async () => {
  const events: string[] = []
  let release: () => void = () => {}
  const lookupHeld = new Promise<void>((resolve) => {
    release = resolve
  })
  const previews = client(
    deployFetch(async (request, path) => {
      if (path.endsWith("/previews/pr-12") && request.method === "GET") {
        events.push("lookup started")
        await lookupHeld
        events.push("lookup finished")
        return result(resource)
      }
      if (path.endsWith("/assets-upload-session")) {
        events.push("session")
        return result({ jwt: "session", buckets: [await hashesOf(request)] })
      }
      if (path.endsWith("/assets/upload")) {
        events.push("upload")
        release()
        return result({ jwt: "completion-token" })
      }
      return undefined
    }),
  )
  expect((await previews.deploy(input)).action).toBe("deployed")
  expect(events).toEqual(["lookup started", "session", "upload", "lookup finished"])
})
test("#850 get(name) reads one Preview, null on 404, rejects on any other failure", async () => {
  const answer = (response: () => Response) =>
    client(async (url) => {
      expect(new URL(String(url)).pathname).toBe(
        "/client/v4/accounts/a/workers/workers/w/previews/pr-7",
      )
      return response()
    })
  expect(await answer(() => result({ ...resource, name: "pr-7" })).get("pr-7")).toEqual({
    id: "preview-id",
    name: "pr-7",
    updatedAt: resource.updated_on,
    urls: resource.urls,
  })
  expect(await answer(() => new Response(null, { status: 404 })).get("pr-7")).toBeNull()
  await expect(answer(() => new Response(null, { status: 403 })).get("pr-7")).rejects.toThrow(
    "HTTP 403",
  )
  await expect(answer(() => new Response(null, { status: 503 })).get("pr-7")).rejects.toThrow(
    "HTTP 503",
  )
  await expect(
    answer(() => {
      throw new TypeError("offline")
    }).get("pr-7"),
  ).rejects.toThrow("(network)")
})
test("#851.1 subdomain() returns the account's workers.dev subdomain and rejects on failure", async () => {
  const answer = (response: Response) =>
    client(async (url) => {
      expect(new URL(String(url)).pathname).toBe("/client/v4/accounts/a/workers/subdomain")
      return response
    })
  expect(await answer(result({ subdomain: "acme" })).subdomain()).toBe("acme")
  await expect(answer(new Response(null, { status: 404 })).subdomain()).rejects.toThrow("HTTP 404")
  await expect(answer(result({})).subdomain()).rejects.toThrow("Invalid")
})
test("#851.2 previewOrigin is https://<preview>-<worker>.<subdomain>.workers.dev, 63-character label limit", () => {
  expect(previewOrigin({ previewName: "pr-7", workerName: "site", subdomain: "acme" })).toBe(
    "https://pr-7-site.acme.workers.dev",
  )
  expect(() =>
    previewOrigin({ previewName: "pr-7", workerName: "w".repeat(59), subdomain: "acme" }),
  ).toThrow("63")
  expect(
    previewOrigin({ previewName: "pr-7", workerName: "w".repeat(58), subdomain: "acme" }),
  ).toBe(`https://pr-7-${"w".repeat(58)}.acme.workers.dev`)
})
test("#851.3 customPreviewOrigin is https://<preview>.<host>", () => {
  expect(customPreviewOrigin({ previewName: "pr-7", host: "preview.example.com" })).toBe(
    "https://pr-7.preview.example.com",
  )
  expect(() => customPreviewOrigin({ previewName: "pr-7", host: "evil.com/x" })).toThrow()
})
test("#851.4 isPreviewOriginOf accepts only https origins of that Preview on our hosts", () => {
  const ours = { previewName: "pr-7", workerName: "site", subdomain: "acme", host: "example.com" }
  for (const origin of ["https://pr-7-site.acme.workers.dev", "https://pr-7.example.com/"])
    expect(isPreviewOriginOf({ ...ours, origin })).toBe(true)
  for (const origin of [
    "http://pr-7-site.acme.workers.dev",
    "https://pr-8-site.acme.workers.dev",
    "https://pr-7-site.other.workers.dev",
    "https://pr-7-site.acme.workers.dev.evil.com",
    "https://pr-7-site.acme.workers.dev:8443",
    "https://user@pr-7-site.acme.workers.dev",
    "https://pr-7-site.acme.workers.dev/path",
    "https://x.pr-7.example.com",
    "https://pr-7.example.com.evil.com",
    "not a url",
  ])
    expect(isPreviewOriginOf({ ...ours, origin })).toBe(false)
  expect(isPreviewOriginOf({ origin: "https://pr-7-other.acme.workers.dev", ...ours })).toBe(false)
  expect(
    isPreviewOriginOf({
      origin: "https://pr-7-other.acme.workers.dev",
      previewName: "pr-7",
      subdomain: "acme",
    }),
  ).toBe(true)
  expect(
    isPreviewOriginOf({
      origin: "https://pr-7.example.com",
      previewName: "pr-7",
      subdomain: "acme",
    }),
  ).toBe(false)
})

const settings = (previewsEnabled: boolean) => {
  const writes: { method: string; path: string; body: unknown; date: string | null }[] = []
  const previews = client(async (url, init) => {
    const request = new Request(url, init)
    const path = new URL(request.url).pathname
    expect(request.headers.get("cloudflare-workers-script-api-date")).toBe("2025-08-01")
    if (request.method === "GET" && path.endsWith("/workers/scripts/w/subdomain"))
      return result({ enabled: false, previews_enabled: previewsEnabled })
    writes.push({
      method: request.method,
      path,
      body: await request.json(),
      date: request.headers.get("cloudflare-workers-script-api-date"),
    })
    return result({})
  })
  return { previews, writes }
}
test("#852.1 servePreviews(null) turns on previews_enabled and keeps the workers.dev route as it was", async () => {
  const { previews, writes } = settings(false)
  expect(await previews.servePreviews(null)).toEqual({ changed: true })
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/client/v4/accounts/a/workers/scripts/w/subdomain",
      body: { enabled: false, previews_enabled: true },
      date: "2025-08-01",
    },
  ])
})
test("#852.2 servePreviews(null) writes nothing when Previews are already on", async () => {
  const { previews, writes } = settings(true)
  expect(await previews.servePreviews(null)).toEqual({ changed: false })
  expect(writes).toEqual([])
})
test("#852.3 servePreviews(host) enables Previews on that custom domain without deploying", async () => {
  const { previews, writes } = settings(false)
  expect(await previews.servePreviews("preview.example.com")).toEqual({ changed: true })
  expect(writes).toEqual([
    {
      method: "PUT",
      path: "/client/v4/accounts/a/workers/scripts/w/domains/records",
      body: {
        override_scope: true,
        override_existing_origin: true,
        override_existing_dns_record: true,
        origins: [{ hostname: "preview.example.com", previews_enabled: true }],
      },
      date: "2025-08-01",
    },
  ])
})
