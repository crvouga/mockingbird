import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  mountSystem,
  mountSystemHarness,
  type SystemHarness,
  type SystemHarnessOptions,
  type SystemPreview,
  type SystemSurface,
} from "../../../../packages/ui/src/system-harness.js"
import {
  defineSystem,
  type PreviewApp,
  PreviewRegistryError,
} from "../../../../packages/ui/src/system-registry.js"
import {
  DOCK_KEY,
  INCLUDED_KEY,
  ORDER_KEY,
  ROTATION_KEY,
} from "../../../../packages/ui/src/system-rotation.js"

/**
 * A preview whose apps change while it runs (#895): the host declares the surfaces it has now
 * with `setSurfaces` (or `setApps` on a registry preview), and the harness adds, keeps and
 * removes them by id. A kept app keeps its mount and state.
 */
export default {
  title: "Examples/System harness/Dynamic topology",
  beforeEach: () => () => {
    stop?.()
    stop = undefined
  },
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-harness.ts",
      "packages/ui/src/system-registry.ts",
      "packages/ui/src/system-rotation.ts",
      "packages/ui/src/system-view.tsx",
      "packages/ui/src/system-screen.tsx",
    ],
  },
} satisfies Meta

const KEYS = [ROTATION_KEY, ORDER_KEY, INCLUDED_KEY, DOCK_KEY]

let harness: SystemHarness | undefined
let stop: (() => void) | undefined
let log: string[] = []
let shown: string[] = []
let original = ""

const current = (): SystemHarness => {
  if (!harness) throw new Error("No harness")
  return harness
}

/**
 * A freshly allocated descriptor each call, as a host deriving its list from its own state
 * supplies: a draft field to show the mount survived, and a log of mounts and disposals.
 */
const app = (
  id: string,
  label: string,
  extra: Partial<SystemSurface> = {},
  tag = id,
): SystemSurface => ({
  id,
  label,
  mount(panel) {
    panel.innerHTML = `<div style="padding:24px 72px;font:15px system-ui"><h2>${label}</h2><label>Draft <input aria-label="${id} draft"></label></div>`
    log.push(`mount ${tag}`)
    return () => log.push(`dispose ${tag}`)
  },
  ...extra,
})

const render =
  (surfaces: () => SystemSurface[], options: SystemHarnessOptions = {}, before?: () => void) =>
  () => {
    stop?.()
    for (const key of KEYS) localStorage.removeItem(key)
    original = location.href
    before?.()
    log = []
    shown = []
    const host = document.createElement("div")
    host.style.height = "100vh"
    const mounted = mountSystemHarness(host, surfaces(), {
      onShow: (id) => void shown.push(id),
      ...options,
    })
    harness = mounted
    stop = () => {
      mounted.destroy()
      history.replaceState(null, "", original)
    }
    return host
  }

/** The System screen's app rows, in order: `id` and what the row says. */
const rows = (canvas: HTMLElement) =>
  [...canvas.querySelectorAll<HTMLElement>("ol.msh-apps > li[data-app]")].map(
    (row) => row.dataset.app,
  )
const row = (canvas: HTMLElement, id: string) =>
  canvas.querySelector<HTMLElement>(`ol.msh-apps > li[data-app="${id}"]`)
const panels = (canvas: HTMLElement, id: string) =>
  canvas.querySelectorAll<HTMLElement>(`section[data-surface="${id}"]`)
const draft = (canvas: HTMLElement, id: string) =>
  canvas.querySelector<HTMLInputElement>(`input[aria-label="${id} draft"]`)
const count = (line: string) => log.filter((entry) => entry === line).length

