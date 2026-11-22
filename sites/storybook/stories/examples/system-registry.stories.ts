import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  mountSystem,
  mountSystemHarness,
  type SystemHarness,
} from "../../../../packages/ui/src/system-harness.js"
import {
  defineSystem,
  type PreviewAppModule,
  type PreviewLoadManifestLike,
} from "../../../../packages/ui/src/system-registry.js"
import {
  INCLUDED_KEY,
  ORDER_KEY,
  ROTATION_KEY,
} from "../../../../packages/ui/src/system-rotation.js"

/**
 * A system preview declared as one registry (`defineSystem`): three apps with routes, the
 * backends each calls, an off-by-default iframe app, lazy parts, and per-app code updates.
 */
export default {
  title: "Examples/System harness/Registry",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-harness.ts",
      "packages/ui/src/system-registry.ts",
      "packages/ui/src/system-routes.ts",
      "packages/ui/src/system-view.tsx",
      "packages/ui/src/system-screen.tsx",
    ],
  },
} satisfies Meta

const reset = () => {
  for (const key of [ROTATION_KEY, ORDER_KEY, INCLUDED_KEY, "mockingbird.system-switcher.dock"])
    localStorage.removeItem(key)
}

/** An inline part: draws its name and version, keeps a draft field, and records disposal. */
const part =
  (name: string, log: string[]): PreviewAppModule["mount"] =>
  (host, context) => {
    host.innerHTML = `<div style="padding:24px 72px;font:15px system-ui"><h2>${name}</h2><p data-testid="version-${context.app}">Code ${context.version ?? "bundled"}</p><label>Draft <input aria-label="${name} draft"></label><div data-testid="scroll-${context.app}" style="height:120px;overflow:auto"><div style="height:600px">Long list</div></div></div>`
    log.push(`mount ${context.app}@${context.version ?? "bundled"}`)
    return () => log.push(`dispose ${context.app}@${context.version ?? "bundled"}`)
  }

/** The partner portal: an isolated document that reports what it can see. */
const PARTNER_DOCUMENT = `<!doctype html><html><body style="font:15px system-ui;padding:24px 72px"><h2>Partner portal</h2><p id="status">Waiting for the bridge…</p><script>
addEventListener("message", (event) => {
  if (event.data?.type !== "mockingbird-preview-connect") return
  const port = event.ports[0]
  const shared = typeof window.shellSecret
  document.getElementById("status").textContent = "Bridge connected · shell globals: " + shared
  port.postMessage({ type: "partner-ready", shared, app: event.data.app })
})
</script></body></html>`

const MANIFEST: PreviewLoadManifestLike = {
  version: 1,
  runtime: "rt-1",
  parts: {
    member: {
      entry: "./parts/member-aaa.js",
      pin: "aaa111",
      bytes: 1200,
      backends: ["api", "stripe"],
    },
    clinician: { entry: "./parts/clinician-bbb.js", pin: "bbb222", bytes: 900, prefetch: true },
    partner: { entry: "PARTNER", pin: "ccc333", bytes: 700 },
  },
  backends: { api: { entry: "./backends/api-111.js", pin: "111", bytes: 4000 } },
}

const SYSTEM = defineSystem({
  apps: [
    {
      id: "member",
      label: "Member web",
      description: "The member app, at the site root.",
      route: "/",
      part: { entry: "./parts/member.js" },
      backends: ["api", "stripe"],
      health: () => ({ ok: true }),
    },
    {
      id: "clinician",
      label: "Clinician web",
      description: "The clinician app, prefetched while idle.",
      route: "/clinician",
      part: { entry: "./parts/clinician.js", prefetch: true },
      backends: ["api"],
      health: () => ({ ok: false, message: "API answered 503" }),
    },
    {
      id: "partner",
      label: "Partner portal",
      description: "A third-party framework, isolated in its own document. Off by default.",
      route: "/partner",
      defaultEnabled: false,
      mount: "iframe",
      part: { entry: "PARTNER" },
      backends: ["partner-api"],
    },
  ],
  backends: [
    { id: "api", label: "API", kind: "backend" },
    { id: "partner-api", label: "Partner API", kind: "backend" },
    { id: "stripe", label: "Stripe", kind: "emulator" },
  ],
})

type Fixture = {
  log: string[]
  fetched: string[]
  booted: string[]
  idle: (() => void)[]
  bridged: unknown[]
  reloads: number
  backendFailures: number
  system: ReturnType<typeof mountSystem>
}
let fixture: Fixture | undefined
let stop: (() => void) | undefined

