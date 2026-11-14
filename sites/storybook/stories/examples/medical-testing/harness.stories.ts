import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { mountSystemHarness } from "../../../../../packages/ui/src/system-harness.js"

export default {
  title: "Examples/System harness",
  parameters: { layout: "fullscreen", sources: ["packages/ui/src/system-harness.ts"] },
} satisfies Meta

let stop: (() => void) | undefined
const render = () => {
  stop?.()
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
      await userEvent.click(page.getByRole("button", { name: "Switch apps" }))
      await userEvent.click(within(page.getByRole("navigation")).getByRole("button", { name }))
    }
    await userEvent.click(page.getByRole("button", { name: "Switch apps" }))
    await userEvent.keyboard("{Escape}")
    await expect(page.getByRole("button", { name: "Switch apps" })).toHaveFocus()
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
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Loading" }))
    await expect(await within(canvasElement).findByText("Loading…")).toBeVisible()
  },
}
export const Phone: StoryObj = { ...Switching, globals: { viewport: { value: "phone" } } }