/** Add B, then rename and reorder A: the switcher, System and routing follow, and A keeps its mount. */
export const AddRenameReorder: StoryObj = {
  render: render(() => [app("a", "Client 1")], { initial: "a", syncUrl: true }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await page.findByTestId("system-switcher", {}, { timeout: 3000 })
    await waitFor(() => expect(log).toEqual(["mount a"]))
    const input = draft(canvasElement, "a") as HTMLInputElement
    await userEvent.type(input, "half-written")
    // System draws its rows once it has been opened; A stays mounted behind it.
    await current().show("system")
    await expect(rows(canvasElement)).toEqual(["system", "a"])
    await current().show("a")

    // A second client appears: one more row and one more stop for the arrows.
    current().setSurfaces([app("a", "Client 1"), app("b", "Client 2", { route: "/client-2" })])
    await waitFor(() => expect(rows(canvasElement)).toEqual(["system", "a", "b"]))
    await expect(current().active()).toBe("a")
    await expect(draft(canvasElement, "a")).toBe(input)
    await expect(input.value).toBe("half-written")
    await expect(log).toEqual(["mount a"])
    await expect(panels(canvasElement, "b")).toHaveLength(1)
    await expect(panels(canvasElement, "b")[0]?.hidden).toBe(true)

    // Renamed and moved after B, from new objects: the same mount, under its new name.
    current().setSurfaces([
      app("b", "Client 2", { route: "/client-2" }),
      app("a", "Host", { description: "The one who started the game." }),
    ])
    await waitFor(() => expect(rows(canvasElement)).toEqual(["system", "b", "a"]))
    await expect(row(canvasElement, "a")).toHaveTextContent("Host")
    await expect(row(canvasElement, "a")).toHaveTextContent("The one who started the game.")
    await expect(panels(canvasElement, "a")[0]).toHaveAttribute("aria-label", "Host")
    await expect(input.isConnected).toBe(true)
    await expect(input.value).toBe("half-written")
    await expect(log).toEqual(["mount a"])
    await expect(page.getByRole("button", { name: "Previous app" })).toBeInTheDocument()

    // The new app is routed: opening it writes its path, and A's draft is still there after.
    await current().show("b")
    await expect(location.pathname).toBe("/client-2")
    current().setSurfaces([app("b", "Client 2", { route: "/guest" }), app("a", "Host")])
    await expect(location.pathname).toBe("/guest")
    await expect(log).toEqual(["mount a", "mount b"])
    await current().show("a")
    await expect(input.value).toBe("half-written")

    // Replacing code is still explicit: `update()` remounts A, and only A.
    await current().update("a", {
      mount(panel) {
        panel.innerHTML = `<h2 data-testid="a-v2">Host, version 2</h2>`
        log.push("mount a v2")
        return () => log.push("dispose a v2")
      },
      version: "v2",
    })
    await expect(await page.findByTestId("a-v2")).toBeVisible()
    await expect(log).toEqual(["mount a", "mount b", "dispose a", "mount a v2"])
    // What `update()` set outlives the next declaration.
    current().setSurfaces([app("b", "Client 2", { route: "/client-2" }), app("a", "Host")])
    await expect(page.getByTestId("a-v2")).toBeVisible()
    await expect(count("dispose a v2")).toBe(0)
  },
}

let release: ((dispose: () => void) => void) | undefined
let aborted = false

/** A surface whose mount stays pending until the story lets it finish. */
const slow = (): SystemSurface => ({
  id: "c",
  label: "Payments",
  mount(_panel, signal) {
    log.push("mount c (slow)")
    signal.addEventListener("abort", () => {
      aborted = true
    })
    return new Promise<() => void>((resolve) => {
      release = resolve
    })
  },
})