const renderSystem =
  (initial = "member", backendFailures = 0) =>
  () => {
    stop?.()
    reset()
    const host = document.createElement("div")
    host.style.height = "100vh"
    const partnerUrl = URL.createObjectURL(new Blob([PARTNER_DOCUMENT], { type: "text/html" }))
    ;(window as unknown as { shellSecret?: string }).shellSecret = "only in the shell"
    const state = {
      log: [] as string[],
      fetched: [] as string[],
      booted: [] as string[],
      idle: [] as (() => void)[],
      bridged: [] as unknown[],
      reloads: 0,
      backendFailures,
    }
    const system = mountSystem(host, SYSTEM, {
      initial,
      manifest: {
        ...MANIFEST,
        parts: {
          ...MANIFEST.parts,
          partner: { ...MANIFEST.parts.partner, entry: partnerUrl } as never,
        },
      },
      baseUrl: "https://preview.example/",
      importModule: async (url) => {
        const path = new URL(url).pathname
        state.fetched.push(path)
        const id = path.split("/").pop()?.split("-")[0] ?? "app"
        return { mount: part(id === "member" ? "Member web" : "Clinician web", state.log) }
      },
      ensureBackends: (ids) => void state.booted.push(...ids),
      bridge: (port, app) => {
        port.onmessage = (event) => state.bridged.push({ ...event.data, via: app })
        return () => port.close()
      },
      idle: (run) => void state.idle.push(run),
      reload: () => void state.reloads++,
      replaceBackend: async (id) => {
        if (state.backendFailures > 0) {
          state.backendFailures--
          throw new Error(`${id}-222.js threw during boot`)
        }
      },
    })
    fixture = { ...state, system }
    Object.defineProperty(fixture, "reloads", { get: () => state.reloads })
    stop = () => {
      system.destroy()
      URL.revokeObjectURL(partnerUrl)
      delete (window as unknown as { shellSecret?: string }).shellSecret
    }
    return host
  }

/** The member app is up, and the harness's React view (loaded lazily) has drawn the switcher. */
const shellReady = async (page: ReturnType<typeof within>) => {
  await waitFor(() => expect(page.getByTestId("version-member")).toHaveTextContent("Code aaa111"))
  await page.findByTestId("system-switcher", {}, { timeout: 3000 })
}

const current = (fx: Fixture | undefined): Fixture => {
  if (!fx) throw new Error("No fixture")
  return fx
}

/** #841: one declaration drives the switcher, System, backends, routes; #839: lazy parts. */
export const Registry: StoryObj = {
  render: renderSystem("member"),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const fx = current(fixture)
    await shellReady(page)
    // A cold open fetched only the member part and booted only what it calls.
    await expect(fx.fetched).toEqual(["/parts/member-aaa.js"])
    await expect(fx.booted).toEqual(["api", "stripe"])
    // Prefetch waits for idle time, after the first app is up.
    await expect(fx.idle).toHaveLength(1)
    fx.idle[0]?.()
    await waitFor(() =>
      expect(fx.fetched).toEqual(["/parts/member-aaa.js", "/parts/clinician-bbb.js"]),
    )

    // The off-by-default partner portal is not in the arrows' rotation.
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    await waitFor(() => expect(fx.system.active()).toBe("clinician"))
    await expect(fx.fetched).toHaveLength(2)
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    await waitFor(() => expect(fx.system.active()).toBe("system"))

    // System lists each app's backends, its health and version, and who calls each backend.
    await expect(await page.findByTestId("system-app-backends-member")).toHaveTextContent(
      "Calls api, stripe",
    )
    await waitFor(() =>
      expect(page.getByTestId("system-app-health-clinician")).toHaveTextContent("Unhealthy"),
    )
    const backends = page.getByRole("list", { name: "Backends" })
    await expect(within(backends).getByText("Stripe").parentElement).toHaveTextContent(
      "Emulator · used by Member web",
    )
    await expect(within(backends).getByText("API").parentElement).toHaveTextContent(
      "used by Member web, Clinician web",
    )

    // Switching the partner portal on adds it to the rotation and persists in this browser.
    const toggle = page.getByRole("switch", { name: "Partner portal in switcher" })
    await expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await expect(localStorage.getItem(INCLUDED_KEY)).toBe('["partner"]')
    await userEvent.click(page.getByRole("button", { name: "Previous app" }))
    await waitFor(() => expect(fx.system.active()).toBe("partner"))

    // The iframe app has its own document, and its bridge port reaches the shell.
    const frame = await waitFor(() => {
      const element = canvasElement.querySelector<HTMLIFrameElement>("iframe[data-app=partner]")
      if (!element) throw new Error("no frame yet")
      return element
    })
    await waitFor(() =>
      expect(fx.bridged).toEqual([
        { type: "partner-ready", shared: "undefined", app: "partner", via: "partner" },
      ]),
    )
    await expect(frame.title).toBe("Partner portal")
  },
}

