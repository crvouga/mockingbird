import { mount } from "@crvouga/mockingbird-ui/react/client"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { createElement } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { PreviewCard } from "../../../../packages/ui/src/system-build.js"
import {
  mountSystemHarness,
  type SystemBuild,
  type SystemBuildState,
} from "../../../../packages/ui/src/system-harness.js"
import { SYSTEM_ICONS } from "../../../../packages/ui/src/system-icons.js"
import { ORDER_KEY, ROTATION_KEY } from "../../../../packages/ui/src/system-rotation.js"
import { frame, frameDocument } from "../../src/frame.js"

/**
 * A live PR preview that knows about CI: the switcher's status dot, the update toast beside the
 * bar, and the Preview card at the top of the System screen. The build comes from a fake,
 * controllable `SystemBuild` (the lab's preview uses `createLivePreview()`).
 */
export default {
  title: "Examples/System harness/Live preview",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-build.tsx",
      "packages/ui/src/system-build-status.ts",
      "packages/ui/src/system-harness.ts",
      "packages/ui/src/system-view.tsx",
    ],
  },
} satisfies Meta

const THIS = "4f9c2a1e7b3d5f60a8c9e1d2b3a4f5e6c7d8e9f0"
const NEXT = "b81e07c4d2a95f3e6c1b8a7d0e9f2c3b4a5d6e7f"
const PR = { number: 827, url: "https://github.com/crvouga/mockingbird/pull/827" }
const RUN = "https://github.com/crvouga/mockingbird/actions/runs/123456789"

const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const seconds = (n: number) => new Date(Date.now() - n * 1000).toISOString()

type Scenario =
  | "live"
  | "building"
  | "ready"
  | "auto-off"
  | "failed"
  | "checks-failed"
  | "polling"
  | "offline"
  | "applying"
  | "error"
  | "resets-data"

function scenario(name: Scenario): SystemBuildState {
  const upToDate: SystemBuildState = {
    current: { version: THIS, builtAt: minutes(3) },
    latest: { version: THIS, at: minutes(2) },
    build: { state: "deployed", version: THIS, at: minutes(2), url: RUN },
    checks: {
      state: "passed",
      version: THIS,
      at: minutes(1),
      url: `${PR.url}/checks`,
      summary: "14 of 14 passed",
    },
    connection: "live",
    checkedAt: seconds(1),
    update: { available: false, applying: false, auto: true },
    pr: PR,
  }
  const ready: SystemBuildState = {
    ...upToDate,
    latest: { version: NEXT, at: seconds(20) },
    build: { state: "deployed", version: NEXT, at: seconds(20), url: RUN },
    checks: {
      state: "running",
      version: NEXT,
      at: seconds(50),
      url: `${PR.url}/checks`,
      summary: "9 of 14 done",
    },
    update: {
      available: true,
      applying: false,
      auto: true,
      autoApplyAt: new Date(Date.now() + 45_000).toISOString(),
    },
  }
  switch (name) {
    case "live":
      return upToDate
    case "building":
      return {
        ...upToDate,
        build: { state: "building", version: NEXT, at: seconds(40), url: RUN },
        checks: {
          state: "running",
          version: NEXT,
          at: seconds(40),
          url: `${PR.url}/checks`,
          summary: "3 of 14 done",
        },
      }
    case "ready":
      return ready
    case "auto-off":
      return { ...ready, update: { available: true, applying: false, auto: false } }
    case "failed":
      return {
        ...upToDate,
        build: {
          state: "failed",
          version: NEXT,
          at: minutes(1),
          url: RUN,
          message: "bun run build-preview exited with code 1",
        },
        checks: {
          state: "failed",
          version: NEXT,
          at: minutes(1),
          url: `${PR.url}/checks`,
          summary: "Build failed before tests ran",
        },
      }
    case "checks-failed":
      return {
        ...upToDate,
        checks: {
          state: "failed",
          version: THIS,
          at: minutes(1),
          url: `${PR.url}/checks`,
          summary: "11 of 14 passed",
        },
      }
    case "polling":
      return { ...upToDate, connection: "polling", checkedAt: seconds(12) }
    case "offline":
      return { ...upToDate, connection: "offline", checkedAt: minutes(2) }
    case "applying":
      return { ...ready, update: { ...ready.update, applying: true } }
    case "resets-data":
      // The new build changes the shape of the in-tab data: it waits, with no countdown.
      return {
        ...ready,
        update: { available: true, applying: false, auto: true, resetsData: true },
      }
    case "error":
      return {
        ...ready,
        update: {
          available: true,
          applying: false,
          auto: true,
          error: "The new bundle did not load (HTTP 503).",
        },
      }
  }
}

