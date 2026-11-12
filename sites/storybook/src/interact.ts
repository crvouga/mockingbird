/**
 * A person's hands on the page inside a story's frame, for `play` functions: find controls the
 * way tests do (by `data-testid`), type key by key so the page's own formatting runs, press.
 */
import { userEvent } from "storybook/test"
import { frameDocument } from "./frame.js"

export type Hands = {
  doc: Document
  /** The element with this `data-testid`, waiting for it to appear (pages navigate). */
  get<T extends HTMLElement = HTMLElement>(testId: string): Promise<T>
  /** Click into the field and type, one key at a time. */
  type(testId: string, text: string): Promise<void>
  click(testId: string): Promise<void>
  /** Wait until the frame shows a new document (after a form post or a link). */
  navigated(): Promise<Hands>
}

export async function hands(canvas: HTMLElement): Promise<Hands> {
  const doc = await frameDocument(canvas)
  const user = userEvent.setup({ document: doc, delay: 12 })
  const get = async <T extends HTMLElement>(testId: string): Promise<T> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const element = doc.querySelector<T>(`[data-testid="${testId}"]`)
      if (element) return element
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error(`Nothing with data-testid="${testId}"`)
  }
  return {
    doc,
    get,
    async type(testId, text) {
      const element = await get(testId)
      await user.click(element)
      await user.keyboard(text)
    },
    async click(testId) {
      await user.click(await get(testId))
    },
    async navigated() {
      const iframe = canvas.querySelector("iframe")
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          iframe?.contentDocument &&
          iframe.contentDocument !== doc &&
          iframe.contentDocument.readyState === "complete"
        )
          return hands(canvas)
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      throw new Error("The frame did not navigate")
    },
  }
}
