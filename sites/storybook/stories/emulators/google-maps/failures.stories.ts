import { createRuntime } from "@crvouga/mockingbird-service-google-maps"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/** What a browser shows for an address the Google Maps Platform emulator does not serve. */
export default {
  title: "Emulators/Google Maps/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/google-maps/src/index.ts"] },
} satisfies Meta

/** A path that is no Maps API: Google's bare 404 page. */
export const NotFound: StoryObj = page(() => ({
  emulator: createRuntime(),
  url: "https://maps.googleapis.com/maps/api/nowhere/json",
}))
