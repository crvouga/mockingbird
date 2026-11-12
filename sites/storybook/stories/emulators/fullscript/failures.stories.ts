import { createRuntime } from "@crvouga/mockingbird-service-fullscript"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * What a browser shows for a Fullscript lab result PDF link while a fault preset that answers HTML is on: a sign-in page where the PDF should be.
 */
export default {
  title: "Emulators/Fullscript/Failure pages",
  parameters: { layout: "fullscreen", sources: ["packages/service/fullscript/src/runtime.ts"] },
} satisfies Meta

const ORIGIN = "https://us.fullscript.com"

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

/** `pdf_not_pdf`: a result PDF link answers 200 with an HTML sign-in page. */
export const ResultPdfIsASignInPage: StoryObj = failing("pdf_not_pdf", "/results/art_storybook")
