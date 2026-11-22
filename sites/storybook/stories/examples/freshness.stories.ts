import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  type BuildIdentity,
  type FreshnessStatus,
  watchFreshness,
} from "../../../../packages/adapters/preview/src/freshness.js"
import {
  type FreshnessFeed,
  type FreshnessUpdatePlan,
  type FreshnessValue,
  freshnessBuild,
  mountFreshnessIndicator,
} from "../../../../packages/ui/src/freshness-indicator.js"
import { mountSystemHarness } from "../../../../packages/ui/src/system-harness.js"
import { SYSTEM_ICONS } from "../../../../packages/ui/src/system-icons.js"
import { ORDER_KEY, ROTATION_KEY } from "../../../../packages/ui/src/system-rotation.js"

/**
 * Freshness: an open tab learns that a newer build of its app is building, live or failed. The
 * indicator is fed by `watchFreshness()` (here against a scripted status document); in the shell,
 * `freshnessBuild()` turns the same signal into the switcher's dot and the System screen's card.
 */
export default {
  title: "Examples/System harness/Freshness",
  parameters: {
    layout: "padded",
    sources: [
      "packages/ui/src/freshness-indicator.ts",
      "packages/adapters/preview/src/freshness.ts",
    ],
  },
} satisfies Meta

const A = "4f9c2a1e7b3d5f60a8c9e1d2b3a4f5e6c7d8e9f0"
const B = "b81e07c4d2a95f3e6c1b8a7d0e9f2c3b4a5d6e7f"
const RUN = "https://github.com/acme/shop/actions/runs/123456789"
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const running: BuildIdentity = {
  commit: A,
  builtAt: ago(40),
  parts: { shop: "sha256-shop-1", admin: "sha256-admin-1", emulators: "sha256-emu-1" },
}
const oneApp: BuildIdentity = {
  commit: B,
  builtAt: ago(1),
  parts: { ...running.parts, shop: "sha256-shop-2" },
}
const many: BuildIdentity = {
  commit: B,
  builtAt: ago(1),
  parts: { shop: "sha256-shop-2", admin: "sha256-admin-2", emulators: "sha256-emu-1" },
}
const building: FreshnessStatus = {
  current: running,
  next: { state: "building", commit: B, startedAt: ago(2), run: RUN },
}
const failed: FreshnessStatus = {
  current: running,
  next: { state: "failed", commit: B, startedAt: ago(6), run: RUN },
}