/** #841: a deep link opens the app that owns the path; switching back restores its last path. */
export const DeepLinks: StoryObj = {
  render: () => {
    stop?.()
    reset()
    const original = location.href
    history.replaceState(null, "", "/clinician/patients/7")
    const host = document.createElement("div")
    host.style.height = "100vh"
    const log: string[] = []
    const harness = mountSystemHarness(
      host,
      [
        { id: "member", label: "Member web", route: "/", mount: part("Member web", log) as never },
        {
          id: "clinician",
          label: "Clinician web",
          route: "/clinician",
          mount: part("Clinician web", log) as never,
        },
        {
          id: "emulators",
          label: "Emulators",
          mount: (panel) => {
            panel.textContent = "Emulators"
            return () => {}
          },
        },
      ],
      { syncUrl: true, initial: "member" },
    )
    stop = () => {
      harness.destroy()
      history.replaceState(null, "", original)
    }
    deepLinks = harness
    return host
  },
  play: async () => {
    const harness = deepLinks as SystemHarness
    try {
      await waitFor(() => expect(harness.active()).toBe("clinician"))
      await expect(location.pathname).toBe("/clinician/patients/7")
      await harness.show("member")
      await expect(location.pathname).toBe("/")
      // The member app navigates inside its own route.
      history.pushState(null, "", "/settings/profile")
      await harness.show("emulators")
      await expect(new URL(location.href).searchParams.get("surface")).toBe("emulators")
      await harness.show("clinician")
      await expect(location.pathname).toBe("/clinician/patients/7")
      await expect(new URL(location.href).searchParams.has("surface")).toBe(false)
      await harness.show("member")
      await expect(location.pathname).toBe("/settings/profile")
      // Back goes to where the URL says, without rewriting it.
      history.back()
      await waitFor(() => expect(harness.active()).toBe("clinician"))
      await expect(location.pathname).toBe("/clinician/patients/7")
    } finally {
      stop?.()
      stop = undefined
    }
  },
}
let deepLinks: SystemHarness | undefined

/** #838: a newer build swaps one app's code; the other keeps its DOM, scroll and state. */
export const UpdateInPlace: StoryObj = {
  render: renderSystem("member"),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const fx = current(fixture)
    await shellReady(page)
    await fx.system.show("clinician")
    await waitFor(() => expect(page.getByTestId("version-clinician")).toHaveTextContent("bbb222"))
    await fx.system.show("member")
    const draft = page.getByRole("textbox", { name: "Member web draft" })
    await userEvent.type(draft, "Half-written note")
    const list = page.getByTestId("scroll-member")
    list.scrollTop = 240
    const result = await fx.system.applyManifest({
      ...MANIFEST,
      parts: {
        ...MANIFEST.parts,
        partner: fx.system.manifest()?.parts.partner as never,
        clinician: { entry: "./parts/clinician-ddd.js", pin: "ddd444", bytes: 950 },
      },
    })
    await expect(result).toEqual({ status: "updated", apps: ["clinician"], backends: [] })
    await expect(fx.log).toContain("dispose clinician@bbb222")
    await expect(fx.log.at(-1)).toBe("mount clinician@ddd444")
    // The member app was never touched.
    await expect(page.getByRole("textbox", { name: "Member web draft" })).toBe(draft)
    await expect(draft).toHaveValue("Half-written note")
    await expect(list.scrollTop).toBe(240)
    await expect(fx.log.filter((line) => line.startsWith("dispose member"))).toEqual([])
    await fx.system.show("clinician")
    await expect(page.getByTestId("version-clinician")).toHaveTextContent("Code ddd444")
  },
}

/** #838: a change to the shared runtime cannot be swapped per app; the shell says why. */
export const ReloadRequired: StoryObj = {
  render: renderSystem("member"),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const fx = current(fixture)
    await shellReady(page)
    const result = await fx.system.applyManifest({ ...MANIFEST, runtime: "rt-2" })
    await expect(result.status).toBe("reload-required")
    const notice = page.getByTestId("system-notice")
    await expect(notice).toHaveTextContent(
      "This update needs a full reload. The shared runtime (the shell, worker host or bridge) changed in this build.",
    )
    await userEvent.click(within(notice).getByRole("button", { name: "Reload" }))
    await expect(fx.reloads).toBe(1)
    await expect(page.getByTestId("version-member")).toHaveTextContent("aaa111")
  },
}

/** #838: a backend whose new code fails to boot keeps the old one serving and offers Retry. */
export const BackendUpdateFailed: StoryObj = {
  render: renderSystem("member", 1),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const fx = current(fixture)
    await shellReady(page)
    const next = {
      ...MANIFEST,
      parts: { ...MANIFEST.parts, partner: fx.system.manifest()?.parts.partner as never },
      backends: { api: { entry: "./backends/api-222.js", pin: "222", bytes: 4100 } },
    }
    const result = await fx.system.applyManifest(next)
    await expect(result).toMatchObject({ status: "failed", backend: "api" })
    const notice = page.getByRole("alert")
    await expect(notice).toHaveTextContent(
      "Backend api could not update, so its previous version keeps serving: api-222.js threw during boot",
    )
    await userEvent.click(within(notice).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(page.queryByTestId("system-notice")).not.toBeVisible())
    await expect(fx.system.manifest()?.backends?.api?.pin).toBe("222")
  },
}
