import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { STANDARD_ADMIN_ROUTES } from "@crvouga/mockingbird-service"

const servicesRoot = join(import.meta.dir, "..")
const skip = new Set(["core", "sqlite", "postgres", "conformance"])

/** HTTP mocks are the service packages whose public entry exports `createRuntime`. */
const httpMocks = (): string[] =>
  readdirSync(servicesRoot)
    .filter((name) => {
      if (skip.has(name)) return false
      const indexPath = join(servicesRoot, name, "src", "index.ts")
      if (!existsSync(indexPath)) return false
      return /\bcreateRuntime\b/.test(readFileSync(indexPath, "utf8"))
    })
    .sort()

const surface = readFileSync(join(import.meta.dir, "src", "surface.ts"), "utf8")

describe("surface", () => {
  test("every HTTP mock is named in the type proof", () => {
    const missing = httpMocks().filter(
      (name) => !surface.includes(`@crvouga/mockingbird-service-${name}`),
    )
    expect(missing).toEqual([])
  })
})

const call = async (
  runtime: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-mockingbird-admin-key": "conformance-fixture-admin",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )

for (const adminPrefix of ["/__admin", "/_control/mock"])
  test(
    `every HTTP mock serves the shared admin API at ${adminPrefix}`,
    async () => {
      const failures: string[] = []
      for (const name of httpMocks()) {
        const mod = (await import(`../${name}/src/index.ts`)) as {
          createRuntime: (options?: { seed?: number; adminPrefix?: string; adminKey?: string }) => {
            fetch(request: Request): Promise<Response>
            state(namespace?: string): { collections: unknown[] }
            stop?: () => void
          }
        }
        let runtime: ReturnType<typeof mod.createRuntime> | undefined
        try {
          runtime = mod.createRuntime({
            seed: 1,
            adminPrefix,
            adminKey: "conformance-fixture-admin",
          })
          const health = await call(runtime, "GET", `${adminPrefix}/health`)
          if (health.status !== 200) failures.push(`${name}: health ${health.status}`)
          const healthBody = (await health.json()) as { adminUi?: string }
          if (healthBody.adminUi !== `${adminPrefix}/ui`) failures.push(`${name}: health.adminUi`)

          const listed = (
            (await (await call(runtime, "GET", adminPrefix)).json()) as { routes?: string[] }
          ).routes
          for (const route of STANDARD_ADMIN_ROUTES) {
            if (!listed?.includes(route)) failures.push(`${name}: missing ${route}`)
          }

          const ui = await call(runtime, "GET", `${adminPrefix}/ui`)
          const html = await ui.text()
          if (ui.status !== 200 || !html.includes("data-mockingbird-admin")) {
            failures.push(`${name}: admin ui`)
          }

          const created = await call(runtime, "POST", `${adminPrefix}/state/conformance_probe`, {
            id: "probe",
            value: { ok: true },
          })
          if (created.status !== 201) failures.push(`${name}: create ${created.status}`)
          const page = (await (
            await call(runtime, "GET", `${adminPrefix}/state/conformance_probe`)
          ).json()) as { records?: { id: string }[] }
          if (!page.records?.some((row) => row.id === "probe")) failures.push(`${name}: list`)
          const removed = await call(
            runtime,
            "DELETE",
            `${adminPrefix}/state/conformance_probe/probe`,
          )
          if (removed.status !== 200) failures.push(`${name}: delete ${removed.status}`)
          if (!Array.isArray(runtime.state().collections)) failures.push(`${name}: state()`)
        } catch (error) {
          failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          runtime?.stop?.()
        }
      }
      expect(failures).toEqual([])
    },
    { timeout: 180_000 },
  )

const KEY = "conformance-fixture-admin"
const T0 = Date.parse("2030-01-01T00:00:00.000Z")
const bootControls = {
  clock: { now: T0, frozen: true },
  latency: "5ms",
  virtualTime: true,
  faults: [{ id: "probe", pathPrefix: "/conformance-fault-probe", status: 503 }],
}

type ControlsBody = {
  clock?: { now?: number; frozen?: boolean }
  latency?: { delayMs?: number }
  virtualTime?: boolean
  faults?: { id: string }[]
  snapshots?: unknown[]
}

type ControlledMock = {
  fetch(request: Request): Promise<Response>
  stop?: () => void
}

const loadMock = async (name: string) =>
  (await import(`../${name}/src/index.ts`)) as {
    createRuntime: (options?: {
      seed?: number
      adminKey?: string
      adminControls?: typeof bootControls
    }) => ControlledMock
  }

const sendTo = (
  runtime: ControlledMock,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
) =>
  runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: { "content-type": "application/json", "x-mockingbird-admin-key": KEY, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )

test(
  "every HTTP mock takes the same admin controls at boot, over /__admin, and in request headers",
  async () => {
    const failures: string[] = []
    for (const name of httpMocks()) {
      let runtime: ControlledMock | undefined
      const expectThat = (label: string, ok: boolean) => {
        if (!ok) failures.push(`${name}: ${label}`)
      }
      try {
        const mod = await loadMock(name)
        runtime = mod.createRuntime({ seed: 1, adminKey: KEY, adminControls: bootControls })
        const controls = async (namespace?: string) =>
          (await (
            await sendTo(
              runtime as ControlledMock,
              "GET",
              `/__admin/controls${namespace ? `?namespace=${namespace}` : ""}`,
            )
          ).json()) as ControlsBody

        // Boot.
        const booted = await controls()
        expectThat("boot clock", booted.clock?.now === T0 && booted.clock?.frozen === true)
        expectThat("boot latency", booted.latency?.delayMs === 5)
        expectThat("boot virtual time", booted.virtualTime === true)
        expectThat("boot fault", booted.faults?.map((fault) => fault.id).join() === "probe")
        const faulted = await sendTo(runtime, "GET", "/conformance-fault-probe/x")
        expectThat(
          `boot fault fires (${faulted.status})`,
          faulted.status === 503 && faulted.headers.get("x-mockingbird-fault") === "probe",
        )

        // Request headers, in a namespace of their own.
        const scripted = await sendTo(runtime, "GET", "/conformance-header-probe", {
          "x-mockingbird-namespace": "conformance",
          "x-mockingbird-time": "2031-06-01T00:00:00Z",
          "x-mockingbird-fault": "418",
        })
        expectThat(`header fault (${scripted.status})`, scripted.status === 418)
        expectThat(
          "header time is per namespace",
          // The pinned instant, plus this request's 5ms of virtual latency.
          (await controls("conformance")).clock?.now === Date.parse("2031-06-01T00:00:00Z") + 5 &&
            (await controls()).clock?.now === T0 + 5,
        )
        const unkeyed = await runtime.fetch(
          new Request("http://mock.local/conformance-header-probe", {
            headers: { "x-mockingbird-fault": "418" },
          }),
        )
        expectThat(`control headers need the admin key (${unkeyed.status})`, unkeyed.status === 401)
        const malformed = await sendTo(runtime, "GET", "/conformance-header-probe", {
          "x-mockingbird-delay": "soon",
        })
        expectThat(`a bad control header is a 400 (${malformed.status})`, malformed.status === 400)

        // The admin API.
        await sendTo(runtime, "PUT", "/__admin/latency", {}, { delay: "2s" })
        await sendTo(runtime, "POST", "/__admin/faults", {}, { preset: "rate_limited" })
        await sendTo(runtime, "POST", "/__admin/clock", {}, { advance: "1h" })
        const snapshot = await sendTo(runtime, "POST", "/__admin/snapshots", {}, { name: "taken" })
        expectThat(`snapshot (${snapshot.status})`, snapshot.status === 201)
        const exported = (await (
          await sendTo(runtime, "GET", "/__admin/snapshots/taken")
        ).json()) as { format?: string; service?: string }
        expectThat("snapshot exports", exported.format === "mockingbird.snapshot/v1")
        const changed = await controls()
        await sendTo(runtime, "DELETE", "/__admin/controls")
        expectThat("DELETE /controls returns to boot", (await controls()).latency?.delayMs === 5)
        const restored = await sendTo(runtime, "POST", "/__admin/snapshots/taken/restore")
        expectThat(`restore (${restored.status})`, restored.status === 200)
        expectThat(
          "restore brings the controls back",
          JSON.stringify(await controls()) === JSON.stringify(changed),
        )

        // Reset is the boot state again, exactly.
        const reset = await sendTo(runtime, "POST", "/__admin/reset")
        expectThat(`reset (${reset.status})`, reset.status === 200)
        // The fault's counters moved when it fired; everything else matches boot.
        const after = await controls()
        expectThat(
          "reset returns the controls to boot",
          JSON.stringify({ ...after, faults: [] }) === JSON.stringify({ ...booted, faults: [] }) &&
            after.faults?.length === 1 &&
            after.snapshots?.length === 0,
        )
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        runtime?.stop?.()
      }
    }
    expect(failures).toEqual([])
  },
  { timeout: 300_000 },
)

/**
 * Mocks whose boot state holds real key material, which comes from the platform's CSPRNG by
 * design and is pinned with a fixture (`vaultKey`), never with the seed.
 */
const CRYPTOGRAPHIC_BOOT_STATE: Record<string, string> = {
  infisical: "seals its seeded secrets and tokens with a random vault key and nonces",
}

test(
  "every HTTP mock boots into the same state from the same seed and clock",
  async () => {
    const failures: string[] = []
    for (const name of httpMocks()) {
      if (CRYPTOGRAPHIC_BOOT_STATE[name]) continue
      const made: ControlledMock[] = []
      try {
        const mod = await loadMock(name)
        const fingerprint = async () => {
          const runtime = mod.createRuntime({ seed: 1, adminKey: KEY, adminControls: bootControls })
          made.push(runtime)
          const snapshot = await sendTo(runtime, "POST", "/__admin/snapshots", {}, { name: "boot" })
          if (snapshot.status !== 201) return `snapshot ${snapshot.status}`
          return (await sendTo(runtime, "GET", "/__admin/snapshots/boot")).text()
        }
        const first = await fingerprint()
        const second = await fingerprint()
        if (first !== second) failures.push(name)
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        for (const runtime of made) runtime.stop?.()
      }
    }
    expect(failures).toEqual([])
  },
  { timeout: 300_000 },
)