type Fake = {
  build: SystemBuild
  set(patch: Partial<SystemBuildState>): void
  calls: { apply: number; postpone: number; auto: boolean[] }
}

/** A SystemBuild the story drives: applying takes `delay` ms and fails with `fail` when given. */
function fakeBuild(
  initial: SystemBuildState,
  { delay = 500, fail }: { delay?: number; fail?: string } = {},
): Fake {
  let state = initial
  const listeners = new Set<(state: SystemBuildState) => void>()
  const calls = { apply: 0, postpone: 0, auto: [] as boolean[] }
  const set = (patch: Partial<SystemBuildState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }
  return {
    calls,
    set,
    build: {
      get: () => state,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async applyUpdate() {
        calls.apply++
        const { error: _, ...update } = state.update
        set({ update: { ...update, applying: true } })
        await new Promise((resolve) => setTimeout(resolve, delay))
        if (fail) {
          set({ update: { ...update, applying: false, error: fail } })
          return
        }
        const latest = state.latest ?? { version: state.current.version, at: state.current.builtAt }
        set({
          current: { version: latest.version, builtAt: latest.at },
          checkedAt: new Date().toISOString(),
          update: { available: false, applying: false, auto: state.update.auto },
        })
      },
      postpone() {
        calls.postpone++
        const { autoApplyAt: _, ...update } = state.update
        set({ update })
      },
      setAutoUpdate(on) {
        calls.auto.push(on)
        const { autoApplyAt: _, ...update } = state.update
        set({
          update: {
            ...update,
            auto: on,
            ...(on && update.available
              ? { autoApplyAt: new Date(Date.now() + 10_000).toISOString() }
              : {}),
          },
        })
      },
    },
  }
}

const SURFACES = [
  {
    id: "app",
    label: "Lab workspace",
    description: "The patient, clinician and admin app, signed out and seeded with demo data.",
    icon: { src: "./favicon.svg" },
  },
  {
    id: "emulators",
    label: "Emulators",
    description: "The admin UI of every emulator: state, requests, clock, faults and SQL.",
    icon: SYSTEM_ICONS.emulators,
  },
]

let stop: (() => void) | undefined
let fake: Fake | undefined
const live =
  (name: Scenario, options: { delay?: number; fail?: string; initial?: string } = {}) =>
  () => {
    stop?.()
    for (const key of [ROTATION_KEY, ORDER_KEY, "mockingbird.system-switcher.dock"])
      localStorage.removeItem(key)
    const host = document.createElement("div")
    host.style.height = "100vh"
    fake = fakeBuild(scenario(name), options)
    const harness = mountSystemHarness(
      host,
      SURFACES.map((surface) => ({
        ...surface,
        mount(panel: HTMLElement) {
          panel.textContent = `${surface.label} is open.`
          return () => panel.replaceChildren()
        },
      })),
      { build: fake.build, ...(options.initial ? { initial: options.initial } : {}) },
    )
    stop = () => harness.destroy()
    return host
  }
const control = () => {
  if (!fake) throw new Error("No fake build mounted")
  return fake
}

const dot = (canvas: HTMLElement) => within(canvas).getByTestId("system-build-dot")
const toast = (canvas: HTMLElement) => within(canvas).getByTestId("system-update-toast")
const card = async (canvas: HTMLElement) =>
  within(await within(canvas).findByTestId("system-preview"))
