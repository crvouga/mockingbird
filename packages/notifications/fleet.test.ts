import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInstalledServiceLoader, startFleet } from "@crvouga/mockingbird-adapter-node"
import { NotificationClient } from "./src/index.js"
import { createServer, type NotificationServer } from "./src/server.js"
import * as send from "./test/send.js"

type Fleet = Awaited<ReturnType<typeof startFleet>>
let fleet: Fleet
let byFleet: NotificationServer
let byManifest: NotificationServer
let dir: string

const url = (name: string): send.Target => {
  const entry = fleet.manifest.services[name] as { url: string } | undefined
  if (!entry) throw new Error(`fleet has no ${name}`)
  return { url: entry.url.replace(/\/$/, ""), fetch: (request) => fetch(request) }
}

beforeAll(async () => {
  fleet = await startFleet(
    {
      log: "off",
      services: {
        twilio: { port: 0 },
        resend: { port: 0 },
        // An alias: the harness learns it is FCM from the fleet, not from the name.
        push: { target: "fcm", port: 0 },
        sns: { port: 0 },
      },
    } as never,
    {
      load: createInstalledServiceLoader({
        projectRoot: import.meta.dir,
        services: ["twilio", "resend", "fcm", "sns"],
      }),
    },
  )
  dir = mkdtempSync(join(tmpdir(), "mockingbird-notifications-"))
  const manifestPath = join(dir, "ready.json")
  writeFileSync(manifestPath, JSON.stringify(fleet.manifest))
  byFleet = await createServer({ fleet: fleet.manifest.adminBase, pollIntervalMs: 100 })
  byManifest = await createServer({ manifest: manifestPath, pollIntervalMs: 0 })
})

afterAll(async () => {
  await byFleet?.close()
  await byManifest?.close()
  await fleet?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test("the harness reads the same fleet as the app, by controller URL or ready file", async () => {
  await send.twilioSms(url("twilio"), { to: "+12025550123", body: "Welcome to Acme" })
  await send.resendEmail(url("resend"), {
    from: "Acme <hi@acme.example>",
    to: ["ada@example.com"],
    subject: "Hello",
    text: "Hi Ada",
  })
  await send.fcmPush(url("push"), {
    token: "fixture-device-token",
    notification: { title: "Ping", body: "From the fleet" },
  })
  await send.snsSms(url("sns"), "+12025550166", "SNS hello")

  for (const server of [byFleet, byManifest]) {
    const client = new NotificationClient(server.url)
    const all = await client.waitFor({}, { count: 4, timeoutMs: 5_000 })
    expect(all.map((n) => `${n.source}/${n.service}/${n.channel}`).sort()).toEqual([
      "push/fcm/push",
      "resend/resend/email",
      "sns/sns/sms",
      "twilio/twilio/sms",
    ])
    expect((await client.sources()).every((s) => s.ok)).toBe(true)
  }
})

test("NotificationClient waits for a one-time code in a test's own namespace", async () => {
  const client = new NotificationClient(byFleet.url, { namespace: "worker-7" })
  const code = client.waitForCode("+12025550999", {}, 5_000)
  await send.twilioVerify(url("twilio"), "+12025550999", "worker-7")
  expect(await code).toMatch(/^\d{6}$/)
  expect(await new NotificationClient(byFleet.url).latest({ to: "+12025550999" })).toBeNull()
  expect(client.link({ channel: "sms", to: "+12025550999" })).toBe(
    `${byFleet.url}/?namespace=worker-7&view=sms&to=%2B12025550999`,
  )
})

test("with --fleet, every fleet namespace is followed in the background", async () => {
  const response = await fetch(`${fleet.manifest.adminBase}/namespaces/tenant-b`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  expect(response.ok).toBe(true)
  await send.twilioSms(url("twilio"), { to: "+12025550100", body: "tenant b" }, "tenant-b")
  const deadline = Date.now() + 5_000
  let namespaces: string[] = []
  while (Date.now() < deadline && !namespaces.includes("tenant-b")) {
    namespaces = (
      (await (await fetch(`${byFleet.url}/api/namespaces`)).json()) as { namespaces: string[] }
    ).namespaces
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(namespaces).toContain("tenant-b")
  const [found] = await byFleet.harness.list({ namespace: "tenant-b" })
  expect(found?.sms?.body).toBe("tenant b")
}, 15_000)