/** A status document the story scripts, read by the real `watchFreshness()`. */
function scripted(initial: FreshnessStatus | Error) {
  let answer = initial
  const watch = watchFreshness({
    running,
    interval: 200,
    maxBackoff: 400,
    source: async () => {
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  return {
    watch,
    set(next: FreshnessStatus | Error) {
      answer = next
      void watch.check()
    },
  }
}

let stop: (() => void) | undefined
let control: ReturnType<typeof scripted> | undefined
const updates: FreshnessUpdatePlan[] = []

const indicator = (status: FreshnessStatus | Error) => () => {
  stop?.()
  updates.length = 0
  control = scripted(status)
  const host = document.createElement("div")
  host.style.maxWidth = "560px"
  const mounted = mountFreshnessIndicator(host, {
    freshness: control.watch,
    onUpdate: async (plan) => {
      updates.push(plan)
      await new Promise((resolve) => setTimeout(resolve, 300))
    },
    compareUrl: (from, to) => `https://github.com/acme/shop/compare/${from}...${to}`,
  })
  stop = () => {
    mounted.destroy()
    control?.watch.stop()
  }
  return host
}
const box = (canvas: HTMLElement) => within(canvas).getByTestId("freshness")
const settle = (canvas: HTMLElement, state: FreshnessValue["state"]) =>
  waitFor(() => expect(box(canvas)).toHaveAttribute("data-state", state))

/** Running the current build: nothing is shown. */
export const Current: StoryObj = {
  render: indicator({ current: running }),
  play: async ({ canvasElement }) => {
    await settle(canvasElement, "current")
    await expect(box(canvasElement)).not.toBeVisible()
  },
}

/** A newer build is building: a pulsing amber dot, when it started and its log. */
export const NewerBuilding: StoryObj = {
  render: indicator(building),
  play: async ({ canvasElement }) => {
    await settle(canvasElement, "newer-building")
    const line = within(box(canvasElement))
    await expect(box(canvasElement)).toHaveAttribute("data-tone", "building")
    await expect(box(canvasElement)).toHaveAttribute("aria-live", "polite")
    await expect(line.getByText("A newer build (b81e07c) is building")).toBeVisible()
    await expect(line.getByText("Started 2 min ago.")).toBeVisible()
    await expect(line.getByRole("link", { name: "Build log" })).toHaveAttribute("href", RUN)
    await expect(line.queryByRole("button", { name: /Update/ })).toBeNull()
  },
}

/** It publishes: the same tab turns to newer-live without a refresh. One app changed, so only it updates. */
export const NewerLiveOneApp: StoryObj = {
  render: indicator(building),
  play: async ({ canvasElement }) => {
    await settle(canvasElement, "newer-building")
    control?.set({ current: oneApp })
    await settle(canvasElement, "newer-live")
    const line = within(box(canvasElement))
    await expect(box(canvasElement)).toHaveAttribute("data-tone", "ready")
    await expect(line.getByText("A newer build (b81e07c) is live")).toBeVisible()
    await expect(line.getByText("Changed: shop.")).toBeVisible()
    await expect(line.getByRole("link", { name: "What changed" })).toHaveAttribute(
      "href",
      `https://github.com/acme/shop/compare/${A}...${B}`,
    )
    const update = line.getByRole("button", { name: "Update shop" })
    await userEvent.click(update)
    await expect(update).toHaveTextContent("Updating…")
    await expect(updates).toEqual([{ kind: "app", app: "shop" }])
    await waitFor(() => expect(update).toHaveTextContent("Update shop"))
  },
}

/** Several apps changed: Update now reloads the shell. */
export const NewerLiveReload: StoryObj = {
  render: indicator({ current: many }),
  play: async ({ canvasElement }) => {
    await settle(canvasElement, "newer-live")
    const line = within(box(canvasElement))
    await expect(line.getByText("Changed: admin, shop.")).toBeVisible()
    await userEvent.click(line.getByRole("button", { name: "Update now" }))
    await expect(updates).toEqual([{ kind: "reload" }])
  },
}

/** Keep this version: the line goes away until a different build. */
export const KeepThisVersion: StoryObj = {
  render: indicator({ current: many }),
  play: async ({ canvasElement }) => {
    await settle(canvasElement, "newer-live")
    const keep = within(box(canvasElement)).getByRole("button", { name: "Keep this version" })
    keep.focus()
    await userEvent.keyboard("{Enter}")
    await expect(box(canvasElement)).not.toBeVisible()
    control?.set({ current: { ...many, commit: "c0ffee1234567890abcdef1234567890abcdef12" } })
    await waitFor(() => expect(box(canvasElement)).toBeVisible())
    await expect(
      within(box(canvasElement)).getByText("A newer build (c0ffee1) is live"),
    ).toBeVisible()
  },
}

/** The newer build failed: a red dot and the log; this version keeps working. */
export const NewerFailed: StoryObj = {
  render: indicator(failed),
  play: async ({ canvasElement }) => {
    await settle(canvasElement, "newer-failed")
    const line = within(box(canvasElement))
    await expect(box(canvasElement)).toHaveAttribute("data-tone", "failed")
    await expect(line.getByText("The newer build (b81e07c) failed")).toBeVisible()
    await expect(line.getByText("This version keeps working.")).toBeVisible()
    await expect(line.getByRole("link", { name: "Build log" })).toHaveAttribute("href", RUN)
  },
}

/** The status document cannot be read: a grey dot, and retries back off. */
export const Unknown: StoryObj = {
  render: indicator(new Error("HTTP 503")),
  play: async ({ canvasElement }) => {
    await settle(canvasElement, "unknown")
    await expect(box(canvasElement)).toHaveAttribute("data-tone", "offline")
    await expect(
      within(box(canvasElement)).getByText("Can't check for a newer build"),
    ).toBeVisible()
    control?.set({ current: running })
    await settle(canvasElement, "current")
  },
}

/** On a phone the line wraps and never scrolls sideways. */
export const Phone: StoryObj = {
  render: indicator({ current: many }),
  globals: { viewport: { value: "phone" } },
  play: async ({ canvasElement }) => {
    await settle(canvasElement, "newer-live")
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    )
  },
}

/** In the shell: the switcher's dot and the System screen's Preview card, from `freshnessBuild()`. */
export const InTheShell: StoryObj = {
  parameters: { layout: "fullscreen" },
  render: () => {
    stop?.()
    updates.length = 0
    for (const key of [ROTATION_KEY, ORDER_KEY, "mockingbird.system-switcher.dock"])
      localStorage.removeItem(key)
    control = scripted(building)
    const feed: FreshnessFeed = control.watch
    const build = freshnessBuild({
      freshness: feed,
      onUpdate: (plan) => void updates.push(plan),
      pr: { number: 836, url: "https://github.com/acme/shop/pull/836" },
    })
    const host = document.createElement("div")
    host.style.height = "100vh"
    const harness = mountSystemHarness(
      host,
      [
        {
          id: "shop",
          label: "Shop",
          description: "The storefront.",
          icon: SYSTEM_ICONS.emulators,
          mount(panel: HTMLElement) {
            const indicatorHost = document.createElement("div")
            panel.append(indicatorHost)
            const mounted = mountFreshnessIndicator(indicatorHost, {
              freshness: feed,
              onUpdate: (plan) => void updates.push(plan),
            })
            return () => {
              mounted.destroy()
              panel.replaceChildren()
            }
          },
        },
      ],
      { build },
    )
    stop = () => {
      harness.destroy()
      build.destroy()
      control?.watch.stop()
    }
    return host
  },
  play: async ({ canvasElement }) => {
    const dot = () => within(canvasElement).getByTestId("system-build-dot")
    await waitFor(() => expect(dot()).toHaveAttribute("data-tone", "building"))
    await expect(dot()).toHaveAccessibleName("Preview status: Building b81e07c")
    control?.set({ current: oneApp })
    await waitFor(() => expect(dot()).toHaveAttribute("data-tone", "ready"))
    const toast = within(canvasElement).getByTestId("system-update-toast")
    await expect(toast).toBeVisible()
    await userEvent.click(within(toast).getByRole("button", { name: "Update now" }))
    await expect(updates).toEqual([{ kind: "app", app: "shop" }])
  },
}
