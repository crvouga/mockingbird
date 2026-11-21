import { expect, test } from "bun:test"
import type { PreviewDownload } from "./src/artifacts.js"
import { createCloudflarePreviews } from "./src/cloudflare.js"

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
