import { createRuntime } from "@crvouga/mockingbird-service-resend"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { markup } from "../../../src/story.js"

/**
 * What Resend's API answers in HTML while a fault preset is on: the 500 page a send gets instead
 * of JSON. A send is a POST, which a browser never makes by address, so the story shows the body
 * the real emulator answered to one.
 */
export default {
  title: "Emulators/Resend/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/resend/src/runtime.ts"] },
} satisfies Meta

const ORIGIN = "https://api.resend.com"

/** `non_json_500`: a send answers a 500 page. */
export const InternalServerError: StoryObj = markup(async () => {
  const emulator = createRuntime()
  const json = { "content-type": "application/json" }
  await emulator.fetch(
    new Request(`${ORIGIN}/__admin/faults/presets/non_json_500`, {
      method: "POST",
      headers: json,
      body: "{}",
    }),
  )
  const sent = await emulator.fetch(
    new Request(`${ORIGIN}/emails`, {
      method: "POST",
      headers: { ...json, authorization: "Bearer re_storybook" },
      body: JSON.stringify({
        from: "Acme <onboarding@acme.example>",
        to: ["ada@example.com"],
        subject: "Welcome",
        html: "<p>Hello</p>",
      }),
    }),
  )
  return sent.text()
})
