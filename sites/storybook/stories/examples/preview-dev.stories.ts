import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, within } from "storybook/test"
import {
  DEV_ERROR_ID,
  devWaitingPage,
  showDevBuildError,
} from "../../../../packages/adapters/preview/src/dev-boot.js"
import { frame, frameDocument } from "../../src/frame.js"

/**
 * What the preview dev server (`devPreview`, `mockingbird-preview dev`) draws of its own: the
 * build error card over a running app, and the page it answers with before any build has
 * succeeded. Everything else on screen is the app.
 */
export default {
  title: "Examples/Preview dev server",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/adapters/preview/src/dev-boot.ts",
      "packages/adapters/preview/src/dev-preview.ts",
    ],
  },
} satisfies Meta

const ERROR = `✘ [ERROR] Unexpected "}"

    src/client/pages/Landing.tsx:239:79:
      239 │         title={sentTo ? "Enter your sign-in code" : "Sign in to your account" +}
          ╵                                                                                ^`

const card = () => {
  const host = document.getElementById(DEV_ERROR_ID)
  if (!host?.shadowRoot) throw new Error("No build error card")
  return host
}

/** An app that keeps running its last good version while the card says why the build fails. */
const app = () => {
  showDevBuildError(document, undefined)
  const page = document.createElement("main")
  page.style.cssText = "min-height:100vh;padding:32px;font:16px Georgia,serif"
  page.innerHTML = "<h1>Orders</h1><p>The last version that built is still running here.</p>"
  return page
}

/** A build failed: the compiler's message in the corner, over the app's last good version. */
export const BuildError: StoryObj = {
  render: app,
  beforeEach: () => () => showDevBuildError(document, undefined),
  play: async () => {
    showDevBuildError(document, ERROR)
    const host = card()
    await expect(host).toHaveAttribute("role", "alert")
    await expect(host.shadowRoot?.querySelector("pre")?.textContent).toBe(ERROR)
    await expect(host.shadowRoot?.querySelector("header")?.textContent).toContain("Build failed")
    // A second failure replaces the message; there is only ever one card.
    showDevBuildError(document, '✘ [ERROR] Could not resolve "./missing"')
    await expect(document.querySelectorAll(`#${DEV_ERROR_ID}`)).toHaveLength(1)
    await expect(card().shadowRoot?.querySelector("pre")?.textContent).toContain("./missing")
    showDevBuildError(document, ERROR)
  },
}

/** The next good build takes the card away; so does its ✕. */
export const BuildErrorCleared: StoryObj = {
  render: app,
  beforeEach: () => () => showDevBuildError(document, undefined),
  play: async () => {
    showDevBuildError(document, ERROR)
    showDevBuildError(document, undefined)
    await expect(document.getElementById(DEV_ERROR_ID)).toBeNull()
    showDevBuildError(document, ERROR)
    const close = card().shadowRoot?.querySelector("button") as HTMLButtonElement
    await expect(close).toHaveAccessibleName("Dismiss")
    await userEvent.click(close)
    await expect(document.getElementById(DEV_ERROR_ID)).toBeNull()
  },
}

/** On a phone the card keeps inside the screen and the message wraps. */
export const BuildErrorPhone: StoryObj = {
  render: app,
  globals: { viewport: { value: "phone" } },
  beforeEach: () => () => showDevBuildError(document, undefined),
  play: async () => {
    showDevBuildError(document, ERROR)
    const box = card().getBoundingClientRect()
    await expect(box.left).toBeGreaterThanOrEqual(0)
    await expect(box.right).toBeLessThanOrEqual(window.innerWidth)
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    )
  },
}

/**
 * The waiting page with no dev server behind it: its status stream never says anything, so the
 * page stays as it is instead of reloading into the app.
 */
const waiting = (message: string | undefined) =>
  devWaitingPage(message).replace(
    "<script>",
    "<script>window.EventSource=class{addEventListener(){}}</script><script>",
  )

/** No build has succeeded yet: the page is the compiler's message, and loads the app once one does. */
export const DoesNotBuildYet: StoryObj = {
  render: () => frame(waiting(ERROR), { url: "http://localhost:4173/" }),
  play: async ({ canvasElement }) => {
    const page = within((await frameDocument(canvasElement)).body)
    await expect(
      page.getByRole("heading", { name: "The preview does not build yet" }),
    ).toBeVisible()
    await expect(page.getByText(/Landing\.tsx:239:79/)).toBeVisible()
  },
}

/** The very first build is still running. */
export const FirstBuild: StoryObj = {
  render: () => frame(waiting(undefined), { url: "http://localhost:4173/" }),
  play: async ({ canvasElement }) => {
    const page = within((await frameDocument(canvasElement)).body)
    await expect(page.getByRole("heading", { name: "Building the preview…" })).toBeVisible()
  },
}
