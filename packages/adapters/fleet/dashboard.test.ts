import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInstalledServiceLoader, fleetDashboard, startFleet } from "./src/index.js"

const ACCOUNT = "AC00000000000000000000000000000000"
const base = (url: string) => url.replace(/\/+$/, "")

/** An SMS through the Twilio emulator, as an application would send it. */
const sendSms = async (twilio: string, to: string, body: string) => {
  const response = await fetch(`${base(twilio)}/api/2010-04-01/Accounts/${ACCOUNT}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${ACCOUNT}:fixture-token`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: "+15005550006", Body: body }),
  })
  expect(response.status).toBeLessThan(300)
}

type AdminInfo = {
  admin: { apis: { id: string; service: string; adminPrefix: string }[] } | null
  emulators: { name: string; target: string }[]
  fleet: { adminBase: string; consoleUrl: string } | null
}
type Listing = { notifications: { channel: string; to: { value: string }[]; text: string }[] }

/** The dashboard is one page over the whole fleet: assert it the way a browser would use it. */
const expectDashboard = async (dashboard: string, twilio: string, key?: string) => {
  const url = base(dashboard)
  const page = await fetch(`${url}/`)
  expect(page.headers.get("content-type")).toStartWith("text/html")
  expect(await page.text()).toContain('data-default-tab="emulators"')
  expect((await fetch(`${url}/admin/ui.js`)).headers.get("content-type")).toStartWith(
    "text/javascript",
  )

  const info = (await (await fetch(`${url}/api/admin`)).json()) as AdminInfo
  // Every HTTP emulator, not only the ones that send messages.
  expect(info.emulators).toEqual([
    expect.objectContaining({ name: "identity", target: "cognito" }),
    expect.objectContaining({ name: "twilio", target: "twilio" }),
  ])
  expect(info.admin?.apis.map((api) => api.adminPrefix)).toEqual([
    "/admin/apis/identity",
    "/admin/apis/twilio",
  ])
  expect(info.fleet?.consoleUrl).toEndWith("/__admin/ui")

  // Each emulator's admin API, same origin, with the fleet's key added by the dashboard.
  for (const [id, service] of [
    ["identity", "cognito"],
    ["twilio", "twilio"],
  ]) {
    const health = await fetch(`${url}/admin/apis/${id}/health`)
    expect(health.status).toBe(200)
    expect(((await health.json()) as { service: string }).service).toBe(service as string)
    expect((await fetch(`${url}/admin/apis/${id}/ui/manifest`)).status).toBe(200)
  }
  if (key) {
    const direct = info.emulators.find((entry) => entry.name === "twilio") as { adminUrl?: string }
    expect((await fetch(`${direct.adminUrl}/ui/manifest`)).status).toBe(401)
  }

  await sendSms(twilio, "+12025550142", "Your table is ready")
  const listing = (await (
    await fetch(`${url}/api/notifications?to=${encodeURIComponent("+12025550142")}`)
  ).json()) as Listing
  expect(listing.notifications).toHaveLength(1)
  expect(listing.notifications[0]?.channel).toBe("sms")

  // A write through the gateway: reset the emulator, and the message is gone.
  const reset = await fetch(`${url}/admin/apis/twilio/reset`, { method: "POST" })
  expect(reset.status).toBeLessThan(300)
}

const services = {
  identity: { target: "cognito", port: 0 },
  twilio: { port: 0 },
}
const load = createInstalledServiceLoader({
  projectRoot: import.meta.dir,
  services: ["cognito", "twilio"],
})
const refuses = async (url: string) =>
  fetch(url).then(
    () => false,
    () => true,
  )

