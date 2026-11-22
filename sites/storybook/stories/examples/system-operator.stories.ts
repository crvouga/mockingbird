import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  mountSystemHarness,
  type SystemHarnessOptions,
  type SystemSection,
  type SystemService,
  type SystemServiceMode,
  type SystemServices,
  type SystemSnapshot,
} from "../../../../packages/ui/src/system-harness.js"
import { SYSTEM_ICONS } from "../../../../packages/ui/src/system-icons.js"
import { ORDER_KEY, ROTATION_KEY } from "../../../../packages/ui/src/system-rotation.js"

/**
 * The System screen as an operator console: a consumer's own sections and the Data card (save,
 * load and reset of the whole tab), the switcher's dev badge with live service updates across
 * tabs and each service's last call and Test, and the pill's long-press, right-click and
 * keyboard shortcut to System.
 */
export default {
  title: "Examples/System harness/Operator console",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-harness.ts",
      "packages/ui/src/system-view.tsx",
      "packages/ui/src/system-screen.tsx",
      "packages/ui/src/system-snapshot.tsx",
      "packages/ui/src/system-services-store.ts",
      "packages/ui/src/system-shortcut.ts",
    ],
  },
} satisfies Meta

const SURFACES = [
  { id: "app", label: "Lab workspace", icon: SYSTEM_ICONS.emulators },
  { id: "notifications", label: "Notifications", icon: SYSTEM_ICONS.notifications },
]
const surfaces = () =>
  SURFACES.map((surface) => ({
    ...surface,
    mount(panel: HTMLElement) {
      panel.textContent = `${surface.label} is open.`
      return () => panel.replaceChildren()
    },
  }))

const reset = () => {
  localStorage.removeItem(ROTATION_KEY)
  localStorage.removeItem(ORDER_KEY)
  localStorage.removeItem("mockingbird.system-switcher.dock")
}
let stops: (() => void)[] = []
const stopAll = () => {
  for (const stop of stops) stop()
  stops = []
}
const mount = (host: HTMLElement, options: SystemHarnessOptions = {}) => {
  const harness = mountSystemHarness(host, surfaces(), options)
  stops.push(() => harness.destroy())
  return harness
}
const visible = (root: HTMLElement) =>
  root.querySelector("section[data-surface]:not([hidden])")?.getAttribute("data-surface")

// ---- #870: consumer sections and the Data card.

const FLAGS: SystemSection = {
  id: "flags",
  label: "Flags",
  icon: SYSTEM_ICONS.system,
  mount(host) {
    const list = document.createElement("ul")
    list.dataset.testid = "flags"
    for (const [flag, on] of [
      ["new-results-view", true],
      ["sms-reminders", false],
    ] as const) {
      const item = document.createElement("li")
      item.textContent = `${flag}: ${on ? "on" : "off"}`
      list.append(item)
    }
    host.append(list)
    return () => list.remove()
  },
}
const TIMINGS: SystemSection = {
  id: "boot",
  label: "Start-up",
  async mount(host) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    host.textContent = "api: 412 ms · stripe: 88 ms"
    return () => host.replaceChildren()
  },
}

const BUILD = "abc1234"
/** An in-memory state the Data card saves, loads and resets. */
function fakeSnapshot() {
  const calls: string[] = []
  const snapshot: SystemSnapshot = {
    async save() {
      calls.push("save")
      return new Blob([JSON.stringify({ build: BUILD, rows: 3 })], { type: "application/json" })
    },
    async load(file) {
      calls.push(`load ${file.name}`)
      const saved = JSON.parse(await file.text()) as { build?: string }
      if (saved.build !== BUILD)
        throw new Error(`This file was saved by another build (${saved.build}).`)
    },
    async reset() {
      calls.push("reset")
    },
    fileName: () => "lab-state.json",
  }
  return { snapshot, calls }
}

