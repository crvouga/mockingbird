import type { Meta, StoryObj } from "@storybook/html-vite"
import {
  completionPage,
  consentPage,
  pairingPage,
} from "../../../../../packages/service/open-wearables/src/ui.js"
import { markup } from "../../../src/story.js"

export default {
  title: "Emulators/Open Wearables/Pairing",
  parameters: {
    layout: "fullscreen",
    sources: [
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
export const Providers: StoryObj = markup(() => pairingPage(providers, "fixture-user"))
export const OnAPhone: StoryObj = {
  ...Providers,
  globals: { viewport: { value: "phone", isRotated: false } },
}
export const NoProviders: StoryObj = markup(() => pairingPage([], "fixture-user"))
export const Consent: StoryObj = markup(() => consentPage("Garmin", "/mockingbird/oauth/fixture"))
export const Connected: StoryObj = markup(() => completionPage(true))
export const Cancelled: StoryObj = markup(() => completionPage(false))
