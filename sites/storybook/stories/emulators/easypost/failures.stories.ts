import { createRuntime } from "@crvouga/mockingbird-service-easypost"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * What a browser shows for EasyPost's tracker API while a fault preset that answers HTML is on: the gateway page a client gets instead of JSON.
 */
export default {
  title: "Emulators/EasyPost/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/easypost/src/runtime.ts"] },
} satisfies Meta

const ORIGIN = "https://api.easypost.com"

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

/** `gateway_html`: trackers answer a 502 page. */
export const BadGateway: StoryObj = failing("gateway_html", "/v2/trackers")