let data = fakeSnapshot()
const consoleOptions = (): SystemHarnessOptions => ({
  syncUrl: true,
  initial: "system",
  sections: [FLAGS, TIMINGS],
  snapshot: data.snapshot,
})

/**
 * A Flags and a Start-up section and the Data card, all on System with no extra surface. The
 * section nav deep-links each one (`?system=flags`), and the link survives a reload.
 */
export const ConsumerSections: StoryObj = {
  render: () => {
    stopAll()
    reset()
    data = fakeSnapshot()
    const host = document.createElement("div")
    host.style.height = "100vh"
    // Drawn without `syncUrl`, so the catalog's own URL is left alone; the play adds it.
    mount(host, { ...consoleOptions(), syncUrl: false })
    return host
  },
  play: async ({ canvasElement }) => {
    const host = canvasElement.firstElementChild as HTMLElement
    const original = location.href
    try {
      stopAll()
      mount(host, consoleOptions())
      const page = within(host)
      const nav = await page.findByRole(
        "navigation",
        { name: "System sections" },
        { timeout: 3000 },
      )
      // No second surface: the arrows still go System, Lab workspace, Notifications.
      await expect(host.querySelectorAll("section[data-surface]")).toHaveLength(3)
      await expect(
        within(nav)
          .getAllByRole("link")
          .map((link) => link.dataset.section),
      ).toEqual(["apps", "services", "data", "flags", "boot"])
      // Built-in sections first, then the consumer's, in order.
      await expect(
        [...host.querySelectorAll<HTMLElement>("[data-system-section]")].map(
          (node) => node.dataset.systemSection,
        ),
      ).toEqual(["apps", "services", "data", "flags", "boot"])
      await expect(await page.findByTestId("flags")).toHaveTextContent("new-results-view: on")
      await expect(await page.findByText("api: 412 ms · stripe: 88 ms")).toBeVisible()
      await expect(within(nav).getByRole("link", { name: "Flags" })).toHaveAttribute(
        "href",
        expect.stringContaining("system=flags"),
      )

      await userEvent.click(within(nav).getByRole("link", { name: "Flags" }))
      await expect(new URL(location.href).searchParams.get("system")).toBe("flags")
      await expect(new URL(location.href).searchParams.get("surface")).toBe("system")
      await expect(within(nav).getByRole("link", { name: "Flags" })).toHaveAttribute(
        "aria-current",
        "location",
      )
      await expect(host.querySelector('[data-system-section="flags"]')).toHaveFocus()

      // A reload at the deep link: a fresh harness on the same URL shows System at Flags.
      stopAll()
      await expect(host.childElementCount).toBe(0)
      mount(host, { ...consoleOptions(), initial: "app" })
      const again = within(host)
      const link = await again.findByRole("link", { name: "Flags" }, { timeout: 3000 })
      await expect(visible(host)).toBe("system")
      await expect(link).toHaveAttribute("aria-current", "location")
      await expect(host.querySelector('[data-system-section="flags"]')).toHaveAttribute(
        "data-current",
      )
      await expect(await again.findByTestId("flags")).toBeVisible()

      // Leaving System drops the section from the URL; the surface's own URL stays clean.
      await userEvent.click(again.getByRole("button", { name: "Next app" }))
      await expect(visible(host)).toBe("app")
      await expect(new URL(location.href).searchParams.has("system")).toBe(false)
    } finally {
      stopAll()
      history.replaceState(null, "", original)
    }
  },
}

