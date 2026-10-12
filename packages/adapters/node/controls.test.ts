import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Collection, createRuntime, type MockControls } from "@crvouga/mockingbird-service"
import { resolveServeControls, type ServeTarget } from "./src/cli.js"
import { startFleet } from "./src/fleet.js"
import { listen } from "./src/listen.js"

const T0 = Date.parse("2030-01-01T00:00:00.000Z")

const runtimeWith = (adminControls?: MockControls, name = "fixture") =>
  createRuntime({
    name,
    ...(adminControls !== undefined ? { adminControls } : {}),
    create(context) {
      const things = new Collection<{ at: number }>(context.sqlite, context.namespace, "things")
      return {
        async reset() {
          for (const row of things.list()) things.delete(row.id)
        },
        async fetch(request) {
          if (new URL(request.url).pathname === "/essay") return new Response("x".repeat(50_000))
          if (request.method === "POST")
            things.insert(String(things.count() + 1), { at: context.clock.now() })
          return Response.json(things.list({ order: "oldest" }).map((row) => row.value))
        },
      }
    },
  })

test("serve flags, the environment and a file build one control document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mockingbird-controls-"))
  try {
    expect(await resolveServeControls({}, {})).toBeUndefined()

    expect(
      await resolveServeControls(
        {
          clock: "2030-01-01T00:00:00Z",
          freeze: true,
          "auto-advance": "1s",
          latency: "40ms",
          jitter: "10ms",
          "virtual-time": true,
          fault: "status=503; delay=2s",
        },
        {},
      ),
    ).toEqual({
      clock: { now: "2030-01-01T00:00:00Z", frozen: true, autoAdvance: "1s" },
      latency: { delay: "40ms", jitter: "10ms" },
      virtualTime: true,
      faults: [{ status: 503, delay: "2s" }],
    })

    // The environment carries the whole document; a flag overrides the part it names.
    const env = {
      MOCKINGBIRD_ADMIN_CONTROLS: JSON.stringify({
        latency: "5ms",
        clock: { now: T0, frozen: true },
        faults: [{ preset: "slow" }],
      }),
    }
    expect(await resolveServeControls({ latency: "80ms", fault: "rate_limited" }, env)).toEqual({
      latency: { delay: "80ms" },
      clock: { now: T0, frozen: true },
      faults: [{ preset: "slow" }, { preset: "rate_limited" }],
    })

    // --admin-controls and --snapshot read files.
    const snapshot = {
      format: "mockingbird.snapshot/v1",
      records: [{ collection: "things", id: "1", value: { at: 1 } }],
    }
    await writeFile(join(dir, "controls.json"), JSON.stringify({ seed: 7, virtualTime: true }))
    await writeFile(join(dir, "snapshot.json"), JSON.stringify(snapshot))
    expect(
      await resolveServeControls(
        {
          "admin-controls": join(dir, "controls.json"),
          snapshot: join(dir, "snapshot.json"),
        },
        env,
      ),
    ).toEqual({ seed: 7, virtualTime: true, snapshot } as never)

    // A value that cannot be read stops the command before anything listens.
    const rejected = async (values: Record<string, string | boolean>) =>
      resolveServeControls(values, {}).then(
        () => "accepted",
        (error: Error) => error.message,
      )
    expect(await rejected({ clock: "soon" })).toContain("adminControls.clock.now")
    expect(await rejected({ latency: "fast" })).toContain("adminControls.latency.delay")
    expect(await rejected({ fault: "speed=9" })).toContain("--fault: unknown key")
    expect(await rejected({ "admin-controls": "{" })).toBe("--admin-controls: not valid JSON")
    expect(await rejected({ "admin-controls": join(dir, "missing.json") })).toContain(
      "--admin-controls: cannot read",
    )
    expect(await rejected({ "admin-controls": '{"tempo": 1}' })).toContain(
      'unknown control "tempo"',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a served mock drops the socket for a timeout, a drop and a truncated body", async () => {
  const runtime = runtimeWith({ virtualTime: true })
  const server = await listen(runtime)
  try {
    // POST for the probes that die: a client may quietly retry an idempotent GET.
    const call = (path: string, headers: Record<string, string> = {}, method = "GET") =>
      fetch(`${server.url}${path}`, { method, headers })
    expect((await call("/things")).status).toBe(200)

    // Virtual time: thirty seconds pass on the mock clock, none on the wall clock.
    const started = performance.now()
    const before = runtime.namespaceClock().now()
    expect(
      await call("/things", { "x-mockingbird-timeout": "30s" }, "POST").catch(() => "dropped"),
    ).toBe("dropped")
    expect(performance.now() - started).toBeLessThan(5000)
    expect(runtime.namespaceClock().now() - before).toBeGreaterThanOrEqual(30_000)

    expect(
      await call("/things", { "x-mockingbird-fault": "drop" }, "POST").catch(() => "dropped"),
    ).toBe("dropped")

    const cut = await call("/essay", { "x-mockingbird-fault": "truncate=100" })
    expect(cut.status).toBe(200)
    expect(await cut.text().catch(() => "cut off")).toBe("cut off")

    // The server is still serving, and the journal shows what each request met.
    expect((await call("/things")).status).toBe(200)
    const journal = (await (await call("/__admin/requests")).json()) as {
      requests: { status: number; faultId?: string }[]
    }
    expect(journal.requests.map((entry) => [entry.status, entry.faultId ?? null])).toEqual([
      [200, null],
      [0, "request"],
      [0, "request"],
      [200, "request"],
      [200, null],
    ])
  } finally {
    await server.close()
  }
})

