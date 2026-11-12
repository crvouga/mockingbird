/**
 * The inspectors some emulators serve beside their API (AWS at `/_inspector`; Linear, Slack and
 * Twilio at `/`; Resend's inbox at `/inbox`): server-rendered pages drawn with the shared provider
 * UI (`packages/http/provider/src/vendor/core/ui.ts`). Each story starts the emulator, calls the
 * vendor's API the way an app would, and opens the page; its tab links go back to the emulator.
 */
import type { StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { frameDocument } from "../../../src/frame.js"
import { hands } from "../../../src/interact.js"
import { type Emulator, page } from "../../../src/story.js"

/** The shared files every inspector page is drawn and served with. */
export const SHARED_SOURCES = [
  "packages/http/provider/src/vendor/core/ui.ts",
  "packages/http/provider/src/vendor/core/http.ts",
]

export const phone = { viewport: { value: "phone", isRotated: false } }

/** Send a request to the emulator as an app would; resolves with the body, fails on an error status. */
export async function call(
  emulator: Emulator,
  url: string,
  init: RequestInit = {},
): Promise<string> {
  const response = await emulator.fetch(new Request(url, init))
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${response.status} ${text}`)
  return text
}

/** An inspector page at `url` on the emulator `start` returns, checked to show `text`. */
export function inspector<T extends Emulator>(
  start: () => T | Promise<T>,
  url: string,
  text: string,
  extra: Omit<StoryObj, "loaders" | "render" | "play"> = {},
): StoryObj {
  return {
    ...page(async () => ({ emulator: await start(), url }), extra),
    play: async ({ canvasElement }) => {
      const doc = await frameDocument(canvasElement)
      await expect(doc.body.textContent).toContain(text)
    },
  }
}

/** Follow the tab link labelled `label` and check the page it opens shows `text`. */
export async function openTab(canvas: HTMLElement, label: string, text: string): Promise<void> {
  const tab = await hands(canvas)
  const link = [...tab.doc.querySelectorAll<HTMLAnchorElement>(".inspector-tabs a")].find(
    (a) => a.textContent === label,
  )
  if (!link) throw new Error(`No ${label} tab`)
  link.click()
  const next = await tab.navigated()
  await expect(next.doc.body.textContent).toContain(text)
}