/** Save downloads the state; Load and Reset ask first; a load the host rejects says why inline. */
export const DataCard: StoryObj = {
  render: () => {
    stopAll()
    reset()
    data = fakeSnapshot()
    const host = document.createElement("div")
    host.style.height = "100vh"
    mount(host, { sections: [FLAGS], snapshot: data.snapshot })
    return host
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const card = within(await page.findByTestId("system-data", {}, { timeout: 3000 }))
    await expect(card.getByRole("heading", { name: "Data" })).toBeVisible()

    // Save: the host's Blob is downloaded under its file name.
    const downloads: string[] = []
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) downloads.push(this.download)
      else click.call(this)
    }
    try {
      await userEvent.click(card.getByRole("button", { name: "Save" }))
      await waitFor(() => expect(downloads).toEqual(["lab-state.json"]))
    } finally {
      HTMLAnchorElement.prototype.click = click
    }
    await expect(card.getByTestId("system-data-status")).toHaveTextContent("Saved lab-state.json.")

    // Load: a file from another build is refused, with the host's message inline.
    const input = card.getByTestId("system-data-file") as HTMLInputElement
    const other = new File([JSON.stringify({ build: "def5678" })], "bug-report.json", {
      type: "application/json",
    })
    await userEvent.upload(input, other)
    const confirm = card.getByRole("group", { name: "Confirm load" })
    await expect(confirm).toHaveTextContent("Replace this tab's state with bug-report.json?")
    await expect(data.calls).toEqual(["save"])
    await userEvent.click(within(confirm).getByRole("button", { name: "Load" }))
    await expect(await card.findByRole("alert")).toHaveTextContent(
      "This file was saved by another build (def5678).",
    )
    await expect(data.calls).toEqual(["save", "load bug-report.json"])

    // Cancelling a load changes nothing.
    await userEvent.upload(input, other)
    await userEvent.click(card.getByRole("button", { name: "Cancel" }))
    await expect(card.queryByRole("group", { name: "Confirm load" })).toBeNull()
    await expect(data.calls).toEqual(["save", "load bug-report.json"])

    const good = new File([JSON.stringify({ build: BUILD })], "repro.json", {
      type: "application/json",
    })
    await userEvent.upload(input, good)
    await userEvent.click(
      within(card.getByRole("group", { name: "Confirm load" })).getByRole("button", {
        name: "Load",
      }),
    )
    await waitFor(() =>
      expect(card.getByTestId("system-data-status")).toHaveTextContent("Loaded repro.json."),
    )
    await expect(card.queryByRole("alert")).toBeNull()

    // Reset asks first.
    await userEvent.click(card.getByRole("button", { name: "Reset" }))
    const sure = card.getByRole("group", { name: "Confirm reset" })
    await expect(sure).toHaveTextContent("Reset every app and emulator in this tab")
    await expect(within(sure).getByRole("button", { name: "Reset" })).toHaveFocus()
    await userEvent.click(within(sure).getByRole("button", { name: "Reset" }))
    await waitFor(() =>
      expect(card.getByTestId("system-data-status")).toHaveTextContent(
        "Reset to the seeded state.",
      ),
    )
    await expect(data.calls).toEqual(["save", "load bug-report.json", "load repro.json", "reset"])
  },
}

/** A section whose mount fails shows the error with Retry, in that section only. */
export const SectionFails: StoryObj = {
  render: () => {
    stopAll()
    reset()
    let attempts = 0
    const host = document.createElement("div")
    host.style.height = "100vh"
    mount(host, {
      sections: [
        {
          id: "flaky",
          label: "Flaky",
          mount(node) {
            attempts++
            if (attempts === 1) throw new Error("The flag service did not answer.")
            node.textContent = "Flags loaded."
            return () => node.replaceChildren()
          },
        },
      ],
    })
    return host
  },
  play: async ({ canvasElement }) => {
    const section = within(
      await within(canvasElement).findByTestId("system-section-flaky", {}, { timeout: 3000 }),
    )
    await expect(await section.findByText("The flag service did not answer.")).toBeVisible()
    await userEvent.click(section.getByRole("button", { name: "Retry" }))
    await expect(await section.findByText("Flags loaded.")).toBeVisible()
  },
}

// ---- #871: the dev badge, live updates across tabs, last call and Test.