/** Remove hidden surfaces: each is disposed once, and a pending mount is aborted and its late result disposed. */
export const RemoveInactive: StoryObj = {
  render: render(
    () => [app("a", "Client"), app("b", "Server"), slow()],
    { initial: "a" },
    () => {
      release = undefined
      aborted = false
    },
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await page.findByTestId("system-switcher", {}, { timeout: 3000 })
    await current().show("b")
    // C starts mounting and is left pending behind A.
    void current().show("c")
    await waitFor(() => expect(release).toBeDefined())
    await current().show("a")
    await expect(log).toEqual(["mount a", "mount b", "mount c (slow)"])

    current().setSurfaces([app("a", "Client")])
    await expect(current().active()).toBe("a")
    await expect(count("dispose b")).toBe(1)
    await expect(panels(canvasElement, "b")).toHaveLength(0)
    await expect(panels(canvasElement, "c")).toHaveLength(0)
    await expect(aborted).toBe(true)
    await expect(count("dispose a")).toBe(0)

    // The same id comes back while the old mount is still pending.
    current().setSurfaces([app("a", "Client"), app("c", "Payments", {}, "c (new)")])
    await current().show("c")
    await expect(log.at(-1)).toBe("mount c (new)")
    // The old mount resolves late: its result is disposed, and the new mount is untouched.
    release?.(() => log.push("dispose c (slow)"))
    await waitFor(() => expect(count("dispose c (slow)")).toBe(1))
    await expect(count("dispose c (new)")).toBe(0)
    await expect(panels(canvasElement, "c")).toHaveLength(1)
    await expect(draft(canvasElement, "c")).toBeVisible()
    await expect(canvasElement.querySelector('[role="status"].msh-status')).toBeNull()

    // Removing it again disposes it once, and declaring the same list again changes nothing.
    await current().show("a")
    current().setSurfaces([app("a", "Client")])
    current().setSurfaces([app("a", "Client")])
    await expect(count("dispose c (new)")).toBe(1)
    await expect(count("dispose b")).toBe(1)
    await expect(count("dispose c (slow)")).toBe(1)
  },
}

/** Remove the app shown, then every app: the shell falls back, rewrites its address, and takes new apps. */
export const RemoveActive: StoryObj = {
  render: render(() => [app("a", "Client 1"), app("b", "Client 2")], {
    initial: "a",
    syncUrl: true,
  }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const search = () => new URL(location.href).searchParams.get("surface")
    await page.findByTestId("system-switcher", {}, { timeout: 3000 })
    await current().show("b")
    await expect(search()).toBe("b")
    const entries = history.length
    const input = draft(canvasElement, "b") as HTMLInputElement
    input.focus()

    // The app shown leaves: `initial` is still there, so it is shown, at its own address.
    current().setSurfaces([app("a", "Client 1")])
    await expect(current().active()).toBe("a")
    await expect(search()).toBe("a")
    await expect(history.length).toBe(entries)
    await expect(shown.at(-1)).toBe("a")
    await expect(count("dispose b")).toBe(1)
    await expect(panels(canvasElement, "a")[0]?.hidden).toBe(false)
    await expect(document.activeElement).toBe(panels(canvasElement, "a")[0])

    // Every app leaves: System is always reachable, and the switcher has nowhere to go.
    current().setSurfaces([])
    await expect(current().active()).toBe("system")
    await expect(search()).toBe("system")
    await expect(count("dispose a")).toBe(1)
    await expect(await page.findByText("This preview has no apps yet.")).toBeVisible()
    await expect(page.getByTestId("system-switcher")).not.toBeVisible()

    // New apps arrive afterwards and open as usual.
    current().setSurfaces([app("d", "Client 3"), app("e", "Payments")])
    await waitFor(() => expect(rows(canvasElement)).toEqual(["system", "d", "e"]))
    await expect(page.getByTestId("system-switcher")).toBeVisible()
    await expect(current().active()).toBe("system")
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    await waitFor(() => expect(current().active()).toBe("d"))
    await expect(search()).toBe("d")
    await expect(draft(canvasElement, "d")).toBeVisible()

    // Without `initial` to return to, the first app in the switcher is the fallback.
    current().setSurfaces([app("e", "Payments")])
    await expect(current().active()).toBe("e")
    await expect(search()).toBe("e")

    // An app asked for before it exists opens when it is declared.
    await current().show("f")
    await expect(current().active()).toBe("system")
    current().setSurfaces([app("e", "Payments"), app("f", "Emulator")])
    await expect(current().active()).toBe("f")
    await expect(search()).toBe("f")
  },
}