const value = (canvas: HTMLElement, row: string) => {
  const found = canvas.querySelector<HTMLElement>(
    `[data-testid="system-preview"] [data-row="${row}"] dd`,
  )
  if (!found) throw new Error(`No ${row} row`)
  return found
}
const rect = (node: Element) => {
  const { left, top, width, height } = node.getBoundingClientRect()
  return { left, top, width, height }
}
const overlaps = (a: Element, b: Element) => {
  const x = a.getBoundingClientRect()
  const y = b.getBoundingClientRect()
  return x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom
}
const surface = (canvas: HTMLElement) =>
  canvas.querySelector("section[data-surface]:not([hidden])")?.getAttribute("data-surface")

/** Up to date and live: a green dot on the bar, every row of the Preview card filled in. */
export const UpToDate: StoryObj = {
  render: live("live"),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const preview = await card(canvasElement)
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "ok")
    await expect(dot(canvasElement)).toHaveAttribute("data-live", "true")
    await expect(dot(canvasElement)).toHaveAccessibleName("Preview status: Up to date · live")
    await expect(toast(canvasElement)).not.toBeVisible()

    await expect(preview.getByRole("heading", { name: "Preview" })).toBeVisible()
    await expect(preview.getByRole("link", { name: /PR #827/ })).toHaveAttribute("href", PR.url)
    await expect(value(canvasElement, "tab")).toHaveTextContent("4f9c2a1")
    await expect(value(canvasElement, "tab")).toHaveTextContent("built 3 min ago")
    const built = value(canvasElement, "tab").querySelector("time")
    await expect(built?.dateTime).toBe(control().build.get().current.builtAt)
    await expect(built?.title).not.toBe("")
    await expect(value(canvasElement, "latest")).toHaveTextContent("This tab is up to date")
    await expect(value(canvasElement, "build")).toHaveTextContent("Deployed")
    await expect(
      within(value(canvasElement, "build")).getByRole("link", { name: /View build run/ }),
    ).toHaveAttribute("href", RUN)
    await expect(value(canvasElement, "checks")).toHaveTextContent("Passed")
    await expect(value(canvasElement, "checks")).toHaveTextContent("14 of 14 passed")
    await expect(
      within(value(canvasElement, "checks")).getByRole("link", { name: /View checks/ }),
    ).toHaveAttribute("href", `${PR.url}/checks`)
    await expect(value(canvasElement, "connection")).toHaveTextContent("Live")
    await expect(preview.getByRole("switch", { name: "Auto-update" })).toBeChecked()
    await expect(preview.getByRole("button", { name: "Update now" })).toBeDisabled()

    // The dot's tooltip, then a click opens System from another app.
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    await expect(surface(canvasElement)).toBe("app")
    dot(canvasElement).dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }))
    await expect(page.getByRole("tooltip")).toHaveTextContent("Up to date · live")
    await userEvent.click(dot(canvasElement))
    await waitFor(() => expect(surface(canvasElement)).toBe("system"))
    // Reloads nothing: the page around a full-height shell never scrolls.
    await expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight)
  },
}

/** A newer commit is building: an amber spinning dot; the bar keeps its size whatever the dot shows. */
export const Building: StoryObj = {
  render: live("building"),
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    const switcher = within(canvasElement).getByTestId("system-switcher")
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "building")
    await expect(dot(canvasElement)).toHaveAccessibleName("Preview status: Building b81e07c")
    await expect(value(canvasElement, "build")).toHaveTextContent("Building")
    await expect(value(canvasElement, "build").querySelector("[data-busy]")).not.toBeNull()
    await expect(value(canvasElement, "latest")).toHaveTextContent("This tab is up to date")
    await expect(toast(canvasElement)).not.toBeVisible()

    const before = rect(switcher)
    for (const name of ["ready", "failed", "offline", "live", "building"] as const) {
      control().set(scenario(name))
      await expect(rect(switcher)).toEqual(before)
    }
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "building")
  },
}