const LAB = [
  { id: "stripe", label: "Stripe", category: "Payments" },
  { id: "twilio", label: "Twilio", category: "SMS" },
  { id: "resend", label: "Resend", category: "Email" },
] as const
/** What the origin's storage holds: one mode per service, shared by every "tab" below. */
const shared = new Map<string, SystemServiceMode>()
const CHANNEL = "mockingbird-story-dev-modes"

/** A tab's SystemServices: modes in shared storage, changes announced over a BroadcastChannel. */
function tabServices(options: { lastCall?: boolean } = {}) {
  const channel = new BroadcastChannel(CHANNEL)
  const listeners = new Set<() => void>()
  channel.onmessage = () => {
    for (const listener of listeners) listener()
  }
  const services: SystemServices = {
    async list() {
      return {
        dev: { state: "ready", message: "Dev proxy connected.", endpoint: "/__dev" },
        services: LAB.map(
          (lab): SystemService => ({
            ...lab,
            mode: shared.get(lab.id) ?? "emulated",
            ...(options.lastCall && lab.id === "stripe"
              ? {
                  lastCall: {
                    at: new Date(Date.now() - 42_000).toISOString(),
                    ok: true,
                    status: 200,
                  },
                }
              : {}),
            ...(options.lastCall && lab.id === "twilio"
              ? {
                  lastCall: {
                    at: new Date(Date.now() - 5_000).toISOString(),
                    ok: false,
                    status: 401,
                  },
                }
              : {}),
          }),
        ),
      }
    },
    async setMode(id, mode) {
      shared.set(id, mode)
      channel.postMessage({ id, mode })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async test(id) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return id === "twilio"
        ? { ok: false, message: "Twilio answered HTTP 401: Authenticate" }
        : { ok: true, message: `${id} answered through the dev proxy (HTTP 200)` }
    },
  }
  stops.push(() => channel.close())
  return services
}

/**
 * Two tabs of one preview side by side. Switching Stripe to Dev in the left tab marks the pill
 * in the right one within a second: a triangle badge on its corner and a label that says so.
 */
export const DevBadgeAcrossTabs: StoryObj = {
  render: () => {
    stopAll()
    reset()
    shared.clear()
    const root = document.createElement("div")
    root.style.cssText = "display:grid;grid-template-columns:1fr 1fr;height:100vh;gap:2px"
    const left = document.createElement("div")
    left.dataset.tab = "left"
    const right = document.createElement("div")
    right.dataset.tab = "right"
    root.append(left, right)
    mount(left, { services: tabServices() })
    mount(right, { services: tabServices(), initial: "app" })
    return root
  },
  play: async ({ canvasElement }) => {
    const left = canvasElement.querySelector<HTMLElement>('[data-tab="left"]')
    const right = canvasElement.querySelector<HTMLElement>('[data-tab="right"]')
    if (!left || !right) throw new Error("no tabs")
    const pill = await within(right).findByTestId("system-switcher", {}, { timeout: 3000 })
    await expect(pill).not.toHaveAttribute("data-dev")
    await expect(within(right).queryByTestId("system-dev-badge")).toBeNull()

    const stripe = await waitFor(
      () => {
        const row = left.querySelector<HTMLElement>('[data-service="stripe"]')
        if (!row) throw new Error("no Stripe row yet")
        return row
      },
      { timeout: 3000 },
    )
    await userEvent.click(within(stripe).getByRole("radio", { name: "Dev" }))
    const started = performance.now()
    await waitFor(() => expect(within(right).getByTestId("system-dev-badge")).toBeVisible(), {
      timeout: 1000,
    })
    await expect(performance.now() - started).toBeLessThan(1000)
    await expect(pill).toHaveAttribute("data-dev")
    await expect(pill).toHaveAccessibleName("Switch apps · not all services emulated")
    await expect(pill).toHaveAccessibleDescription(
      /Stripe is not emulated: it uses its dev resource\./,
    )
    // This tab's own pill follows its own switch too.
    await expect(within(left).getByTestId("system-dev-badge")).toBeVisible()

    // The badge opens System at its services.
    await userEvent.click(within(right).getByTestId("system-dev-badge"))
    await expect(visible(right)).toBe("system")
    await waitFor(() =>
      expect(right.querySelector('[data-system-section="services"]')).toHaveFocus(),
    )
    // The right tab's screen re-listed on the broadcast: Stripe is on Dev there too.
    await waitFor(() =>
      expect(right.querySelector('[data-service="stripe"]')).toHaveAttribute("data-mode", "dev"),
    )

    // Back to Emulated in the right tab: both badges go.
    await userEvent.click(
      within(right.querySelector('[data-service="stripe"]') as HTMLElement).getByRole("radio", {
        name: "Emulated",
      }),
    )
    await waitFor(() => expect(within(left).queryByTestId("system-dev-badge")).toBeNull(), {
      timeout: 1000,
    })
    await waitFor(() => expect(within(right).queryByTestId("system-dev-badge")).toBeNull())
  },
}

