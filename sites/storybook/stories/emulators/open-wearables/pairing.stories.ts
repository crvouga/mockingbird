import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import {
  completionPage,
  consentPage,
  pairingPage,
} from "../../../../../packages/service/open-wearables/src/ui/server.js"
import { frameDocument } from "../../../src/frame.js"
import { markup } from "../../../src/story.js"

/**
 * The Open Wearables emulator's browser pages: pick a provider, consent, done. Each is the shared
 * `CenteredCard`, server-rendered with no JavaScript, as the emulator serves it.
 */
export default {
  title: "Emulators/Open Wearables/Pairing",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/service/open-wearables/src/ui/server.tsx",
      "packages/service/open-wearables/src/ui.ts",
      "packages/service/open-wearables/src/index.ts",
    ],
  },
} satisfies Meta
const providers = ["Garmin", "Oura"].map((name) => ({
  name,
  provider: name.toLowerCase(),
  icon_url: null,
  is_enabled: true,
  has_cloud_api: true,
}))
const dark = (html: string) =>
  html.replace(/<html lang="en">/, '<html lang="en" data-theme="dark" class="dark">')

export const Providers: StoryObj = markup(() => pairingPage(providers, "fixture-user"), {
  play: async ({ canvasElement }) => {
    const doc = await frameDocument(canvasElement)
    await expect(doc.querySelector("h1")?.textContent).toBe("Connect a wearable")
    await expect(doc.querySelector('a[href="/users/fixture-user/pair/garmin"]')?.textContent).toBe(
      "Garmin",
    )
  },
})
export const OnAPhone: StoryObj = {
  ...Providers,
  globals: { viewport: { value: "phone", isRotated: false } },
}
export const Dark: StoryObj = markup(() => dark(pairingPage(providers, "fixture-user")))
export const NoProviders: StoryObj = markup(() => pairingPage([], "fixture-user"))
export const Consent: StoryObj = markup(() => consentPage("Garmin", "/mockingbird/oauth/fixture"), {
  play: async ({ canvasElement }) => {
    const doc = await frameDocument(canvasElement)
    const buttons = [...doc.querySelectorAll('form[method="post"] button[name="decision"]')]
    await expect(buttons.map((button) => (button as HTMLButtonElement).value)).toEqual([
      "allow",
      "deny",
    ])
  },
})
export const ConsentDark: StoryObj = markup(() =>
  dark(consentPage("Garmin", "/mockingbird/oauth/fixture")),
)
export const Connected: StoryObj = markup(() => completionPage(true))
export const Cancelled: StoryObj = markup(() => completionPage(false))