/** A new version is deployed: the toast beside the bar counts down to updating itself. */
export const UpdateReady: StoryObj = {
  render: live("ready"),
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    const note = toast(canvasElement)
    await expect(note).toBeVisible()
    await expect(note).toHaveAttribute("role", "status")
    await expect(note).toHaveTextContent(/^New version b81e07c ready · updating in \d+s/)
    const count = () => Number(/updating in (\d+)s/.exec(note.textContent ?? "")?.[1])
    const first = count()
    await waitFor(() => expect(count()).toBeLessThan(first), { timeout: 2500 })
    await waitFor(() =>
      expect(overlaps(note, within(canvasElement).getByTestId("system-switcher"))).toBe(false),
    )
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "ready")
    await expect(dot(canvasElement)).toHaveAccessibleName(
      /^Preview status: New version b81e07c ready · updating in \d+s$/,
    )
    await expect(value(canvasElement, "latest")).toHaveTextContent("b81e07c")
    await expect(value(canvasElement, "latest")).toHaveTextContent("New")
    const preview = within(within(canvasElement).getByTestId("system-preview"))
    await expect(preview.getByRole("button", { name: "Update now" })).toBeEnabled()
  },
}

/** Update now: the toast says Updating…, then disappears once the new version runs in this tab. */
export const UpdateNow: StoryObj = {
  render: live("ready", { delay: 600 }),
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    const note = toast(canvasElement)
    await userEvent.click(within(note).getByRole("button", { name: "Update now" }))
    await expect(control().calls.apply).toBe(1)
    await expect(note).toHaveTextContent("Updating…")
    await expect(dot(canvasElement)).toHaveAccessibleName("Preview status: Updating to b81e07c…")
    await waitFor(() => expect(note).not.toBeVisible(), { timeout: 3000 })
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "ok")
    await expect(value(canvasElement, "tab")).toHaveTextContent("b81e07c")
    await expect(value(canvasElement, "latest")).toHaveTextContent("This tab is up to date")
  },
}

/** Not now: the toast goes away and the countdown stops; System's Update now still applies it. */
export const NotNow: StoryObj = {
  render: live("ready"),
  play: async ({ canvasElement }) => {
    const preview = await card(canvasElement)
    const note = toast(canvasElement)
    await userEvent.click(within(note).getByRole("button", { name: "Not now" }))
    await expect(control().calls.postpone).toBe(1)
    await expect(note).not.toBeVisible()
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "ready")
    await expect(dot(canvasElement)).toHaveAccessibleName(
      "Preview status: New version b81e07c ready",
    )
    await expect(preview.getByRole("button", { name: "Update now" })).toBeEnabled()
    // A newer version brings it back.
    control().set({
      latest: { version: "c0ffee1234567890abcdef1234567890abcdef12", at: new Date().toISOString() },
    })
    await expect(note).toBeVisible()
    await expect(note).toHaveTextContent("New version c0ffee1 ready")
  },
}

/** Auto-update off: no countdown; the switch turns it back on. */
export const AutoUpdateOff: StoryObj = {
  render: live("auto-off"),
  play: async ({ canvasElement }) => {
    const preview = await card(canvasElement)
    const note = toast(canvasElement)
    await expect(note).toHaveTextContent("New version b81e07c ready")
    await expect(note).not.toHaveTextContent("updating in")
    const toggle = preview.getByRole("switch", { name: "Auto-update" })
    await expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await expect(control().calls.auto).toEqual([true])
    await expect(toggle).toBeChecked()
    await expect(note).toHaveTextContent(/updating in \d+s/)
    toggle.focus()
    await userEvent.keyboard(" ")
    await expect(control().calls.auto).toEqual([true, false])
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toHaveFocus()
    await expect(note).not.toHaveTextContent("updating in")
  },
}

