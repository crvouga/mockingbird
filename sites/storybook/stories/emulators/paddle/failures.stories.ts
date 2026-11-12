import { createRuntime } from "@crvouga/mockingbird-service-paddle"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * What a browser shows for Paddle's API while a fault preset that answers HTML is on: the gateway page a client gets instead of Paddle's JSON envelope.
 */
export default {
  title: "Emulators/Paddle/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/paddle/src/runtime.ts"] },
} satisfies Meta

const ORIGIN = "https://api.paddle.com"

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

/** `bad_gateway_html`: reads answer a 502 page. */
export const BadGateway: StoryObj = failing("bad_gateway_html", "/customers")
