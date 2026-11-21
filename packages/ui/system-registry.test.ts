import { describe, expect, test } from "bun:test"
import {
  defineSystem,
  type PreviewApp,
  type PreviewAppModule,
  type PreviewLoadManifestLike,
  PreviewRegistryError,
  planPartUpdate,
  systemSurfaces,
} from "./src/system-registry.js"
import { INCLUDED_KEY, initialExcluded, ROTATION_KEY, setRotation } from "./src/system-rotation.js"
import { matchRoute, normalizeRoute, routeOwns } from "./src/system-routes.js"

/** The registry fixture: three apps, as the issue's example project declares them. */
const APPS: PreviewApp[] = [
  {
    id: "member",
    label: "Member web",
    route: "/",
    part: { entry: "./parts/member.js" },
    backends: ["api", "stripe"],
  },
  {
    id: "clinician",
    label: "Clinician web",
    route: "/clinician/",
    part: { entry: "./parts/clinician.js", prefetch: true },
    backends: ["api"],
  },
  {
    id: "partner",
    label: "Partner portal",
    route: "/partner",
    defaultEnabled: false,
    mount: "iframe",
    part: { entry: "./parts/partner.html" },
    backends: ["partner-api"],
  },
]
const BACKENDS = [
  { id: "api", label: "API", kind: "backend" as const },
  { id: "partner-api", label: "Partner API", kind: "backend" as const },
  { id: "stripe", label: "Stripe", kind: "emulator" as const },
]

const memory = () => {
  const values = new Map<string, string>()
  return {
    values,
    store: () => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }),
  }
}