/** The newest commit's build failed: a red dot, the reason and a link to the run. */
export const BuildFailed: StoryObj = {
  render: live("failed"),
  play: async ({ canvasElement }) => {
    const preview = await card(canvasElement)
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "failed")
    await expect(dot(canvasElement)).toHaveAccessibleName(
      "Preview status: Build for b81e07c failed",
    )
    await expect(
      within(preview.getByTestId("system-preview-state")).getByText("Build failed"),
    ).toBeVisible()
    await expect(value(canvasElement, "build")).toHaveTextContent("Failed")
    await expect(value(canvasElement, "build")).toHaveTextContent(
      "bun run build-preview exited with code 1",
    )
    await expect(
      within(value(canvasElement, "build")).getByRole("link", { name: /View build run/ }),
    ).toHaveAttribute("href", RUN)
    await expect(toast(canvasElement)).not.toBeVisible()
  },
}

/** This tab is current but its checks failed: said on the dot's label and in the Checks row. */
export const ChecksFailed: StoryObj = {
  render: live("checks-failed"),
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    await expect(dot(canvasElement)).toHaveAccessibleName(
      "Preview status: Up to date · checks failed · live",
    )
    await expect(value(canvasElement, "checks")).toHaveTextContent("Failed")
    await expect(value(canvasElement, "checks")).toHaveTextContent("11 of 14 passed")
    await expect(
      within(value(canvasElement, "checks")).getByRole("link", { name: /View checks/ }),
    ).toBeVisible()
  },
}

/** The socket is down: status is polled every 15 s and the dot stops pulsing. */
export const Polling: StoryObj = {
  render: live("polling"),
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    await expect(dot(canvasElement)).toHaveAttribute("data-live", "false")
    await expect(dot(canvasElement)).toHaveAccessibleName("Preview status: Up to date · polling")
    await expect(value(canvasElement, "connection")).toHaveTextContent("Polling every 15 s")
    await expect(value(canvasElement, "connection")).toHaveTextContent("checked 12 s ago")
  },
}

/** Nothing answers: a grey dot and when status was last seen. */
export const Offline: StoryObj = {
  render: live("offline"),
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "offline")
    await expect(dot(canvasElement)).toHaveAccessibleName(
      "Preview status: Offline · last checked 2 min ago",
    )
    await expect(value(canvasElement, "connection")).toHaveTextContent("Offline")
    await expect(value(canvasElement, "connection")).toHaveTextContent("last checked 2 min ago")
  },
}

/** Mid-update: the toast and Update now both say Updating…, with nothing to press. */
export const Applying: StoryObj = {
  render: live("applying"),
  play: async ({ canvasElement }) => {
    const preview = await card(canvasElement)
    // Said only once the update has taken a moment (`APPLYING_TOAST_DELAY_MS`).
    await waitFor(() => expect(toast(canvasElement)).toBeVisible())
    await expect(toast(canvasElement)).toHaveTextContent("Updating…")
    await expect(within(toast(canvasElement)).queryByRole("button")).toBeNull()
    await expect(preview.getByRole("button", { name: "Updating…" })).toBeDisabled()
    await expect(
      within(preview.getByTestId("system-preview-state")).getByText("Updating"),
    ).toBeVisible()
  },
}

/**
 * A dev server's update: applied the moment it is built and done within a moment. Nothing pops
 * up; the dot is the only thing that moves, and the tab ends on the new version.
 */
export const InstantUpdate: StoryObj = {
  render: live("live", { delay: 150 }),
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    const note = toast(canvasElement)
    let shown = false
    const watch = new MutationObserver(() => {
      shown ||= !note.hidden
    })
    watch.observe(note, { attributes: true, attributeFilter: ["hidden"] })
    const state = control().build.get()
    control().set({
      latest: { version: NEXT, at: new Date().toISOString() },
      // As `createLivePreview({ countdownMs: 0 })` reports it: available and applying at once.
      update: { ...state.update, available: true, applying: true },
    })
    await control().build.applyUpdate()
    watch.disconnect()
    await expect(shown).toBe(false)
    await expect(note).not.toBeVisible()
    await expect(value(canvasElement, "tab")).toHaveTextContent("b81e07c")
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "ok")
  },
}

