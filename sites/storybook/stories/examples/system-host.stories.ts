import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, waitFor, within } from "storybook/test"
import {
  mountSystemHarness,
  type SystemSurface,
} from "../../../../packages/ui/src/system-harness.js"
import {
  INCLUDED_KEY,
  ORDER_KEY,
  ROTATION_KEY,
  SWITCHER_BAR_HEIGHT,
} from "../../../../packages/ui/src/system-rotation.js"

/**
 * The harness inside somebody else's app: a page with its own colors, type and fixed chrome, and
 * none of Mockingbird's. The switcher bar takes on the page's background, the harness's own UI
 * picks light or dark from it, and the app's `position: fixed` parts stay inside its own area
 * under the bar.
 */
export default {
  title: "Examples/System harness/Any host page",
  parameters: {
    layout: "fullscreen",
    sources: ["packages/ui/src/system-harness.ts", "packages/ui/src/system-view.tsx"],
  },
} satisfies Meta

const HEADER = 48
const NAV = 44

/** An app with a fixed header, a fixed bottom navigation and more rows than fit. */
const app = (id: string, label: string): SystemSurface => ({
  id,
  label,
  mount(panel) {
    panel.innerHTML = `<header data-testid="${id}-header" style="position:fixed;top:0;left:0;right:0;height:${HEADER}px;display:flex;align-items:center;padding:0 16px;background:#7c3aed;color:#fff;font-weight:700">${label}</header>
<main style="padding:${HEADER + 16}px 16px ${NAV + 16}px">${Array.from({ length: 40 }, (_, row) => `<p data-row="${row + 1}">${label} row ${row + 1}</p>`).join("")}</main>
<nav data-testid="${id}-nav" style="position:fixed;bottom:0;left:0;right:0;height:${NAV}px;display:flex;align-items:center;justify-content:center;background:#4c1d95;color:#fff">Home · Orders · Account</nav>`
    return () => panel.replaceChildren()
  },
})

let stop: (() => void) | undefined
/** The harness in a page (`host`) painted and typeset by `style`, as an app's own <body> is. */
const page = (style: string) => () => {
  stop?.()
  for (const key of [ROTATION_KEY, ORDER_KEY, INCLUDED_KEY]) localStorage.removeItem(key)
  const host = document.createElement("div")
  host.dataset.testid = "host-page"
  host.style.cssText = `height:100vh;font-family:Georgia,serif;${style}`
  const harness = mountSystemHarness(host, [app("shop", "Shop"), app("admin", "Admin")], {
    initial: "shop",
  })
  stop = () => harness.destroy()
  return host
}

const bar = (canvas: HTMLElement) => within(canvas).findByTestId("system-switcher")
/** The theme the harness's own UI drew itself in. */
const themeOf = (node: HTMLElement) =>
  node.closest<HTMLElement>("[data-mockingbird]")?.dataset.theme ?? "system"
const TRANSPARENT = "rgba(0, 0, 0, 0)"

/** A dark page: the bar is transparent over it and the harness's UI is dark, whatever the system says. */
export const DarkPage: StoryObj = {
  render: page("background:#1b1035;color:#f3e8ff"),
  play: async ({ canvasElement }) => {
    const switcher = await bar(canvasElement)
    await expect(switcher).toHaveAttribute("data-blend")
    await expect(getComputedStyle(switcher).backgroundColor).toBe(TRANSPARENT)
    await expect(themeOf(switcher)).toBe("dark")
    // The app keeps the page's own colors and type: the harness sets none on it.
    const row = canvasElement.querySelector<HTMLElement>('[data-row="1"]') as HTMLElement
    await expect(getComputedStyle(row).color).toBe("rgb(243, 232, 255)")
    await expect(getComputedStyle(row).fontFamily).toContain("Georgia")
  },
}

/** A light page with its own tint: the same bar, drawn light. */
export const LightPage: StoryObj = {
  render: page("background:#fff7ed;color:#431407"),
  play: async ({ canvasElement }) => {
    const switcher = await bar(canvasElement)
    await expect(switcher).toHaveAttribute("data-blend")
    await expect(themeOf(switcher)).toBe("light")
  },
}

/** The page changes its own theme while open (a class, an attribute or a style): the bar follows. */
export const PageChangesTheme: StoryObj = {
  render: page("background:#fff7ed;color:#431407"),
  play: async ({ canvasElement }) => {
    const switcher = await bar(canvasElement)
    await expect(themeOf(switcher)).toBe("light")
    const host = within(canvasElement).getByTestId("host-page")
    host.style.background = "#0b1220"
    host.style.color = "#e2e8f0"
    await waitFor(() => expect(themeOf(switcher)).toBe("dark"))
  },
}

/** A theme pinned on <html> (Mockingbird's own switch) wins: the bar paints that theme's background. */
export const PinnedThemeWins: StoryObj = {
  render: page("background:#fff7ed;color:#431407"),
  beforeEach: () => {
    const root = document.documentElement
    root.dataset.theme = "dark"
    root.classList.add("dark")
    return () => {
      root.removeAttribute("data-theme")
      root.classList.remove("dark")
    }
  },
  play: async ({ canvasElement }) => {
    const switcher = await bar(canvasElement)
    await expect(switcher).not.toHaveAttribute("data-blend")
    await expect(themeOf(switcher)).toBe("dark")
    await expect(getComputedStyle(switcher).backgroundColor).not.toBe(TRANSPARENT)
  },
}

/**
 * The app's fixed header starts under the bar instead of behind it, its fixed navigation ends at
 * the bottom of its area, and neither moves when the app scrolls.
 */
export const FixedChrome: StoryObj = {
  render: page("background:#1b1035;color:#f3e8ff"),
  play: async ({ canvasElement }) => {
    await bar(canvasElement)
    const canvas = within(canvasElement)
    const shell = canvas.getByTestId("system-harness").getBoundingClientRect()
    const header = await canvas.findByTestId("shop-header")
    const nav = canvas.getByTestId("shop-nav")
    const placed = async () => {
      await expect(header.getBoundingClientRect().top).toBe(shell.top + SWITCHER_BAR_HEIGHT)
      await expect(nav.getBoundingClientRect().bottom).toBe(shell.bottom)
    }
    await placed()
    const panel = canvasElement.querySelector<HTMLElement>('section[data-surface="shop"]')
    if (!panel) throw new Error("No Shop panel")
    panel.scrollTop = 400
    await waitFor(() => expect(panel.scrollTop).toBe(400))
    await placed()
    // The bar's buttons are never under the app's header.
    const next = canvas.getByTestId("system-switcher-next").getBoundingClientRect()
    await expect(next.bottom).toBeLessThanOrEqual(header.getBoundingClientRect().top)
  },
}

/** On a phone: the same, with nothing scrolling sideways. */
export const Phone: StoryObj = {
  render: page("background:#1b1035;color:#f3e8ff"),
  globals: { viewport: { value: "phone" } },
  play: async ({ canvasElement }) => {
    const switcher = await bar(canvasElement)
    await expect(themeOf(switcher)).toBe("dark")
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    )
  },
}
