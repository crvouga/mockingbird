import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  mountSystemHarness,
  type SystemHarness,
  type SystemHarnessOptions,
  type SystemSurface,
} from "../../../../packages/ui/src/system-harness.js"
import {
  DOCK_KEY,
  INCLUDED_KEY,
  ORDER_KEY,
  ROTATION_KEY,
} from "../../../../packages/ui/src/system-rotation.js"

/**
 * The harness's lifecycle and preferences: surfaces told when they are shown and hidden (and
 * unmounted after a while hidden), the host told when the shown surface changes and mapping
 * surfaces to its own URLs, and the switcher's preferences kept where the host says.
 */
export default {
  title: "Examples/System harness/Lifecycle",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-harness.ts",
      "packages/ui/src/system-rotation.ts",
      "packages/ui/src/system-view.tsx",
    ],
  },
} satisfies Meta

const KEYS = [ROTATION_KEY, ORDER_KEY, INCLUDED_KEY, DOCK_KEY]
const reset = () => {
  for (const key of KEYS) localStorage.removeItem(key)
}

let harness: SystemHarness | undefined
let stop: (() => void) | undefined
let log: string[] = []

const current = (): SystemHarness => {
  if (!harness) throw new Error("No harness")
  return harness
}

/** A plain surface that draws its name and records its mount and disposal. */
const plain = (id: string, label: string, extra: Partial<SystemSurface> = {}): SystemSurface => ({
  id,
  label,
  mount(panel) {
    panel.innerHTML = `<div style="padding:24px 72px;font:15px system-ui"><h2>${label}</h2></div>`
    log.push(`mount ${id}`)
    return () => log.push(`dispose ${id}`)
  },
  ...extra,
})

const render =
  (surfaces: () => SystemSurface[], options: SystemHarnessOptions = {}, before?: () => void) =>
  () => {
    stop?.()
    reset()
    before?.()
    log = []
    const host = document.createElement("div")
    host.style.height = "100vh"
    const mounted = mountSystemHarness(host, surfaces(), options)
    harness = mounted
    stop = () => mounted.destroy()
    return host
  }

/** A call surface holding a live `MediaStream` (a canvas capture, so no device is needed). */
let call: { stream?: MediaStream } = {}
const callSurface = (): SystemSurface => {
  call = {}
  const start = (panel: HTMLElement) => {
    const canvas = panel.ownerDocument.createElement("canvas")
    canvas.getContext("2d")?.fillRect(0, 0, 1, 1)
    call.stream = canvas.captureStream(1)
  }
  let panel: HTMLElement | undefined
  return {
    id: "call",
    label: "Video call",
    mount(host) {
      panel = host
      host.innerHTML = `<div style="padding:24px 72px;font:15px system-ui"><h2>Video call</h2><p data-testid="call-state">Camera on</p></div>`
      start(host)
      log.push("mount call")
      return () => {
        for (const track of call.stream?.getTracks() ?? []) track.stop()
        log.push("dispose call")
      }
    },
    onHide() {
      for (const track of call.stream?.getTracks() ?? []) track.stop()
      log.push("hide call")
    },
    onShow() {
      if (panel && call.stream?.getTracks().every((track) => track.readyState === "ended"))
        start(panel)
      log.push("show call")
    },
  }
}
const live = () => call.stream?.getTracks().every((track) => track.readyState === "live") ?? false

/** Pretends the browser tab was hidden or shown again. */
const setTabVisibility = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" })
  document.dispatchEvent(new Event("visibilitychange"))
}
const restoreTabVisibility = () => {
  delete (document as unknown as Record<string, unknown>).visibilityState
  delete (document as unknown as Record<string, unknown>).hidden
}

