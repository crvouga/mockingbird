import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { mountSystemHarness } from "../../../../../packages/ui/src/system-harness.js"

export default {
  title: "Examples/System harness",
  parameters: {
    layout: "fullscreen",
    sources: ["packages/ui/src/system-harness.ts", "packages/ui/src/system-screen.ts"],
  },
} satisfies Meta

const DOCK_KEY = "mockingbird.system-switcher.dock"
let stop: (() => void) | undefined
const render = () => {
  stop?.()
  localStorage.removeItem(DOCK_KEY)
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
        await userEvent.click(page.getByRole("button", { name: "Next app" }))
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
/** The pill rests mid-left, names each arrow's destination, and remembers where it was dragged. */
export const Switcher: StoryObj = {
  render,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const pill = await page.findByRole("group", { name: "Switch apps" })
    const shell = canvasElement.querySelector<HTMLElement>(".msh")
    if (!shell) throw new Error("No shell")
    await waitFor(() => {
      const box = shell.getBoundingClientRect()
      const rect = pill.getBoundingClientRect()
      expect(rect.left - box.left).toBe(8)
      expect(Math.abs(rect.top + rect.height / 2 - (box.top + box.height / 2))).toBeLessThan(2)
    })

    await userEvent.hover(page.getByRole("button", { name: "Next app" }))
    await expect(await page.findByRole("tooltip")).toHaveTextContent("Next: Editor")
    await userEvent.unhover(page.getByRole("button", { name: "Next app" }))
    await userEvent.hover(page.getByRole("button", { name: "Previous app" }))
    await expect(page.getByRole("tooltip")).toHaveTextContent("Previous: Loading")
    await userEvent.click(page.getByRole("button", { name: "Previous app" }))
    await expect(page.getByRole("tooltip")).toHaveTextContent("Previous: Failure")
    await userEvent.unhover(page.getByRole("button", { name: "Previous app" }))
    await waitFor(() => expect(page.queryByRole("tooltip")).toBeNull())

    // A saved dock on the right edge, a quarter of the way down, is where the next mount starts.
    localStorage.setItem(DOCK_KEY, JSON.stringify({ edge: "right", at: 0.25 }))
    const host = document.createElement("div")
    host.style.cssText = "position:fixed;inset:0;height:400px"
    canvasElement.append(host)
    const again = mountSystemHarness(host, [{ id: "one", label: "One", mount: () => () => {} }])
    try {
      const restored = await within(host).findByRole("group", { name: "Switch apps" })
      await waitFor(() => {
        const rect = restored.getBoundingClientRect()
        const box = host.getBoundingClientRect()
        expect(Math.round(box.right - rect.right)).toBe(8)
        expect(Math.round(rect.top - box.top)).toBe(Math.round(8 + (400 - 16 - rect.height) / 4))
      })
    } finally {
      again.destroy()
      host.remove()
      localStorage.removeItem(DOCK_KEY)
    }
  },
}
export const Phone: StoryObj = { ...Switching, globals: { viewport: { value: "phone" } } }
