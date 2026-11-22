import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { mountSystemHarness } from "../../../../../packages/ui/src/system-harness.js"

export default {
  title: "Examples/System harness",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-harness.ts",
      "packages/ui/src/system-view.tsx",
      "packages/ui/src/system-screen.tsx",
    ],
  },
} satisfies Meta

let stop: (() => void) | undefined
const render = () => {
  stop?.()
  localStorage.removeItem("mockingbird.system-switcher.rotation")
  const host = document.createElement("div")
  host.style.height = "100vh"
  let attempts = 0
  const harness = mountSystemHarness(host, [
    {
      id: "editor",
      label: "Editor",
      mount(panel) {
        const input = document.createElement("input")
        input.setAttribute("aria-label", "Draft")
        panel.append(input)
        return () => input.remove()
      },
    },
    {
      id: "failure",
      label: "Failure",
      mount(panel) {
        if (++attempts === 1) throw new Error("Example unavailable")
        panel.textContent = "Recovered"
        return () => panel.replaceChildren()
      },
    },
    {
      id: "loading",
      label: "Loading",
      mount: (_panel, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(() => {}), { once: true })
        }),
    },
  ])
  stop = () => harness.destroy()
  return host
}
export const Switching: StoryObj = {
  render,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const open = async (name: string) => {
      for (let step = 0; step < 4; step++) {
        const current = canvasElement.querySelector("section[data-surface]:not([hidden])")
        if (current?.getAttribute("aria-label") === name) return
        // The harness's UI loads lazily, a moment after it mounts.
        await userEvent.click(await page.findByRole("button", { name: "Next app" }))
      }
      throw new Error(`Could not cycle to ${name}`)
    }
    await expect(canvasElement.querySelector("nav")).toBeNull()
    await open("Editor")
    await userEvent.type(await page.findByRole("textbox", { name: "Draft" }), "Keep this draft")
    await open("System")
    await open("Editor")
    await expect(page.getByRole("textbox")).toHaveValue("Keep this draft")
    await expect(
      canvasElement.querySelectorAll("section[data-surface]:not([hidden])"),
    ).toHaveLength(1)
    await open("Failure")
    await userEvent.click(await page.findByRole("button", { name: "Retry" }))
    await waitFor(() => expect(page.getByText("Recovered")).toBeVisible())

    // An async surface can finish after its host has gone away.
    const temporary = document.createElement("div")
    let finish: ((dispose: () => void) => void) | undefined
    let disposed = 0
    const pending = mountSystemHarness(
      temporary,
      [
        {
          id: "late",
          label: "Late",
          mount: () =>
            new Promise((resolve) => {
              finish = resolve
            }),
        },
      ],
      { initial: "late" },
    )
    const ready = pending.show("late")
    await Promise.resolve()
    pending.destroy()
    finish?.(() => {
      disposed++
    })
    await ready
    await expect(disposed).toBe(1)
    pending.destroy()
    await expect(disposed).toBe(1)
    await expect(temporary.childElementCount).toBe(0)
  },
}
export const Loading: StoryObj = {
  render,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Open Loading" }),
    )
    await expect(await within(canvasElement).findByText("Loading…")).toBeVisible()
  },
}
/** The bar spans the top of the shell, above every surface, and names each arrow's destination. */
export const Switcher: StoryObj = {
  render,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const bar = await page.findByRole("group", { name: "Switch apps" })
    const shell = canvasElement.querySelector<HTMLElement>(".msh")
    if (!shell) throw new Error("No shell")
    await waitFor(() => {
      const box = shell.getBoundingClientRect()
      const rect = bar.getBoundingClientRect()
      expect(rect.top).toBe(box.top)
      expect(rect.left).toBe(box.left)
      expect(rect.width).toBe(box.width)
      expect(rect.height).toBe(28)
      // In the layout, not over it: the shown surface starts where the bar ends.
      const panel = shell.querySelector<HTMLElement>("section[data-surface]:not([hidden])")
      expect(panel?.getBoundingClientRect().top).toBe(rect.bottom)
    })
    await expect(page.getByTestId("system-switcher-current")).toHaveTextContent("System")

    await userEvent.hover(page.getByRole("button", { name: "Next app" }))
    await expect(await page.findByRole("tooltip")).toHaveTextContent("Next: Editor")
    await userEvent.unhover(page.getByRole("button", { name: "Next app" }))
    await userEvent.hover(page.getByRole("button", { name: "Previous app" }))
    await expect(page.getByRole("tooltip")).toHaveTextContent("Previous: Loading")
    await userEvent.click(page.getByRole("button", { name: "Previous app" }))
    await expect(page.getByRole("tooltip")).toHaveTextContent("Previous: Failure")
    await expect(page.getByTestId("system-switcher-current")).toHaveTextContent("Loading")
    await userEvent.unhover(page.getByRole("button", { name: "Previous app" }))
    await waitFor(() => expect(page.queryByRole("tooltip")).toBeNull())

    // The bar's System button goes back from any surface.
    await userEvent.click(page.getByTestId("system-switcher-system"))
    await expect(page.getByTestId("system-switcher-current")).toHaveTextContent("System")
  },
}
export const Phone: StoryObj = { ...Switching, globals: { viewport: { value: "phone" } } }