const cycle = async (page: ReturnType<typeof within>, steps: number) => {
  const seen: string[] = []
  for (let step = 0; step < steps; step++) {
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    seen.push(current().active())
  }
  return seen
}

/** The switcher's preferences hold across changes, and a list that cannot work changes nothing. */
export const PreferencesAndValidation: StoryObj = {
  render: render(
    () => [app("a", "Client 1"), app("b", "Client 2"), app("c", "Server")],
    { initial: "a" },
    () => {
      // What a person chose earlier: Server first, and Client 2 out of the switcher.
      localStorage.setItem(ORDER_KEY, JSON.stringify(["system", "c", "a", "b"]))
      localStorage.setItem(ROTATION_KEY, JSON.stringify(["b"]))
    },
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await page.findByTestId("system-switcher", {}, { timeout: 3000 })
    await current().show("system")
    await expect(rows(canvasElement)).toEqual(["system", "c", "a", "b"])
    await current().show("a")
    const input = draft(canvasElement, "a") as HTMLInputElement
    await userEvent.type(input, "kept")

    // B leaves and D arrives, off by default: the chosen order stands, D after its neighbour.
    current().setSurfaces([
      app("a", "Client 1"),
      app("c", "Server"),
      app("d", "Emulator", { defaultEnabled: false }),
    ])
    await waitFor(() => expect(rows(canvasElement)).toEqual(["system", "c", "d", "a"]))
    await expect(await cycle(page, 3)).toEqual(["system", "c", "a"])

    // B comes back: still switched off, as the person left it, and back in its place.
    current().setSurfaces([
      app("a", "Client 1"),
      app("b", "Client 2"),
      app("c", "Server"),
      app("d", "Emulator", { defaultEnabled: false }),
    ])
    await waitFor(() => expect(rows(canvasElement)).toEqual(["system", "c", "d", "a", "b"]))
    await expect(await cycle(page, 3)).toEqual(["system", "c", "a"])
    await expect(localStorage.getItem(ROTATION_KEY)).toBe(JSON.stringify(["b"]))

    // Lists that cannot work throw, and the running preview is as it was.
    const before = [...log]
    const declare = (list: SystemSurface[]) => () => current().setSurfaces(list)
    await expect(declare([app("a", "Client 1"), app("a", "Again")])).toThrow(/Duplicate/)
    await expect(declare([app("system", "Mine")])).toThrow(/reserved/)
    await expect(
      declare([app("x", "X", { route: "/play" }), app("y", "Y", { route: "/play" })]),
    ).toThrow(/both own the route/)
    await expect(rows(canvasElement)).toEqual(["system", "c", "d", "a", "b"])
    await expect(current().active()).toBe("a")
    await expect(log).toEqual(before)
    await expect(input.isConnected).toBe(true)
    await expect(input.value).toBe("kept")
    await expect(panels(canvasElement, "x")).toHaveLength(0)
  },
}

let preview: SystemPreview | undefined
let loads: string[] = []

/** A registry app whose part is bundled with the shell: `tag` tells one declaration from the next. */
const instance = (id: string, label: string, extra: Partial<PreviewApp> = {}): PreviewApp => ({
  id,
  label,
  part: {
    load: async () => {
      loads.push(id)
      return {
        mount(host, context) {
          host.innerHTML = `<div style="padding:24px 72px;font:15px system-ui"><h2>${label}</h2><label>Draft <input aria-label="${id} draft"></label></div>`
          log.push(`mount ${context.app}`)
          return () => log.push(`dispose ${context.app}`)
        },
      }
    },
  },
  ...extra,
})