/** #869.1: a surface holding a MediaStream stops its tracks when hidden and restarts them when shown. */
export const ShowAndHide: StoryObj = {
  render: render(() => [callSurface(), plain("notes", "Notes")], { initial: "call" }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    try {
      await page.findByTestId("system-switcher", {}, { timeout: 3000 })
      await waitFor(() => expect(log).toEqual(["mount call", "show call"]))
      await expect(live()).toBe(true)
      // The pill's arrows hide it: its tracks stop, and it stays mounted.
      await userEvent.click(page.getByRole("button", { name: "Next app" }))
      await waitFor(() => expect(current().active()).toBe("notes"))
      await expect(live()).toBe(false)
      await expect(log).toEqual(["mount call", "show call", "hide call", "mount notes"])
      // Shown again: the same mount restarts its tracks.
      await current().show("call")
      await expect(live()).toBe(true)
      await expect(log.filter((line) => line.endsWith("call"))).toEqual([
        "mount call",
        "show call",
        "hide call",
        "show call",
      ])
      // The browser tab going to the background hides the shown surface too, and back shows it.
      setTabVisibility("hidden")
      await expect(live()).toBe(false)
      setTabVisibility("visible")
      await expect(live()).toBe(true)
      await expect(log.slice(-2)).toEqual(["hide call", "show call"])
    } finally {
      restoreTabVisibility()
      stop?.()
      stop = undefined
    }
  },
}

/** #869.2: with `evictHiddenAfterMs`, a surface hidden that long is disposed, and mounts again when shown. */
export const EvictHidden: StoryObj = {
  render: render(() => [callSurface(), plain("notes", "Notes")], {
    initial: "call",
    evictHiddenAfterMs: 50,
  }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await page.findByTestId("system-switcher", {}, { timeout: 3000 })
    await waitFor(() => expect(log).toEqual(["mount call", "show call"]))
    await current().show("notes")
    await expect(log.at(-1)).toBe("mount notes")
    await waitFor(() => expect(log).toContain("dispose call"))
    await expect(log).toEqual([
      "mount call",
      "show call",
      "hide call",
      "mount notes",
      "dispose call",
    ])
    const panel = canvasElement.querySelector<HTMLElement>('section[data-surface="call"]')
    await expect(panel?.textContent).toBe("")
    // Shown again: it mounts afresh, while Notes (shown) is not evicted.
    await current().show("call")
    await expect(await page.findByTestId("call-state")).toHaveTextContent("Camera on")
    await expect(live()).toBe(true)
    await expect(log.slice(-2)).toEqual(["mount call", "show call"])
    // Shown before the time is up: nothing is evicted.
    await current().show("notes")
    await current().show("call")
    await new Promise((resolve) => setTimeout(resolve, 120))
    await expect(log.filter((line) => line === "dispose call")).toHaveLength(1)
  },
}

/** The host's own addresses: each app owns a path, as same-origin iframes of real apps do. */
const PATHS: Record<string, string> = {
  admin: "/",
  care: "/care-hub",
  partner: "/partner-platform",
}
let shown: string[] = []
let original = ""

/** #884: the pill's arrows tell the host once, and the host maps surfaces to its own URLs. */
export const HostUrls: StoryObj = {
  render: render(
    () => [
      plain("admin", "Admin"),
      plain("care", "Care hub"),
      plain("partner", "Partner platform"),
    ],
    {
      onShow: (id) => void shown.push(id),
      url: {
        read: (location) =>
          location.pathname === "/system"
            ? "system"
            : Object.entries(PATHS)
                .filter(([, path]) => path === "/" || location.pathname.startsWith(path))
                .sort((a, b) => b[1].length - a[1].length)[0]?.[0],
        write: (id) => (id === "system" ? "/system" : `${PATHS[id]}`),
      },
    },
    () => {
      shown = []
      original = location.href
      history.replaceState(null, "", "/care-hub/patients/7")
    },
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    try {
      await page.findByTestId("system-switcher", {}, { timeout: 3000 })
      // The address opened the app that owns it, without rewriting it or telling the host.
      await waitFor(() => expect(current().active()).toBe("care"))
      await expect(location.pathname).toBe("/care-hub/patients/7")
      await expect(shown).toEqual([])
      // The pill's arrow: one call with the new id, before its mount resolves.
      await userEvent.click(page.getByRole("button", { name: "Next app" }))
      await waitFor(() => expect(current().active()).toBe("partner"))
      await expect(shown).toEqual(["partner"])
      await expect(location.pathname).toBe("/partner-platform")
      await expect(location.search).toBe("")
      await userEvent.click(page.getByRole("button", { name: "Next app" }))
      await waitFor(() => expect(current().active()).toBe("system"))
      await expect(shown).toEqual(["partner", "system"])
      await expect(location.pathname).toBe("/system")
      // Showing the surface already shown changes nothing.
      await current().show("system")
      await expect(shown).toEqual(["partner", "system"])
      // Back follows the host's read, and tells the host too.
      history.back()
      await waitFor(() => expect(current().active()).toBe("partner"))
      await expect(shown).toEqual(["partner", "system", "partner"])
      await expect(location.pathname).toBe("/partner-platform")
    } finally {
      stop?.()
      stop = undefined
      history.replaceState(null, "", original)
    }
  },
}

