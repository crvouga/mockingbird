import type { Meta, StoryObj } from "@storybook/html-vite"
import { cove, person, SHELL } from "./cove.js"

/** What the app shows before it knows who is signed in: still asking, or unable to ask. */
export default {
  title: "Examples/Medical testing/App states",
  parameters: { layout: "fullscreen", sources: SHELL },
} satisfies Meta

/** The server has not answered yet. */
export const Loading: StoryObj = cove({ transport: () => () => new Promise<Response>(() => {}) })

/** The server cannot be reached: the error, and a way to try again. */
export const Unreachable: StoryObj = {
  ...cove({ transport: () => () => Promise.reject(new TypeError("Failed to fetch")) }),
  play: async ({ canvasElement }) => {
    await person(canvasElement).find('.cove-alert-error[role="alert"]', "Failed to fetch")
  },
}