/** The same through the registry: `setApps` takes the session's instances as a plain array. */
export const RegistryInstances: StoryObj = {
  render: () => {
    stop?.()
    for (const key of KEYS) localStorage.removeItem(key)
    original = location.href
    log = []
    loads = []
    const host = document.createElement("div")
    host.style.height = "100vh"
    const mounted = mountSystem(
      host,
      defineSystem({
        apps: [instance("client-1", "Client 1", { route: "/", backends: ["game-server"] })],
        backends: [{ id: "game-server", label: "Game server", kind: "backend" }],
      }),
      { initial: "client-1", syncUrl: true, idle: (run) => run() },
    )
    preview = mounted
    harness = mounted
    stop = () => {
      mounted.destroy()
      history.replaceState(null, "", original)
    }
    return host
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const system = preview as SystemPreview
    await page.findByTestId("system-switcher", {}, { timeout: 3000 })
    await waitFor(() => expect(log).toEqual(["mount client-1"]))
    const input = draft(canvasElement, "client-1") as HTMLInputElement
    await userEvent.type(input, "my move")

    // A second client joins and a payment emulator starts: one array, as the session has it.
    system.setApps([
      instance("client-1", "Client 1", { route: "/", backends: ["game-server"] }),
      instance("client-2", "Client 2", { route: "/client-2", backends: ["game-server"] }),
      instance("payments", "Payments", { route: "/payments", backends: ["stripe"] }),
    ])
    await expect(system.system().apps.map((entry) => entry.id)).toEqual([
      "client-1",
      "client-2",
      "payments",
    ])
    await expect(system.system().route("/payments/checkout")?.id).toBe("payments")
    // The first client is untouched, and the new parts load only when opened.
    await expect(input.value).toBe("my move")
    await expect(log).toEqual(["mount client-1"])
    await expect(loads).toEqual(["client-1"])
    await system.show("payments")
    await expect(location.pathname).toBe("/payments")
    await expect(loads).toEqual(["client-1", "payments"])
    await expect(system.loader.loaded()).toEqual(["client-1@bundled", "payments@bundled"])

    // System lists the new backend beside the one already declared, which keeps its label.
    await system.show("system")
    await expect(rows(canvasElement)).toEqual(["system", "client-1", "client-2", "payments"])
    const screen = within(panels(canvasElement, "system")[0] as HTMLElement)
    await expect((await screen.findAllByText("Game server"))[0]).toBeVisible()
    await expect((await screen.findAllByText("stripe"))[0]).toBeVisible()

    // A list the registry rejects changes nothing.
    const invalid = () =>
      system.setApps([instance("client-1", "Client 1"), instance("client-1", "Client 1 again")])
    await expect(invalid).toThrow(PreviewRegistryError)
    await expect(system.system().apps).toHaveLength(3)
    await expect(rows(canvasElement)).toEqual(["system", "client-1", "client-2", "payments"])

    // The emulator stops and comes back: its part is loaded again from the new declaration.
    system.setApps([instance("client-1", "Client 1", { route: "/", backends: ["game-server"] })])
    await expect(count("dispose payments")).toBe(1)
    system.setApps([
      instance("client-1", "Client 1", { route: "/", backends: ["game-server"] }),
      instance("payments", "Payments", { route: "/payments" }),
    ])
    await system.show("payments")
    await expect(loads).toEqual(["client-1", "payments", "payments"])
    await system.show("client-1")
    await expect(input.value).toBe("my move")
    await expect(count("mount client-1")).toBe(1)

    // The session ends: no apps, System shown, and the address says so.
    system.setApps([])
    await expect(system.active()).toBe("system")
    await expect(count("dispose client-1")).toBe(1)
    await expect(await page.findByText("This preview has no apps yet.")).toBeVisible()
    await expect(new URL(location.href).searchParams.get("surface")).toBe("system")
  },
}
