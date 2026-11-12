import { createRuntime } from "@crvouga/mockingbird-service-caretalk"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * What a browser shows for CareTalk's API while a fault preset that answers HTML is on: the gateway page a client gets instead of JSON.
 */
export default {
  title: "Emulators/CareTalk/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/caretalk/src/runtime.ts"] },
} satisfies Meta

const ORIGIN = "https://api.caretalk.example"

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

/** `gateway_html`: every call answers a 502 page. */
export const BadGateway: StoryObj = failing("gateway_html", "/externalapi/States")
