import { afterEach, expect, test } from "bun:test"
import {
  createDevProxy,
  devProviders,
  NON_PROD_PATTERNS,
} from "@crvouga/mockingbird-preview/dev-proxy"
import { api, setFetcher } from "./src/client/api.js"
import { buildDemo, type Demo } from "./src/composition/build.js"
import { createLabDevResources } from "./src/composition/dev.js"
import { createInProcessFetcher } from "./src/composition/inProcessFetcher.js"

const RESEND_KEY = "re_DevAccountKey123"

/**
 * The lab with dev resources wired as the preview wires it, but every real resource is a
 * recorder. `allow` is the proxy's non-production allow-list.
 */
const startLab = async (
  allow: Record<string, RegExp> = { RESEND_API_KEY: /^re_DevAccountKey123$/ },
  env: Record<string, string> = {},
) => {
  const sent: Request[] = []
  const proxy = createDevProxy({
    providers: Object.values(devProviders),
    env: { RESEND_API_KEY: RESEND_KEY, ...env },
    allow,
    basePath: "/__dev",
    fetch: async (request) => {
      sent.push(request)
      return Response.json({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" })
    },
  })
  const stored = new Map<string, string>()
  const dev = createLabDevResources("https://lab.test/__dev", {
    // What a browser adds to the page's own requests to its own origin.
    fetch: (request) => {
      const sameOrigin = new Request(request)
      sameOrigin.headers.set("sec-fetch-site", "same-origin")
      return proxy(sameOrigin)
    },
    storage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
      removeItem: (key) => void stored.delete(key),
    },
  })
  if (!dev.upstream) throw new Error("a proxy URL gives every emulator a transport")
  const demo = await buildDemo({ html: "", js: "" }, { upstream: dev.upstream })
  setFetcher(createInProcessFetcher(demo.app))
  running = demo
  return { demo, sent, proxy, controls: dev.controls(demo.admins) }
}

let running: Demo | undefined
afterEach(() => {
  running?.notifications.close()
  running = undefined
})

test("the System screen lists every service, and says why each one can't use a dev resource", async () => {
  const { controls } = await startLab()
  const { dev, services } = await controls.list()
  expect(dev.state).toBe("ready")
  expect(services.map((service) => service.id)).toEqual([
    "stripe",
    "junction",
    "resend",
    "twilio",
    "fcm",
    "slack",
    "google",
    "apple",
    "postgres",
  ])
  expect(services.every((service) => service.mode === "emulated")).toBe(true)
  const unavailable = Object.fromEntries(services.map((s) => [s.id, s.unavailable]))
  expect(unavailable.resend).toBeUndefined()
  // Not allow-listed: blocked before any credential is even looked at.
  expect(unavailable.slack).toContain("SLACK_BOT_TOKEN")
  expect(unavailable.postgres).toBe(
    "Runs in this browser; it has no network connection to a dev database",
  )
  expect(unavailable.google).toBe("Sign-in redirects can't be forwarded to a dev resource")
  // No value ever reaches the browser.
  expect(JSON.stringify(services)).not.toContain(RESEND_KEY)
})

test("switching Resend to Dev sends the app's email through the proxy with the dev account's key", async () => {
  const { demo, sent, controls } = await startLab()

  await api.emailStart("ada@example.test")
  await demo.notifications.waitFor({ channel: "email", to: "ada@example.test" })
  expect(sent).toHaveLength(0)

  await controls.setMode("resend", "dev")
  expect((await controls.list()).services.find((s) => s.id === "resend")?.mode).toBe("dev")
  await api.emailStart("grace@example.test")

  expect(sent).toHaveLength(1)
  const [request] = sent as [Request]
  expect(request.method).toBe("POST")
  expect(request.url).toBe("https://api.resend.com/emails")
  expect(request.headers.get("authorization")).toBe(`Bearer ${RESEND_KEY}`)
  expect([...request.headers.keys()].filter((name) => name.startsWith("x-mockingbird"))).toEqual([])
  const body = (await request.json()) as { to: string[]; subject: string }
  expect(body.to).toEqual(["grace@example.test"])
  expect(body.subject).toMatch(/sign-in code/)

  await controls.setMode("resend", "emulated")
  await api.emailStart("alan@example.test")
  await demo.notifications.waitFor({ channel: "email", to: "alan@example.test" })
  expect(sent).toHaveLength(1)
})

test("a credential with no allow-list pattern is never used", async () => {
  const { sent, controls } = await startLab({})
  const resend = (await controls.list()).services.find((s) => s.id === "resend")
  expect(resend?.unavailable).toContain("RESEND_API_KEY")
  await expect(controls.setMode("resend", "dev")).rejects.toThrow()
  await api.emailStart("ada@example.test")
  expect(sent).toHaveLength(0)
})

test("a production Stripe key is refused even when a careless pattern would allow it", async () => {
  const { sent, controls } = await startLab(
    { ...NON_PROD_PATTERNS, STRIPE_SECRET_KEY: /^.*$/ },
    { STRIPE_SECRET_KEY: "sk_live_51ProductionKey" },
  )
  const stripe = (await controls.list()).services.find((s) => s.id === "stripe")
  expect(stripe?.unavailable).toContain("production")
  expect(stripe?.unavailable).not.toContain("sk_live_51ProductionKey")
  await expect(controls.setMode("stripe", "dev")).rejects.toThrow()
  expect(sent).toHaveLength(0)
})

test("a request from another site never reaches a real resource", async () => {
  const { sent, proxy } = await startLab()
  for (const headers of [
    { "sec-fetch-site": "cross-site", origin: "https://attacker.example" },
    { "sec-fetch-site": "same-site", origin: "https://other.lab.test" },
    { "sec-fetch-site": "same-origin", origin: "https://attacker.example" },
    {},
  ]) {
    const response = await proxy(
      new Request("https://lab.test/__dev/resend/emails", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ to: ["victim@example.test"], subject: "hi" }),
      }),
    )
    expect(response.status).toBe(403)
  }
  expect(sent).toHaveLength(0)
})