/** The update failed: the toast and the card say why, and Retry tries again. */
export const ApplyError: StoryObj = {
  render: live("error", { delay: 300, fail: "The new bundle did not load (HTTP 503)." }),
  play: async ({ canvasElement }) => {
    const preview = await card(canvasElement)
    const note = toast(canvasElement)
    await expect(note).toHaveTextContent(
      "Couldn't update to b81e07c. The new bundle did not load (HTTP 503).",
    )
    await expect(preview.getByRole("alert")).toHaveTextContent(
      "Couldn't update to b81e07c: The new bundle did not load (HTTP 503).",
    )
    await expect(dot(canvasElement)).toHaveAttribute("data-tone", "failed")
    await userEvent.click(within(note).getByRole("button", { name: "Retry" }))
    await expect(control().calls.apply).toBe(1)
    await waitFor(() => expect(within(note).getByRole("button", { name: "Retry" })).toBeVisible(), {
      timeout: 3000,
    })
    await expect(preview.getByRole("button", { name: "Retry update" })).toBeEnabled()
  },
}

/** Relative times tick in place: the same `<time>` element, new text, the card never redrawn. */
export const TimesTick: StoryObj = {
  render: () => {
    const render = live("live")
    const host = render()
    control().set({ current: { version: THIS, builtAt: seconds(20) }, checkedAt: seconds(20) })
    return host
  },
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    const section = within(canvasElement).getByTestId("system-preview")
    const time = value(canvasElement, "tab").querySelector("time")
    if (!time) throw new Error("No time")
    const first = time.textContent
    await expect(first).toMatch(/^built \d+ s ago$/)
    await waitFor(() => expect(time.textContent).not.toBe(first), { timeout: 2500 })
    await expect(time.isConnected).toBe(true)
    await expect(value(canvasElement, "tab").querySelector("time")).toBe(time)
    await expect(within(canvasElement).getByTestId("system-preview")).toBe(section)
  },
}

/** On a phone: the card's rows stack, and the toast sits beside or below the bar, never over it. */
export const Phone: StoryObj = {
  render: live("ready"),
  globals: { viewport: { value: "phone" } },
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    const note = toast(canvasElement)
    await expect(note).toBeVisible()
    await waitFor(() =>
      expect(overlaps(note, within(canvasElement).getByTestId("system-switcher"))).toBe(false),
    )
    const shell = canvasElement.querySelector<HTMLElement>(".msh")
    if (!shell) throw new Error("No shell")
    const box = shell.getBoundingClientRect()
    const area = note.getBoundingClientRect()
    await expect(area.left).toBeGreaterThanOrEqual(box.left)
    await expect(area.right).toBeLessThanOrEqual(box.right)
    const panel = canvasElement.querySelector<HTMLElement>('section[data-surface="system"]')
    if (!panel) throw new Error("No System panel")
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth)
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    )
    await expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight)
  },
}

/**
 * The new version resets this preview's data (its `stateVersion` differs): the toast says so and
 * never counts down, even with auto-update on; the card says it too, and Update now still applies it.
 */
