import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import {
  type ExampleOptions,
  mount,
} from "../../../../../packages/service/oauth/examples/google-login/index.js"

/**
 * The OAuth emulator's runnable example: a small app (Hono, `oauth4webapi`) signing in against the
 * emulator, both in this tab with no network. Its toolbar picks the provider profile, the
 * provider's behaviour, the flow and the appearance; each page either side serves is pasted into
 * the example as it arrives. The popup flow opens a real window, so the stories drive the
 * redirect flow.
 */
export default {
  title: "Emulators/OAuth/Google login example",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/service/oauth/examples/google-login/index.ts",
      "packages/service/oauth/examples/google-login/app.ts",
      "packages/service/oauth/examples/google-login/paste.ts",
      "packages/service/oauth/examples/google-login/transport.ts",
    ],
  },
} satisfies Meta

const example = (options: ExampleOptions = {}): StoryObj => ({
  render: () => {
    const host = document.createElement("div")
    host.style.cssText = "display:block;padding:16px"
    host.dataset.example = "google-login"
    void mount(host, { flow: "redirect", ...options })
    return host
  },
})

/** The example's own shadow tree, and the app frame inside it. */
const surfaces = (canvas: HTMLElement) => {
  const root = canvas.querySelector<HTMLElement>("[data-example]")?.shadowRoot
  if (!root) throw new Error("The example did not mount")
  const frame = root.querySelector<HTMLElement>(".app-frame")?.shadowRoot
  return { root, frame }
}

/** Wait until the app frame shows `text`, then return its page. */
const showing = async (canvas: HTMLElement, text: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { frame } = surfaces(canvas)
    if (frame?.textContent?.includes(text)) return frame
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  expect(surfaces(canvas).frame?.textContent).toContain(text)
  throw new Error(`The example never showed "${text}"`)
}

const press = async (canvas: HTMLElement, selector: string, waitFor: string) => {
  const frame = await showing(canvas, waitFor)
  const target = frame.querySelector<HTMLElement>(selector)
  if (!target) throw new Error(`Nothing matches ${selector}`)
  target.click()
}

/** App → provider's chooser → consent, stopping on the consent card. */
const toConsent = async (canvas: HTMLElement) => {
  await press(canvas, 'a[href="/auth/start"]', "Sign in to continue")
  await press(canvas, '[data-testid="oauth-mock-account-ada"]', "Choose an account")
  await showing(canvas, "Review access")
}

/** The app, signed out. */
export const SignedOut: StoryObj = example()

export const DarkAppearance: StoryObj = example({ theme: "dark" })

export const PopupFlow: StoryObj = example({ flow: "popup" })

export const OnAPhone: StoryObj = {
  ...example(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Sign in redirects to the provider's account chooser, inside the example. */
export const ProviderChooser: StoryObj = {
  ...example(),
  play: async ({ canvasElement }) => {
    await press(canvasElement, 'a[href="/auth/start"]', "Sign in to continue")
    await showing(canvasElement, "Choose an account")
  },
}

export const ProviderConsent: StoryObj = {
  ...example(),
  play: async ({ canvasElement }) => toConsent(canvasElement),
}

/** Allowed: back in the app, signed in, with the claims it verified. */
export const SignedIn: StoryObj = {
  ...example(),
  play: async ({ canvasElement }) => {
    await toConsent(canvasElement)
    await press(canvasElement, '[data-testid="oauth-mock-allow"]', "Review access")
    await showing(canvasElement, "Welcome, Ada.")
  },
}

/** Cancelled on the consent card: back in the app, still signed out. */
export const Declined: StoryObj = {
  ...example(),
  play: async ({ canvasElement }) => {
    await toConsent(canvasElement)
    await press(canvasElement, '[data-testid="oauth-mock-deny"]', "Review access")
    await showing(canvasElement, "Sign in to continue")
    const { root } = surfaces(canvasElement)
    expect(root.querySelector(".status")?.textContent).toContain("did not complete")
  },
}

/** The Apple profile: its consent card asks whether to share the email. */
export const AppleProfile: StoryObj = {
  ...example(),
  play: async ({ canvasElement }) => {
    const profile = surfaces(canvasElement).root.querySelector<HTMLSelectElement>(".profile")
    if (!profile) throw new Error("No provider profile select")
    profile.value = "apple"
    profile.dispatchEvent(new Event("change"))
    // The example resets and reloads the app; let that land before pressing Sign in.
    await new Promise((resolve) => setTimeout(resolve, 300))
    await toConsent(canvasElement)
    await showing(canvasElement, "Choose what to share")
  },
}