/** Each service's last call (when, HTTP status, OK or Failed) and a Test through the dev proxy. */
export const ServiceStatus: StoryObj = {
  render: () => {
    stopAll()
    reset()
    shared.clear()
    shared.set("twilio", "dev")
    const host = document.createElement("div")
    host.style.height = "100vh"
    mount(host, { services: tabServices({ lastCall: true }) })
    return host
  },
  play: async ({ canvasElement }) => {
    const row = async (id: string) =>
      within(
        await waitFor(
          () => {
            const found = canvasElement.querySelector<HTMLElement>(`[data-service="${id}"]`)
            if (!found) throw new Error(`no ${id} row`)
            return found
          },
          { timeout: 3000 },
        ),
      )
    const stripe = await row("stripe")
    await expect(stripe.getByTestId("system-service-last-call")).toHaveTextContent(
      /Last call 4\d s ago · HTTP 200/,
    )
    await expect(stripe.getByTestId("system-service-last-call")).toHaveAttribute("data-ok", "true")
    const twilio = await row("twilio")
    await expect(twilio.getByTestId("system-service-last-call")).toHaveAttribute("data-ok", "false")
    await expect(twilio.getByText("Failed")).toBeVisible()
    await expect((await row("resend")).queryByTestId("system-service-last-call")).toBeNull()

    await userEvent.click(stripe.getByRole("button", { name: "Test Stripe" }))
    await expect(stripe.getByTestId("system-service-test-result")).toHaveTextContent(
      "Testing Stripe through the dev proxy…",
    )
    await waitFor(() =>
      expect(stripe.getByTestId("system-service-test-result")).toHaveAttribute("data-ok", "true"),
    )
    await expect(stripe.getByTestId("system-service-test-result")).toHaveTextContent(
      "Test passed: stripe answered through the dev proxy (HTTP 200)",
    )
    await userEvent.click(twilio.getByRole("button", { name: "Test Twilio" }))
    await waitFor(() =>
      expect(twilio.getByTestId("system-service-test-result")).toHaveTextContent(
        "Test failed: Twilio answered HTTP 401: Authenticate",
      ),
    )
  },
}

// ---- #872: long-press, right-click and the keyboard shortcut.

const point = (target: Element, type: string, x: number, y: number, pointerType = "touch") =>
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 11,
      pointerType,
      clientX: x,
      clientY: y,
    }),
  )
const shortcut = (init: KeyboardEventInit) =>
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  )

/**
 * From any surface, one long-press, one right-click or Alt+Shift+S shows System; a drag of the
 * pill never does, however long it is held.
 */
