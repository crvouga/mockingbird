import type { Meta, StoryObj } from "@storybook/html-vite"
import { mount } from "../../../../../packages/examples/medical-testing/src/browser.js"
import { type Person, person, phone } from "./cove.js"

/**
 * The whole example as the docs site embeds it (`mount` from `src/browser.ts`): a fresh
 * in-process instance with three tabs: the app (Example), the admin UI of every emulator it
 * talks to (Emulators), and every email, text, push and staff message it sent (Notifications).
 */
export default {
  title: "Examples/Medical testing/Workspace",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/examples/medical-testing/src/browser.ts",
      "packages/examples/medical-testing/src/composition/browser.ts",
      "packages/examples/medical-testing/src/composition/emulatorsPanel.ts",
      "packages/examples/medical-testing/src/composition/build.ts",
      "packages/examples/medical-testing/src/client/inbox.ts",
    ],
  },
} satisfies Meta

let unmount: (() => void) | undefined

/**
 * The Emulators tab reads vendor names and logos from the docs site's `/brands.json`, an absolute
 * URL that only the docs site itself may fetch (`src/adapters/admin.ts`). Here it is answered with
 * an empty catalog, so the admin falls back to each emulator's own name.
 */
const BRANDS = "https://mockingbird.chrisvouga.dev/brands.json"
const network = window.fetch.bind(window)
window.fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) =>
    (typeof input === "string" ? input : input instanceof URL ? input.href : input.url) === BRANDS
      ? Promise.resolve(Response.json({}))
      : network(input, init),
  { preconnect: window.fetch.preconnect },
)

const workspace = (
  play?: (page: Person) => Promise<void>,
  extra: Omit<StoryObj, "render" | "play"> = {},
): StoryObj => ({
  ...extra,
  render: () => {
    unmount?.()
    const host = document.createElement("div")
    host.style.cssText = "height:100vh"
    void mount(host).then((stop) => {
      unmount = stop
    })
    return host
  },
  play: async ({ canvasElement }) => {
    const page = person(canvasElement)
    await page.find('[data-testid="sign-in-email"]')
    await play?.(page)
  },
})

const tab = (page: Person, name: "app" | "emulators" | "notifications") =>
  page.click(`[data-testid="dashboard-tab"][data-tab="${name}"]`)

/** The Example tab: the app, signed out. */
export const Example: StoryObj = workspace()

/** The Emulators tab: the admin UI of every emulator behind the app. */
export const Emulators: StoryObj = workspace(async (page) => {
  await tab(page, "emulators")
  await page.find("[data-mockingbird-admin] *")
})

/** A sign-in code sent, then "Open Notifications": the Notifications tab on that email. */
export const Notifications: StoryObj = workspace(async (page) => {
  await page.type('[data-testid="sign-in-email"]', "ada@example.test")
  await page.click('[data-testid="sign-in-email-submit"]')
  await page.click('[data-testid="open-inbox"]')
  await page.find('[data-testid="dashboard-panel"][data-tab="notifications"]:not([hidden])')
})

export const OnAPhone: StoryObj = workspace(undefined, { globals: phone })
