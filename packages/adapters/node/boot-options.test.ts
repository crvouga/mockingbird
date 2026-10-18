import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRuntime,
  IdSequence,
  type InstanceContext,
  type ServiceInstance,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import {
  resolveServeIdBase,
  resolveServeSettings,
  type ServeTarget,
  serveCommand,
  startFleet,
} from "./src/index.js"

/** An emulator that issues the next `msg_` id on every POST and echoes the settings it booted with. */
const emulator = (name: string, settings?: Record<string, unknown>) =>
  createRuntime({
    name,
    create(context: InstanceContext): ServiceInstance {
      const ids = new IdSequence(context.sqlite, context.namespace, name)
      return {
        async reset() {},
        async fetch(request) {
          if (new URL(request.url).pathname === "/settings") return Response.json(settings ?? null)
          return Response.json({ id: ids.next("msg_") })
        },
      }
    },
  })

type Seen = { settings?: Record<string, unknown> }

const target = (name: string, seen: Seen[] = [], withSettings = true): ServeTarget => ({
  name,
  defaultPort: 0,
  ...(withSettings
    ? {
        parseSettings(settings) {
          if (typeof settings.workspace !== "string") throw new Error("workspace must be a string")
          return settings
        },
      }
    : {}),
  create: (_values, common) => {
    seen.push({ ...(common.settings !== undefined ? { settings: common.settings } : {}) })
    return emulator(name, common.settings)
  },
})

const issue = async (url: string, count: number): Promise<string[]> => {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const response = await fetch(`${url}/messages`, { method: "POST" })
    out.push(((await response.json()) as { id: string }).id)
  }
  return out
}

const bootFleet = async (config: Record<string, unknown>, seen: Seen[] = [], settings = true) =>
  startFleet(
    { log: "off", services: { sms: { port: 0 }, mail: { port: 0 } }, ...config } as never,
    { load: async (name) => target(name, seen, settings) },
  )

const urls = (fleet: Awaited<ReturnType<typeof bootFleet>>) =>
  Object.fromEntries(
    Object.entries(fleet.manifest.services).map(([name, endpoint]) => [name, endpoint.url]),
  )

test("a fleet idBase gives each boot its own ids, a service's own idBase replaces it", async () => {
  const run = async (config: Record<string, unknown>) => {
    const fleet = await bootFleet(config)
    try {
      const url = urls(fleet)
      return { sms: await issue(url.sms as string, 4), mail: await issue(url.mail as string, 4) }
    } finally {
      await fleet.close()
    }
  }
  const first = await run({})
  // The default is deterministic: a second boot reissues the first boot's ids.
  expect(await run({})).toEqual(first)
  const based = await run({ idBase: 1 })
  expect(based.sms.filter((id) => first.sms.includes(id))).toEqual([])
  expect(await run({ idBase: 1 })).toEqual(based)
  expect((await run({ idBase: 2 })).sms).not.toEqual(based.sms)
  // `sms` names its own base; `mail` takes the fleet's.
  const mixed = await run({
    idBase: 1,
    services: { sms: { port: 0, idBase: 2 }, mail: { port: 0 } },
  })
  expect(mixed.sms).toEqual((await run({ idBase: 2 })).sms)
  expect(mixed.mail).toEqual(based.mail)
  // "boot" is a clock-derived base, so it differs from the default ids.
  expect((await run({ idBase: "boot" })).sms).not.toEqual(first.sms)
})

test("a fleet refuses an unusable idBase before anything listens", async () => {
  await expect(bootFleet({ idBase: -1 })).rejects.toThrow(/idBase/)
  await expect(bootFleet({ services: { sms: { port: 0, idBase: "soon" } } })).rejects.toThrow(
    /service sms: .*idBase/,
  )
})

test("a fleet entry's settings reach the service as boot settings, checked by its schema", async () => {
  const seen: Seen[] = []
  const fleet = await bootFleet(
    { services: { sms: { port: 0, settings: { workspace: "ws_1" } }, mail: { port: 0 } } },
    seen,
  )
  try {
    const url = urls(fleet)
    expect(await (await fetch(`${url.sms}/settings`)).json()).toEqual({ workspace: "ws_1" })
    expect(await (await fetch(`${url.mail}/settings`)).json()).toBeNull()
  } finally {
    await fleet.close()
  }
  await expect(
    bootFleet({ services: { sms: { port: 0, settings: { workspace: 7 } } } }),
  ).rejects.toThrow(/service sms: settings: workspace must be a string/)
  // A service that declares no settings schema takes none.
  await expect(
    bootFleet({ services: { sms: { port: 0, settings: { workspace: "x" } } } }, [], false),
  ).rejects.toThrow(/sms takes no boot settings/)
})

