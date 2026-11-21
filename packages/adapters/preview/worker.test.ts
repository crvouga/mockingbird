import { describe, expect, test } from "bun:test"
import type { PreviewStatusSnapshot } from "./src/preview-status.js"
import { createPreviewWorker, type PreviewWorkerEnv } from "./src/worker.js"
import entry from "./src/worker-entry.js"

const ORIGIN = "https://lab-pr-7.example.workers.dev"
const SHA = "d".repeat(40)

const fakeEnv = (extra: Record<string, unknown> = {}) => {
  const assetRequests: string[] = []
  const env: PreviewWorkerEnv = {
    ASSETS: {
      fetch: async (request: Request) => {
        assetRequests.push(new URL(request.url).pathname)
        if (new URL(request.url).pathname === "/version.json") {
          return Response.json({
            version: SHA,
            builtAt: "2026-11-20T10:00:00.000Z",
            entry: "./a.js",
          })
        }
        return new Response(`asset ${new URL(request.url).pathname}`)
      },
    },
    PREVIEW_BUILD: JSON.stringify({
      state: "deployed",
      version: SHA,
      at: "2026-11-20T10:01:00.000Z",
    }),
    PREVIEW_PR: JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7" }),
    ...extra,
  }
  return { env, assetRequests }
}

describe("createPreviewWorker", () => {
  test("serves the CI status from env with the deployed version from the assets", async () => {
    const { env, assetRequests } = fakeEnv()
    const response = await createPreviewWorker().fetch(
      new Request(`${ORIGIN}/__preview/status`),
      env,
    )
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as PreviewStatusSnapshot
    expect(snapshot.source).toBe("ci")
    expect(snapshot.build?.state).toBe("deployed")
    expect(snapshot.deployed?.version).toBe(SHA)
    expect(snapshot.pr?.number).toBe(7)
    expect(assetRequests).toEqual(["/version.json"])
  })

  test("unknown paths under the status base are 404, not assets", async () => {
    const { env, assetRequests } = fakeEnv()
    const response = await createPreviewWorker().fetch(new Request(`${ORIGIN}/__preview/x`), env)
    expect(response.status).toBe(404)
    expect(assetRequests).toEqual([])
  })

  test("everything else is a static asset", async () => {
    const { env } = fakeEnv()
    const worker = createPreviewWorker()
    expect(await (await worker.fetch(new Request(`${ORIGIN}/app/page`), env)).text()).toBe(
      "asset /app/page",
    )
    expect(await (await worker.fetch(new Request(`${ORIGIN}/__dev/stripe`), env)).text()).toBe(
      "asset /__dev/stripe",
    )
  })

  test("the dev proxy gets its base path and only string env values", async () => {
    const { env } = fakeEnv({ STRIPE_SECRET_KEY: "sk_test_1", COUNT: 3, FLAG: { on: true } })
    const seen: { path: string; env: Record<string, string | undefined> }[] = []
    const worker = createPreviewWorker({
      devProxy: {
        basePath: "/__dev/",
        fetch: async (request, proxyEnv) => {
          seen.push({ path: new URL(request.url).pathname, env: proxyEnv })
          return new Response("proxied")
        },
      },
    })
    expect(await (await worker.fetch(new Request(`${ORIGIN}/__dev`), env)).text()).toBe("proxied")
    expect(await (await worker.fetch(new Request(`${ORIGIN}/__dev/stripe/v1`), env)).text()).toBe(
      "proxied",
    )
    expect(await (await worker.fetch(new Request(`${ORIGIN}/__devx`), env)).text()).toBe(
      "asset /__devx",
    )
    expect(seen.map((s) => s.path)).toEqual(["/__dev", "/__dev/stripe/v1"])
    const proxyEnv = seen[0]?.env ?? {}
    expect(proxyEnv.STRIPE_SECRET_KEY).toBe("sk_test_1")
    expect(Object.values(proxyEnv).every((value) => typeof value === "string")).toBe(true)
    expect("COUNT" in proxyEnv || "FLAG" in proxyEnv || "ASSETS" in proxyEnv).toBe(false)
  })

  test("a custom status base path", async () => {
    const { env } = fakeEnv()
    const worker = createPreviewWorker({ basePath: "/_s" })
    expect((await worker.fetch(new Request(`${ORIGIN}/_s/status`), env)).status).toBe(200)
    expect(await (await worker.fetch(new Request(`${ORIGIN}/__preview/status`), env)).text()).toBe(
      "asset /__preview/status",
    )
  })

  test("a missing version.json leaves deployed out", async () => {
    const env: PreviewWorkerEnv = {
      ASSETS: { fetch: async () => new Response("nope", { status: 404 }) },
    }
    const response = await createPreviewWorker().fetch(
      new Request(`${ORIGIN}/__preview/status`),
      env,
    )
    const snapshot = (await response.json()) as PreviewStatusSnapshot
    expect(snapshot.deployed).toBeUndefined()
    expect(snapshot.source).toBe("none")
  })

  test("worker-entry's default export is a ready preview Worker", async () => {
    const { env } = fakeEnv()
    expect(typeof entry.fetch).toBe("function")
    expect((await entry.fetch(new Request(`${ORIGIN}/__preview/status`), env)).status).toBe(200)
  })
})