const rejects = (apps: PreviewApp[], code: string, pattern: RegExp, backends = BACKENDS) => {
  let error: unknown
  try {
    defineSystem({ apps, backends })
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(PreviewRegistryError)
  expect((error as PreviewRegistryError).code).toBe(code as PreviewRegistryError["code"])
  expect((error as Error).message).toMatch(pattern)
}

describe("#841 app registry", () => {
  test("1. a declared app is derived into the switcher, the System screen, routes and the build", () => {
    const system = defineSystem({ apps: APPS, backends: BACKENDS })
    const { surfaces } = systemSurfaces(system)
    expect(surfaces.map((surface) => surface.id)).toEqual(["member", "clinician", "partner"])
    expect(surfaces[1]).toMatchObject({ label: "Clinician web", route: "/clinician" })
    expect(system.route("/clinician/patients/7")?.id).toBe("clinician")
    expect(system.route("/partner")?.id).toBe("partner")
    expect(system.route("/partners")?.id).toBe("member")
    expect(system.parts()).toEqual([
      {
        id: "member",
        mount: "inline",
        entry: "./parts/member.js",
        route: "/",
        backends: ["api", "stripe"],
        prefetch: false,
      },
      {
        id: "clinician",
        mount: "inline",
        entry: "./parts/clinician.js",
        route: "/clinician",
        backends: ["api"],
        prefetch: true,
      },
      {
        id: "partner",
        mount: "iframe",
        entry: "./parts/partner.html",
        route: "/partner",
        backends: ["partner-api"],
        prefetch: false,
      },
    ])
    // One more declaration is all a fourth app takes.
    const grown = defineSystem({
      apps: [
        ...APPS,
        { id: "inbox", label: "Notifications", route: "/inbox", part: { source: "src/inbox.ts" } },
      ],
      backends: BACKENDS,
    })
    expect(systemSurfaces(grown).surfaces.map((surface) => surface.id)).toContain("inbox")
    expect(grown.route("/inbox/42")?.id).toBe("inbox")
    expect(grown.parts().at(-1)).toMatchObject({ id: "inbox", source: "src/inbox.ts" })
  })

  test("2. defaultEnabled: false stays out of the switcher until switched on, per browser", () => {
    const { store, values } = memory()
    const off = ["partner"]
    const first = initialExcluded(store, off)
    expect([...first.excluded]).toEqual(["partner"])
    setRotation(store, first, off, "partner", true)
    expect(values.get(INCLUDED_KEY)).toBe('["partner"]')
    expect(values.get(ROTATION_KEY)).toBe("[]")
    // The next visit in this browser keeps it on.
    expect([...initialExcluded(store, off).excluded]).toEqual([])
    const again = initialExcluded(store, off)
    setRotation(store, again, off, "partner", false)
    setRotation(store, again, off, "member", false)
    expect([...initialExcluded(store, off).excluded].sort()).toEqual(["member", "partner"])
    // A fresh browser starts with it off again.
    expect([...initialExcluded(memory().store, off).excluded]).toEqual(["partner"])
  })

  test("3. routes: a deep link opens the app that owns the path, the longest route winning", () => {
    expect(normalizeRoute("/clinician/")).toBe("/clinician")
    expect(normalizeRoute("/")).toBe("/")
    expect(() => normalizeRoute("clinician")).toThrow(/Invalid route/)
    expect(() => normalizeRoute("/a?b")).toThrow(/Invalid route/)
    expect(routeOwns("/partner", "/partner/x")).toBe(true)
    expect(routeOwns("/partner", "/partnerx")).toBe(false)
    const routes = [
      { id: "member", route: "/" },
      { id: "clinician", route: "/clinician" },
      { id: "admin", route: "/clinician/admin" },
      { id: "emulators" },
    ]
    expect(matchRoute(routes, "/clinician/admin/users")).toBe("admin")
    expect(matchRoute(routes, "/clinician/patients")).toBe("clinician")
    expect(matchRoute(routes, "/settings")).toBe("member")
    expect(matchRoute(routes.slice(1), "/settings")).toBeUndefined()
  })

  test("4. the System screen's dependency view: which apps call which backends and emulators", () => {
    const system = defineSystem({ apps: APPS, backends: BACKENDS })
    expect(system.dependents()).toEqual([
      { id: "api", label: "API", kind: "backend", apps: ["member", "clinician"] },
      { id: "partner-api", label: "Partner API", kind: "backend", apps: ["partner"] },
      { id: "stripe", label: "Stripe", kind: "emulator", apps: ["member"] },
    ])
    rejects(
      [{ ...(APPS[0] as PreviewApp), backends: ["api", "stirpe"] }],
      "unknown_backend",
      /"member" calls "stirpe"/,
    )
    // Without a backends list, named ids are declared implicitly.
    expect(defineSystem({ apps: APPS }).backends.map((backend) => backend.id)).toEqual([
      "api",
      "stripe",
      "partner-api",
    ])
  })

  test("5. two apps declaring the same route are rejected with a clear error", () => {
    rejects(
      [
        { id: "a", label: "A", route: "/portal", part: { entry: "./a.js" } },
        { id: "b", label: "B", route: "/portal/", part: { entry: "./b.js" } },
      ],
      "route_conflict",
      /Apps "a" and "b" both declare the route "\/portal"/,
    )
    rejects(
      [{ id: "a", label: "A", route: "portal", part: { entry: "./a.js" } }],
      "invalid_route",
      /App "a": Invalid route/,
    )
    rejects([{ ...(APPS[0] as PreviewApp), id: "system" }], "reserved_app", /System screen/)
    rejects([APPS[0] as PreviewApp, APPS[0] as PreviewApp], "duplicate_app", /"member"/)
    rejects(
      [{ id: "a", label: "A", part: {} }],
      "invalid_part",
      /needs a part: a source to build, an entry to load or a load\(\)/,
    )
    rejects(
      [
        {
          id: "a",
          label: "A",
          mount: "iframe",
          part: { load: async () => ({ mount: () => () => {} }) },
        },
      ],
      "invalid_part",
      /iframe app/,
    )
  })
})

/** A fake part loader that records every fetch, standing in for the network log. */
const recordingImport = (fail = new Set<string>()) => {
  const fetched: string[] = []
  const importModule = async (url: string): Promise<PreviewAppModule> => {
    fetched.push(new URL(url).pathname)
    if (fail.has(new URL(url).pathname)) throw new Error(`GET ${url} answered 503`)
    return {
      mount: (host, context) => {
        ;(host as unknown as { text: string }).text = `${context.app}@${context.version}`
        return () => {}
      },
    }
  }
  return { fetched, importModule }
}
const MANIFEST: PreviewLoadManifestLike = {
  version: 1,
  runtime: "rt-1",
  parts: {
    member: {
      entry: "./parts/member-aaa.js",
      pin: "aaa",
      bytes: 1000,
      backends: ["api", "stripe"],
    },
    clinician: { entry: "./parts/clinician-bbb.js", pin: "bbb", bytes: 900, prefetch: true },
    partner: { entry: "./parts/partner-ccc.html", pin: "ccc", bytes: 800 },
  },
  backends: { api: { entry: "./backends/api-111.js", pin: "111", bytes: 5000 } },
}
const host = () => ({}) as HTMLElement

describe("#839 lazy loading", () => {
  test("1. a cold open loads only the opened app's part and boots only the backends it calls", async () => {
    const { fetched, importModule } = recordingImport()
    const booted: string[] = []
    const system = defineSystem({ apps: APPS, backends: BACKENDS })
    const { surfaces, loader } = systemSurfaces(system, {
      manifest: MANIFEST,
      baseUrl: "https://preview.example/",
      importModule,
      ensureBackends: (ids) => void booted.push(...ids),
    })
    const member = surfaces[0]
    if (!member) throw new Error("no member surface")
    await member.mount(host(), new AbortController().signal)
    expect(fetched).toEqual(["/parts/member-aaa.js"])
    expect(booted).toEqual(["api", "stripe"])
    expect(loader.loaded()).toEqual(["member@aaa"])
    expect(member.version).toBe("aaa")
  })

  test("2. prefetch parts load only when asked (the shell asks at idle, after the first app is up)", async () => {
    const { fetched, importModule } = recordingImport()
    const { loader } = systemSurfaces(defineSystem({ apps: APPS, backends: BACKENDS }), {
      manifest: MANIFEST,
      baseUrl: "https://preview.example/",
      importModule,
    })
    expect(fetched).toEqual([])
    await loader.prefetch()
    // Only the inline part marked prefetch; iframe documents are never prefetched.
    expect(fetched).toEqual(["/parts/clinician-bbb.js"])
  })

  test("3. a part loads once: opening the app again does not fetch it again", async () => {
    const { fetched, importModule } = recordingImport()
    const { surfaces, loader } = systemSurfaces(defineSystem({ apps: APPS, backends: BACKENDS }), {
      manifest: MANIFEST,
      baseUrl: "https://preview.example/",
      importModule,
    })
    const clinician = surfaces[1]
    if (!clinician) throw new Error("no clinician surface")
    await loader.prefetch()
    await clinician.mount(host(), new AbortController().signal)
    await clinician.mount(host(), new AbortController().signal)
    expect(fetched).toEqual(["/parts/clinician-bbb.js"])
  })

  test("5. a part that fails to load fails only its own app, and the next open retries it", async () => {
    const fail = new Set(["/parts/member-aaa.js"])
    const { fetched, importModule } = recordingImport(fail)
    const { surfaces } = systemSurfaces(defineSystem({ apps: APPS, backends: BACKENDS }), {
      manifest: MANIFEST,
      baseUrl: "https://preview.example/",
      importModule,
    })
    const [member, clinician] = surfaces
    if (!member || !clinician) throw new Error("missing surfaces")
    await expect(member.mount(host(), new AbortController().signal)).rejects.toThrow(/503/)
    const other = host()
    await clinician.mount(other, new AbortController().signal)
    expect((other as unknown as { text: string }).text).toBe("clinician@bbb")
    fail.clear()
    await member.mount(host(), new AbortController().signal)
    expect(fetched.filter((path) => path === "/parts/member-aaa.js")).toHaveLength(2)
  })

  test("6. when one part's pin changes, only that part is fetched again", async () => {
    const { fetched, importModule } = recordingImport()
    let manifest = MANIFEST
    const { surfaces } = systemSurfaces(defineSystem({ apps: APPS, backends: BACKENDS }), {
      manifest: () => manifest,
      baseUrl: "https://preview.example/",
      importModule,
    })
    const [member, clinician] = surfaces
    if (!member || !clinician) throw new Error("missing surfaces")
    await member.mount(host(), new AbortController().signal)
    await clinician.mount(host(), new AbortController().signal)
    manifest = {
      ...MANIFEST,
      parts: {
        ...MANIFEST.parts,
        member: { entry: "./parts/member-ddd.js", pin: "ddd", bytes: 1001 },
      },
    }
    expect(planPartUpdate(MANIFEST, manifest)).toEqual({
      kind: "parts",
      apps: ["member"],
      backends: [],
    })
    await member.mount(host(), new AbortController().signal)
    await clinician.mount(host(), new AbortController().signal)
    expect(fetched).toEqual([
      "/parts/member-aaa.js",
      "/parts/clinician-bbb.js",
      "/parts/member-ddd.js",
    ])
    expect(member.version).toBe("ddd")
  })
})

describe("#838 per-app updates: planning", () => {
  test("5. a change to the shared runtime refuses a per-app swap and says why", () => {
    expect(planPartUpdate(MANIFEST, { ...MANIFEST, runtime: "rt-2" })).toEqual({
      kind: "reload",
      reason: "The shared runtime (the shell, worker host or bridge) changed in this build.",
    })
    const { partner: _partner, ...fewer } = MANIFEST.parts
    expect(planPartUpdate(MANIFEST, { ...MANIFEST, parts: fewer }).kind).toBe("reload")
    expect(planPartUpdate(MANIFEST, { ...MANIFEST, backends: {} }).kind).toBe("reload")
    expect(planPartUpdate(MANIFEST, MANIFEST)).toEqual({ kind: "none" })
    expect(
      planPartUpdate(MANIFEST, {
        ...MANIFEST,
        backends: { api: { entry: "./backends/api-222.js", pin: "222", bytes: 5001 } },
      }),
    ).toEqual({ kind: "parts", apps: [], backends: ["api"] })
  })
})