test("a real wait ends when the client gives up, without taking the server down", async () => {
  const runtime = runtimeWith()
  const server = await listen(runtime)
  try {
    const held = await fetch(`${server.url}/things`, {
      headers: { "x-mockingbird-timeout": "60s" },
      signal: AbortSignal.timeout(100),
    }).catch((error: Error) => error.name)
    expect(held).toBe("TimeoutError")
    // The held request is released (journaled as status 0) rather than left hanging.
    for (let i = 0; i < 100 && runtime.journal.list().length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runtime.journal.list().map((entry) => entry.status)).toEqual([0])
    expect((await fetch(`${server.url}/things`)).status).toBe(200)
  } finally {
    await server.close()
  }
})

test("a fleet boots every HTTP service with its controls, and names a bad document", async () => {
  const target = (name: string): ServeTarget => ({
    name,
    defaultPort: 0,
    create: (_values, common) => runtimeWith(common.adminControls, name),
  })
  const fleet = await startFleet(
    {
      log: "off",
      adminControls: { clock: { now: T0, frozen: true }, latency: "5ms" },
      services: {
        first: { port: 0 },
        second: { port: 0, adminControls: { latency: "50ms", virtualTime: true } },
      },
    },
    { load: async (name) => target(name) },
  )
  try {
    const controls = async (name: string) =>
      (await (await fetch(`${fleet.manifest.services[name]?.adminUrl}/controls`)).json()) as {
        clock: { now: number; frozen: boolean }
        latency: { delayMs: number }
        virtualTime: boolean
      }
    expect(await controls("first")).toMatchObject({
      clock: { now: T0, frozen: true },
      latency: { delayMs: 5 },
      virtualTime: false,
    })
    // The service's own keys replace the fleet's; the rest still apply.
    expect(await controls("second")).toMatchObject({
      clock: { now: T0, frozen: true },
      latency: { delayMs: 50 },
      virtualTime: true,
    })
  } finally {
    await fleet.close()
  }

  const bad = startFleet(
    { log: "off", services: { first: { port: 0, adminControls: { latency: "fast" } } } },
    { load: async (name) => target(name) },
  )
  expect(
    await bad.then(
      () => "started",
      (error: Error) => error.message,
    ),
  ).toContain("services.first.adminControls.latency: expected milliseconds")
})

/** Run a real service CLI and hand back its address once it says it is listening. */
const serve = async (args: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "../../service/tavily/src/cli.ts"),
      "serve",
      "--port",
      "0",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } },
  )
  const reader = child.stdout.getReader()
  let output = ""
  let url: string | undefined
  while (url === undefined) {
    const { done, value } = await reader.read()
    if (done) break
    output += new TextDecoder().decode(value)
    url = /listening on (http:\/\/\S+)/.exec(output)?.[1]
  }
  reader.releaseLock()
  return {
    url,
    async stop() {
      child.kill("SIGTERM")
      return { code: await child.exited, stderr: await new Response(child.stderr).text() }
    },
  }
}

test("a served CLI boots with the controls its flags and environment name", async () => {
  const server = await serve(
    ["--seed", "7", "--clock", "2030-01-01T00:00:00Z", "--freeze", "--auto-advance", "1s"].concat([
      "--latency",
      "40ms",
      "--virtual-time",
      "--fault",
      "rate_limited",
      "--log",
      "off",
    ]),
    { MOCKINGBIRD_ADMIN_CONTROLS: JSON.stringify({ namespaces: { tenant: { latency: "5ms" } } }) },
  )
  try {
    expect(server.url).toBeDefined()
    const controls = async (namespace = "default") =>
      (await fetch(`${server.url}/__admin/controls?namespace=${namespace}`)).json()
    expect(await controls()).toMatchObject({
      seed: 7,
      clock: { now: T0, frozen: true, autoAdvanceMs: 1000 },
      virtualTime: true,
      latency: { delayMs: 40 },
      faults: [{ id: "rate_limited", status: 429 }],
    })
    expect(await controls("tenant")).toMatchObject({ seed: 7, latency: { delayMs: 5 } })

    // The fault it booted with answers, and a header on the next request overrides nothing stored.
    const limited = await fetch(`${server.url}/search`, { method: "POST" })
    expect([limited.status, limited.headers.get("x-mockingbird-fault")]).toEqual([
      429,
      "rate_limited",
    ])
    const scripted = await fetch(`${server.url}/search`, {
      method: "POST",
      headers: { "x-mockingbird-namespace": "w", "x-mockingbird-fault": "503" },
    })
    expect(scripted.status).toBe(503)
    // One second of auto-advance and 40ms of virtual latency for the one request `default` took.
    expect(await controls()).toMatchObject({ clock: { now: T0 + 1040 }, faults: [{ hits: 1 }] })
    await fetch(`${server.url}/__admin/reset`, { method: "POST" })
    expect(await controls()).toMatchObject({ clock: { now: T0 }, faults: [{ hits: 0 }] })
  } finally {
    expect((await server.stop()).code).toBe(0)
  }
})

test("a served CLI refuses to start on a control it cannot read", async () => {
  for (const [args, message] of [
    [["--clock", "soon"], "adminControls.clock.now"],
    [["--fault", "speed=9"], "--fault: unknown key"],
    [["--admin-controls", '{"faults":[{"statuss":500}]}'], 'unknown field "statuss"'],
    [["--admin-controls", '{"faults":[{"preset":"nope"}]}'], "no fault preset"],
  ] as const) {
    const server = await serve([...args])
    const { code, stderr } = await server.stop()
    expect([args.join(" "), server.url, code === 0]).toEqual([args.join(" "), undefined, false])
    expect(stderr).toContain(message)
  }
})
