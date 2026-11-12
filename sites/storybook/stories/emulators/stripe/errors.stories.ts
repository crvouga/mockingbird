import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"
import { ORIGIN, stripe } from "./stripe.js"

/** Pages Stripe's edge answers before the API sees the request. */
export default {
  title: "Emulators/Stripe/Edge errors",
  parameters: { layout: "fullscreen", sources: ["packages/service/stripe/src/index.ts"] },
} satisfies Meta

/** A request line over 16 KiB: nginx's 414, as Stripe's edge sends it. */
export const RequestUriTooLarge: StoryObj = page(() => ({
  emulator: stripe().emulator,
  url: `${ORIGIN}/v1/customers?email=${"a".repeat(17_000)}`,
}))
