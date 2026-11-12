import { createRuntime } from "@crvouga/mockingbird-service-checkr"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * What a browser shows for Checkr's API while a fault preset that answers HTML is on: the proxy page a client gets instead of JSON.
 */
export default {
  title: "Emulators/Checkr/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/checkr/src/runtime.ts"] },
} satisfies Meta

const ORIGIN = "https://api.checkr.com"

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

/** `non_json`: every call answers a 502 page from a proxy. */
export const ProxyError: StoryObj = failing("non_json", "/v1/candidates")
