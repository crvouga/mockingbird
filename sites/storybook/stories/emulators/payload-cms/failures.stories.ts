import { createRuntime } from "@crvouga/mockingbird-service-payload-cms"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * What a browser shows for Payload's REST API while a fault preset that answers HTML is on: an empty page where JSON should be, and the load balancer's 503.
 */
export default {
  title: "Emulators/Payload CMS/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/payload-cms/src/runtime.ts"] },
} satisfies Meta

const ORIGIN = "https://cms.example"

/** Switch on fault preset `preset` through the admin API, then open `path` in a browser. */
const failing = (preset: string, path: string) =>
  page(async () => {
    const emulator = createRuntime()
    await emulator.fetch(
      new Request(`${ORIGIN}/__admin/faults/presets/${preset}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    return { emulator, url: `${ORIGIN}${path}` }
  })

/** `malformed_json`: finds answer 200 with an HTML document that has no body. */
export const NotJson: StoryObj = failing("malformed_json", "/api/pages")

/** `unavailable`: every call answers the load balancer's 503 page. */
export const ServiceUnavailable: StoryObj = failing("unavailable", "/api/pages")