export const OpenSystemFromPill: StoryObj = {
  render: () => {
    stopAll()
    reset()
    const host = document.createElement("div")
    host.style.height = "100vh"
    mount(host, { initial: "app" })
    return host
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const pill = await page.findByRole("group", { name: "Switch apps" }, { timeout: 3000 })
    await expect(pill).toHaveAccessibleDescription(
      "Long-press or right-click to open System, or press Alt+Shift+S.",
    )
    const next = page.getByRole("button", { name: "Next app" })
    const at = () => {
      const rect = next.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }

    // Long-press on an arrow: System opens, and the click that ends the press does not step on.
    await expect(visible(canvasElement)).toBe("app")
    let { x, y } = at()
    point(next, "pointerdown", x, y)
    await new Promise((resolve) => setTimeout(resolve, 650))
    point(next, "pointerup", x, y)
    next.click()
    await expect(visible(canvasElement)).toBe("system")
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A short press is still a plain arrow press.
    await userEvent.click(next)
    await expect(visible(canvasElement)).toBe("app")

    // Right-click (or the context-menu key) opens System instead of the browser's menu.
    await userEvent.click(next)
    await expect(visible(canvasElement)).toBe("notifications")
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
    next.dispatchEvent(menu)
    await expect(menu.defaultPrevented).toBe(true)
    await expect(visible(canvasElement)).toBe("system")

    // The shortcut, from anywhere in the page, from any surface.
    await userEvent.click(next)
    await expect(visible(canvasElement)).toBe("app")
    shortcut({ key: "S", code: "KeyS", altKey: true, shiftKey: true })
    await waitFor(() => expect(visible(canvasElement)).toBe("system"))
    await userEvent.click(next)
    await expect(visible(canvasElement)).toBe("app")
    // Option+Shift+S on a Mac reports another character; the key's code still matches.
    shortcut({ key: "Í", code: "KeyS", altKey: true, shiftKey: true })
    await waitFor(() => expect(visible(canvasElement)).toBe("system"))

    // A drag held still for longer than a long-press never opens System.
    await userEvent.click(next)
    await expect(visible(canvasElement)).toBe("app")
    ;({ x, y } = at())
    point(next, "pointerdown", x, y)
    for (let step = 1; step <= 6; step++) point(next, "pointermove", x + step * 10, y + step * 6)
    await new Promise((resolve) => setTimeout(resolve, 700))
    point(next, "pointerup", x + 60, y + 36)
    next.click()
    await expect(visible(canvasElement)).toBe("app")
  },
}

/** `systemShortcut` sets another shortcut, or `false` turns it off; the description follows. */
export const CustomShortcut: StoryObj = {
  render: () => {
    stopAll()
    reset()
    const root = document.createElement("div")
    root.style.cssText = "display:grid;grid-template-columns:1fr 1fr;height:100vh;gap:2px"
    const custom = document.createElement("div")
    custom.dataset.tab = "custom"
    const off = document.createElement("div")
    off.dataset.tab = "off"
    root.append(custom, off)
    mount(custom, { initial: "app", systemShortcut: "Ctrl+Shift+K" })
    mount(off, { initial: "app", systemShortcut: false })
    return root
  },
  play: async ({ canvasElement }) => {
    const custom = canvasElement.querySelector<HTMLElement>('[data-tab="custom"]')
    const off = canvasElement.querySelector<HTMLElement>('[data-tab="off"]')
    if (!custom || !off) throw new Error("no harnesses")
    await expect(
      await within(custom).findByRole("group", { name: "Switch apps" }, { timeout: 3000 }),
    ).toHaveAccessibleDescription(
      "Long-press or right-click to open System, or press Ctrl+Shift+K.",
    )
    await expect(
      await within(off).findByRole("group", { name: "Switch apps" }),
    ).toHaveAccessibleDescription("Long-press or right-click to open System.")
    shortcut({ key: "S", code: "KeyS", altKey: true, shiftKey: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(visible(custom)).toBe("app")
    await expect(visible(off)).toBe("app")
    shortcut({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(visible(custom)).toBe("system"))
    await expect(visible(off)).toBe("app")
    // An unparseable shortcut fails at mount, not on the first key press.
    const host = document.createElement("div")
    await expect(() => mountSystemHarness(host, [], { systemShortcut: "Hyper+K" })).toThrow(
      "unknown modifier Hyper",
    )
  },
}