describe("startFleet with a dashboard", () => {
  test("one call starts the fleet and its dashboard, and closes both", async () => {
    const fleet = await startFleet(
      { log: "off", adminKey: "fixture-admin-key", services },
      { load, dashboard: { port: 0 } },
    )
    try {
      const dashboard = fleet.manifest.dashboard as string
      expect(dashboard).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)
      await expectDashboard(
        dashboard,
        fleet.manifest.services.twilio?.url as string,
        "fixture-admin-key",
      )
      const consolePage = await fetch(fleet.manifest.adminBase.replace(/\/fleet$/, "/ui"), {
        headers: { "x-mockingbird-admin-key": "fixture-admin-key" },
      })
      expect(await consolePage.text()).toContain(`href="${dashboard}"`)
    } finally {
      await fleet.close()
    }
    expect(await refuses(fleet.manifest.dashboard as string)).toBe(true)
  })

  test("the configuration turns it on, and startFleet's option turns it off", async () => {
    const config = { log: "off" as const, dashboard: { port: 0 }, services }
    const on = await startFleet(config, { load })
    expect(on.manifest.dashboard).toBeDefined()
    await on.close()
    const off = await startFleet(config, { load, dashboard: false })
    expect(off.manifest.dashboard).toBeUndefined()
    const consolePage = await fetch(off.manifest.adminBase.replace(/\/fleet$/, "/ui"))
    expect(await consolePage.text()).not.toContain('id="dashboard"')
    await off.close()
  })

  test("a taken port fails startup with what to change, and leaves nothing running", async () => {
    const first = await startFleet({ log: "off", services }, { load, dashboard: { port: 0 } })
    const port = Number(new URL(first.manifest.dashboard as string).port)
    try {
      await expect(
        startFleet({ log: "off", services }, { load, dashboard: fleetDashboard({ port }) }),
      ).rejects.toThrow(`dashboard: port ${port} is in use`)
    } finally {
      await first.close()
    }
  })

  test("the configuration is checked before anything starts", async () => {
    await expect(
      startFleet({ log: "off", dashboard: { port: 70000 }, services }, { load }),
    ).rejects.toThrow("dashboard.port")
    await expect(
      startFleet({ log: "off", dashboard: { path: "/x" }, services } as never, { load }),
    ).rejects.toThrow("dashboard.path: unknown key")
  })
})

describe("mockingbird-fleet serve --dashboard", () => {
  let dir = ""
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mockingbird-fleet-dashboard-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const serve = async (extra: string[], config: Record<string, unknown>) => {
    const configPath = join(dir, `mockingbird-${extra.length}.json`)
    await writeFile(configPath, JSON.stringify(config))
    const child = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "dist/cli.js"),
        "serve",
        "--config",
        configPath,
        "--project-root",
        import.meta.dir,
        ...extra,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let out = ""
    const until = async (done: (text: string) => boolean) => {
      const deadline = Date.now() + 20000
      while (!done(out)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for the fleet: ${out}`)
        const next = await reader.read()
        if (next.done) throw new Error(`fleet exited: ${await new Response(child.stderr).text()}`)
        out += decoder.decode(next.value)
      }
      return out
    }
    const stop = async () => {
      reader.releaseLock()
      child.kill("SIGTERM")
      return child.exited
    }
    return { until, stop }
  }

  test("prints the dashboard URL and puts it in the ready file", async () => {
    const readyFile = join(dir, "ready.json")
    const fleet = await serve(["--dashboard-port", "0", "--ready-file", readyFile], {
      log: "off",
      services,
    })
    let dashboard = ""
    try {
      const out = await fleet.until((text) => /dashboard:\s+http\S+\n/.test(text))
      expect(out).toMatch(/fleet ready: http\S+\/__admin\/fleet\n/)
      dashboard = /dashboard:\s+(http\S+)/.exec(out)?.[1] ?? ""
      const manifest = JSON.parse(await readFile(readyFile, "utf8")) as {
        dashboard: string
        services: Record<string, { url: string }>
      }
      expect(manifest.dashboard).toBe(dashboard)
      await expectDashboard(dashboard, manifest.services.twilio?.url as string)
    } finally {
      expect(await fleet.stop()).toBe(0)
    }
    expect(await refuses(dashboard)).toBe(true)
  }, 30000)

  test("--ready-json carries it, from the configuration alone", async () => {
    const fleet = await serve(["--ready-json"], {
      log: "off",
      dashboard: { port: 0 },
      services,
    })
    try {
      const out = await fleet.until((text) => text.includes("\n"))
      const manifest = JSON.parse(out.trim()) as { dashboard: string }
      expect((await fetch(`${base(manifest.dashboard)}/api/health`)).status).toBe(200)
    } finally {
      expect(await fleet.stop()).toBe(0)
    }
  }, 30000)
})
