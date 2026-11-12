import { createRuntime } from "@crvouga/mockingbird-service-plane"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * What a browser shows for Plane's API while a fault preset that answers HTML is on: the gateway page, and an empty page where JSON should be.
 */
export default {
  title: "Emulators/Plane/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/plane/src/runtime.ts"] },
} satisfies Meta

const ORIGIN = "https://api.plane.so"

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

/** `bad_gateway`: every call answers a 502 page. */
export const BadGateway: StoryObj = failing(
  "bad_gateway",
  "/api/v1/workspaces/acme/projects/web/states/",
)

/** `invalid_json`: reads answer 200 with an HTML document that has no body. */
export const NotJson: StoryObj = failing(
  "invalid_json",
  "/api/v1/workspaces/acme/projects/web/states/",
)