export const ResetsData: StoryObj = {
  render: live("resets-data", { delay: 300 }),
  play: async ({ canvasElement }) => {
    const preview = await card(canvasElement)
    const note = toast(canvasElement)
    await expect(note).toBeVisible()
    await expect(note).toHaveAttribute("data-resets-data", "true")
    await expect(note).toHaveTextContent(/^New version b81e07c resets this preview's data/)
    await expect(note).not.toHaveTextContent("updating in")
    await expect(preview.getByRole("switch", { name: "Auto-update" })).toBeChecked()
    const notice = within(preview.getByTestId("system-preview-resets-data"))
    await expect(notice.getByText("New version b81e07c resets this preview's data")).toBeVisible()
    await expect(notice.getByText(/It won't update on its own/)).toBeVisible()
    // Without a snapshot there is nothing to save.
    await expect(notice.queryByRole("button", { name: "Save" })).toBeNull()
    await waitFor(() =>
      expect(overlaps(note, within(canvasElement).getByTestId("system-switcher"))).toBe(false),
    )
    // A second later it still waits.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await expect(control().calls.apply).toBe(0)
    await expect(note).not.toHaveTextContent("updating in")
    await userEvent.click(within(note).getByRole("button", { name: "Update now" }))
    await expect(control().calls.apply).toBe(1)
    await waitFor(() => expect(note).not.toBeVisible(), { timeout: 3000 })
    await expect(preview.queryByTestId("system-preview-resets-data")).toBeNull()
  },
}

/** On a phone: the longer "resets this preview's data" toast still sits beside the bar, never over it. */
export const ResetsDataPhone: StoryObj = {
  render: live("resets-data"),
  globals: { viewport: { value: "phone" } },
  play: async ({ canvasElement }) => {
    await card(canvasElement)
    const note = toast(canvasElement)
    await expect(note).toHaveTextContent("resets this preview's data")
    await waitFor(() =>
      expect(overlaps(note, within(canvasElement).getByTestId("system-switcher"))).toBe(false),
    )
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    )
  },
}

let saved = 0
/**
 * The Preview card on its own, with the screen's snapshot: Save downloads the in-tab data before
 * an update that resets it, then Update now applies it. A failing save says why.
 */
const cardWithSnapshot = (fail?: string) => () => {
  saved = 0
  fake = fakeBuild(scenario("resets-data"), { delay: 300 })
  const build = fake.build
  const snapshot = {
    async save() {
      saved++
      await new Promise((resolve) => setTimeout(resolve, 150))
      if (fail) throw new Error(fail)
      return new Blob(['{"patients":3}'], { type: "application/json" })
    },
  }
  const iframe = frame(
    renderPage(createElement("div", { id: "card", style: { padding: "16px" } }), {
      title: "Preview card",
      css: MOCKINGBIRD_CSS,
    }),
  )
  iframe.addEventListener(
    "load",
    () => {
      const host = iframe.contentDocument?.getElementById("card")
      if (host) mount(host, createElement(PreviewCard, { build, snapshot }))
    },
    { once: true },
  )
  return iframe
}

const frameCard = async (canvasElement: HTMLElement) => {
  const doc = await frameDocument(canvasElement)
  await waitFor(() => expect(doc.querySelector('[data-testid="system-preview"]')).not.toBeNull())
  return within(doc.querySelector<HTMLElement>('[data-testid="system-preview"]') as HTMLElement)
}

export const ResetsDataSaveFirst: StoryObj = {
  render: cardWithSnapshot(),
  play: async ({ canvasElement }) => {
    const preview = await frameCard(canvasElement)
    const notice = within(preview.getByTestId("system-preview-resets-data"))
    await expect(notice.getByText(/Save the data first/)).toBeVisible()
    await userEvent.click(notice.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(notice.getByRole("button", { name: "Save again" })).toBeVisible())
    await expect(saved).toBe(1)
    await expect(notice.getByText(/Saved\./)).toBeVisible()
    await userEvent.click(preview.getByRole("button", { name: "Update now" }))
    await expect(control().calls.apply).toBe(1)
    await waitFor(() => expect(preview.queryByTestId("system-preview-resets-data")).toBeNull(), {
      timeout: 3000,
    })
  },
}

export const ResetsDataSaveFailed: StoryObj = {
  render: cardWithSnapshot("The database is busy."),
  play: async ({ canvasElement }) => {
    const preview = await frameCard(canvasElement)
    const notice = within(preview.getByTestId("system-preview-resets-data"))
    await userEvent.click(notice.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(notice.getByText(/Couldn't save: The database is busy\./)).toBeVisible(),
    )
    await expect(control().calls.apply).toBe(0)
    await expect(preview.getByRole("button", { name: "Update now" })).toBeEnabled()
  },
}
