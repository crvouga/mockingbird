import { afterEach, expect, test } from "bun:test"
import { createSandboxProxy, sandboxProviders } from "@crvouga/mockingbird-preview/sandbox-proxy"
import { api, setFetcher } from "./src/client/api.js"
import { buildDemo, type Demo } from "./src/composition/build.js"
import { createInProcessFetcher } from "./src/composition/inProcessFetcher.js"
import { createLabSandbox } from "./src/composition/sandbox.js"

const ACCESS_KEY = "preview-access-key"
const RESEND_KEY = "re_sandbox_secret"

/** The lab with sandbox mode wired as the preview wires it, but the vendor is a recorder. */
const startLab = async () => {
  const sent: Request[] = []
  const proxy = createSandboxProxy({
    providers: Object.values(sandboxProviders),
    env: { SANDBOX_PROXY_TOKEN: ACCESS_KEY, RESEND_API_KEY: RESEND_KEY },
    basePath: "/__sandbox",
    fetch: async (request) => {
      sent.push(request)
      return Response.json({ id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" })
    },
  })
  const stored = new Map<string, string>()
  const sandbox = createLabSandbox("https://lab.test/__sandbox", {
    fetch: (request) => proxy(request),
    storage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
      removeItem: (key) => void stored.delete(key),
    },
  })
  if (!sandbox.upstream) throw new Error("a proxy URL gives every emulator a transport")
  const demo = await buildDemo({ html: "", js: "" }, { upstream: sandbox.upstream })
  setFetcher(createInProcessFetcher(demo.app))
  running = demo
  return { demo, sent, controls: sandbox.controls(demo.admins) }
}

let running: Demo | undefined
afterEach(() => {
  running?.notifications.close()
  running = undefined
})

test("the System screen lists every service, and only vendor APIs can use a sandbox", async () => {
  const { controls } = await startLab()
  await controls.setAccessKey(ACCESS_KEY)
  const { sandbox, services } = await controls.list()
  expect(sandbox.state).toBe("ready")
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
  // No secret on the proxy for these.
  expect(unavailable.stripe).toContain("STRIPE_SECRET_KEY")
  expect(unavailable.postgres).toBe("Runs in this browser; there is no vendor sandbox")
  expect(unavailable.google).toBe("Sign-in redirects can't be forwarded to a vendor sandbox")
})

test("switching Resend to its sandbox sends the app's email through the proxy with the real key", async () => {
  const { demo, sent, controls } = await startLab()
  await controls.setAccessKey(ACCESS_KEY)

  await api.emailStart("ada@example.test")
  await demo.notifications.waitFor({ channel: "email", to: "ada@example.test" })
  expect(sent).toHaveLength(0)

  await controls.setMode("resend", "sandbox")
  expect((await controls.list()).services.find((s) => s.id === "resend")?.mode).toBe("sandbox")
  await api.emailStart("grace@example.test")

  expect(sent).toHaveLength(1)
  const [request] = sent as [Request]
  expect(request.method).toBe("POST")
  expect(request.url).toBe("https://api.resend.com/emails")
  expect(request.headers.get("authorization")).toBe(`Bearer ${RESEND_KEY}`)
  expect(request.headers.get("x-mockingbird-sandbox-key")).toBeNull()
  const body = (await request.json()) as { to: string[]; subject: string }
  expect(body.to).toEqual(["grace@example.test"])
  expect(body.subject).toMatch(/sign-in code/)

  await controls.setMode("resend", "emulated")
  await api.emailStart("alan@example.test")
  await demo.notifications.waitFor({ channel: "email", to: "alan@example.test" })
  expect(sent).toHaveLength(1)
})

test("without the access key nothing reaches a vendor", async () => {
  const { sent, controls } = await startLab()
  const { sandbox, services } = await controls.list()
  expect(sandbox.state).toBe("locked")
  expect(services.every((service) => service.unavailable !== undefined)).toBe(true)
  await expect(controls.setMode("resend", "sandbox")).rejects.toThrow()
  await api.emailStart("ada@example.test")
  expect(sent).toHaveLength(0)
})