test("serve reads --id-base and --settings (flag, environment or file) and checks them", async () => {
  expect(resolveServeIdBase({}, {})).toBeUndefined()
  expect(resolveServeIdBase({ "id-base": "12" }, {})).toBe("12")
  expect(resolveServeIdBase({}, { MOCKINGBIRD_ID_BASE: "boot" })).toBe("boot")
  expect(resolveServeIdBase({ "id-base": "3" }, { MOCKINGBIRD_ID_BASE: "9" })).toBe("3")
  expect(() => resolveServeIdBase({ "id-base": "-1" }, {})).toThrow(/--id-base/)
  expect(() => resolveServeIdBase({ "id-base": "later" }, {})).toThrow(/--id-base/)

  const t = target("sms")
  expect(await resolveServeSettings(t, {}, {})).toBeUndefined()
  expect(await resolveServeSettings(t, { settings: '{"workspace":"a"}' }, {})).toEqual({
    workspace: "a",
  })
  expect(await resolveServeSettings(t, {}, { MOCKINGBIRD_SETTINGS: '{"workspace":"b"}' })).toEqual({
    workspace: "b",
  })
  const rejected = (values: Record<string, string>, env = {}, on = t) =>
    resolveServeSettings(on, values, env).then(
      () => "accepted",
      (error: Error) => error.message,
    )
  expect(await rejected({ settings: "{" })).toBe("--settings: not valid JSON")
  expect(await rejected({ settings: "[1]" })).toBe("--settings: expected a JSON object")
  expect(await rejected({ settings: "/nonexistent/settings.json" })).toContain(
    "--settings: cannot read",
  )
  expect(await rejected({ settings: '{"workspace": 1}' })).toBe(
    "--settings: workspace must be a string",
  )
  expect(await rejected({}, { MOCKINGBIRD_SETTINGS: "{}" })).toBe(
    "MOCKINGBIRD_SETTINGS: workspace must be a string",
  )
  expect(await rejected({ settings: "{}" }, {}, target("sms", [], false))).toBe(
    "--settings: sms takes no boot settings",
  )
})

let log: ReturnType<typeof spyOn>
let error: ReturnType<typeof spyOn>
beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {})
  error = spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  log.mockRestore()
  error.mockRestore()
})

test("the serve command boots the service with the id base and settings it was given", async () => {
  const boot = async (values: Record<string, string>) => {
    const seen: Seen[] = []
    let runtime: ServiceRuntime<ServiceInstance> | undefined
    const served: ServeTarget = {
      ...target("sms", seen),
      create: (v, common) => {
        runtime = target("sms", seen).create(v, common) as ServiceRuntime<ServiceInstance>
        return runtime
      },
    }
    const done = serveCommand(served).run(
      { port: "0", log: "off", host: "127.0.0.1", ...values },
      [],
    )
    // Wait for the listener, then stop it the way an operator would.
    for (
      let i = 0;
      i < 200 && !log.mock.calls.some((c: unknown[]) => String(c[0]).includes("listening"));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    const line = String(
      log.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .findLast((l: string) => l.includes("listening on")),
    )
    const url = /listening on (\S+)/.exec(line)?.[1] as string
    try {
      return {
        seen,
        ids: await issue(url, 3),
        settings: await (await fetch(`${url}/settings`)).json(),
      }
    } finally {
      process.emit("SIGINT")
      expect(await done).toBe(0)
      log.mockClear()
    }
  }
  const plain = await boot({})
  expect(plain.settings).toBeNull()
  const based = await boot({ "id-base": "4", settings: '{"workspace":"ws_9"}' })
  expect(based.settings).toEqual({ workspace: "ws_9" })
  expect(based.ids.filter((id) => plain.ids.includes(id))).toEqual([])
  expect((await boot({ "id-base": "4" })).ids).toEqual(based.ids)

  // Bad values stop the command before a port is bound.
  const refused = await serveCommand(target("sms")).run(
    { port: "0", log: "off", settings: '{"workspace": 1}' },
    [],
  )
  expect(refused).toBe(1)
  expect(await serveCommand(target("sms")).run({ port: "0", log: "off", "id-base": "x" }, [])).toBe(
    1,
  )
})

test("serve --config refuses --settings, which belongs to one service's schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockingbird-boot-"))
  try {
    const config = join(dir, "mockingbird.json")
    await writeFile(config, JSON.stringify({ services: { sms: { port: 0 } } }))
    expect(
      await serveCommand(target("sms")).run(
        { config, log: "off", settings: '{"workspace":"a"}' },
        [],
      ),
    ).toBe(1)
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("--settings serves a single service")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