const switcherCycle = async (page: ReturnType<typeof within>) => {
  const seen: string[] = []
  for (let step = 0; step < 4; step++) {
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    seen.push(current().active())
  }
  return seen
}

/** #885.1: `defaultExcluded` survives the store being cleared, as an app's sign-out does. */
export const DefaultExcluded: StoryObj = {
  render: render(
    () => [
      plain("admin", "Admin"),
      plain("care", "Care hub"),
      plain("partner", "Partner platform"),
    ],
    { initial: "admin", defaultExcluded: ["partner"] },
    () => {
      // A store left by an older shell that seeded nothing: the defaults still apply.
      localStorage.clear()
    },
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await page.findByTestId("system-switcher", {}, { timeout: 3000 })
    await expect(await switcherCycle(page)).toEqual(["care", "system", "admin", "care"])
    // Switched on, then an app signs out and clears localStorage, then a reload.
    await current().show("system")
    const toggle = await page.findByRole("switch", { name: "Partner platform in switcher" })
    await expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await expect(toggle).toBeChecked()
    localStorage.clear()
    stop?.()
    const host = document.createElement("div")
    host.style.height = "100vh"
    canvasElement.replaceChildren(host)
    const reloaded = mountSystemHarness(
      host,
      [plain("admin", "Admin"), plain("care", "Care hub"), plain("partner", "Partner platform")],
      { initial: "admin", defaultExcluded: ["partner"] },
    )
    harness = reloaded
    stop = () => reloaded.destroy()
    await page.findByTestId("system-switcher", {}, { timeout: 3000 })
    await expect(await switcherCycle(page)).toEqual(["care", "system", "admin", "care"])
  },
}

/** #885.2: with a custom `storage`, the rotation, order and pill position live there alone. */
let store = new Map<string, string>()
let localWrites: string[] = []
let restoreSetItem: (() => void) | undefined
export const CustomStorage: StoryObj = {
  render: render(
    () => [
      plain("admin", "Admin"),
      plain("care", "Care hub"),
      plain("partner", "Partner platform"),
    ],
    {
      initial: "system",
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
      },
    },
    () => {
      store = new Map([[DOCK_KEY, JSON.stringify({ edge: "right", at: 0.25 })]])
      localWrites = []
      const setItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (this === localStorage) localWrites.push(key)
        return setItem.call(this, key, value)
      }
      restoreSetItem = () => {
        Storage.prototype.setItem = setItem
      }
    },
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    try {
      const pill = await page.findByTestId("system-switcher", {}, { timeout: 3000 })
      // The pill sits where the custom store says: the right edge.
      await waitFor(() =>
        expect(pill.getBoundingClientRect().left).toBeGreaterThan(canvasElement.clientWidth / 2),
      )
      const toggle = await page.findByRole("switch", { name: "Care hub in switcher" })
      await userEvent.click(toggle)
      await expect(store.get(ROTATION_KEY)).toBe('["care"]')
      await expect(await switcherCycle(page)).toEqual(["admin", "partner", "system", "admin"])
      await expect(localWrites).toEqual([])
      for (const key of KEYS) await expect(localStorage.getItem(key)).toBeNull()
    } finally {
      restoreSetItem?.()
      restoreSetItem = undefined
    }
  },
}
