import { createRuntime } from "@crvouga/mockingbird-service-persona"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { hands } from "../../../src/interact.js"
import { page } from "../../../src/story.js"
import { departedTo, shows } from "../oauth/browser.js"

/**
 * Persona's hosted inquiry flow (`/verify?inquiry-id=`), the page an app sends a member to for
 * identity verification. Opening it starts the inquiry; each link finishes it with an outcome
 * through `/verify/complete`, then redirects to the app's `redirect-uri` (where the story stops)
 * or, without one, says how it ended.
 */
export default {
  title: "Emulators/Persona/Hosted flow",
  parameters: { layout: "fullscreen", sources: ["packages/service/persona/src/index.ts"] },
} satisfies Meta

const ORIGIN = "https://withpersona.mock"
const RETURN = "https://app.example/verify/done"

/** An inquiry created through the API, as the app does before sending the member over. */
async function inquiry(redirect?: string) {
  const emulator = createRuntime()
  const response = await emulator.fetch(
    new Request(`${ORIGIN}/inquiries`, {
      method: "POST",
      headers: {
        authorization: "Bearer persona_sandbox_storybook",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        data: {
          attributes: {
            "inquiry-template-id": "itmpl_identity",
            "reference-id": "member-1",
            ...(redirect ? { "redirect-uri": redirect } : {}),
          },
        },
      }),
    }),
  )
  const { data } = (await response.json()) as { data: { id: string } }
  return { emulator, id: data.id }
}

const verify = (redirect?: string) =>
  page(async () => {
    const { emulator, id } = await inquiry(redirect)
    return { emulator, url: `${ORIGIN}/verify?inquiry-id=${id}` }
  })

/** Press the link for `outcome`. */
const finish = async (canvas: HTMLElement, outcome: string) => {
  const page = await hands(canvas)
  page.doc.querySelector<HTMLElement>(`a[data-outcome="${outcome}"]`)?.click()
  return page.navigated()
}

export const Verify: StoryObj = verify(RETURN)

export const OnAPhone: StoryObj = {
  ...verify(RETURN),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Approved: back to the app with the inquiry's id and status. */
export const Approved: StoryObj = {
  ...verify(RETURN),
  play: async ({ canvasElement }) => {
    await finish(canvasElement, "approve")
    const back = await departedTo(canvasElement)
    expect(`${back.origin}${back.pathname}`).toBe(RETURN)
    expect(back.searchParams.get("status")).toBe("approved")
    expect(back.searchParams.get("reference-id")).toBe("member-1")
  },
}

export const Declined: StoryObj = {
  ...verify(RETURN),
  play: async ({ canvasElement }) => {
    await finish(canvasElement, "decline")
    expect((await departedTo(canvasElement)).searchParams.get("status")).toBe("declined")
  },
}

/** Without a `redirect-uri` the page says how the inquiry ended. */
export const SentToReview: StoryObj = {
  ...verify(),
  play: async ({ canvasElement }) => {
    await finish(canvasElement, "needs_review")
    await shows(canvasElement, "Done: needs_review")
  },
}

export const CompletedWithoutDecision: StoryObj = {
  ...verify(),
  play: async ({ canvasElement }) => {
    await finish(canvasElement, "complete")
    await shows(canvasElement, "Done: completed")
  },
}

export const Failed: StoryObj = {
  ...verify(),
  play: async ({ canvasElement }) => {
    await finish(canvasElement, "fail")
    await shows(canvasElement, "Done: failed")
  },
}

/** An outcome the inquiry can no longer reach: it was declined while the page stayed open. */
export const OutcomeConflict: StoryObj = (() => {
  let emulator: ReturnType<typeof createRuntime>
  let id = ""
  return {
    ...page(async () => {
      ;({ emulator, id } = await inquiry())
      return { emulator, url: `${ORIGIN}/verify?inquiry-id=${id}` }
    }),
    play: async ({ canvasElement }) => {
      await emulator.fetch(
        new Request(`${ORIGIN}/__admin/inquiries/${id}/decline`, { method: "POST" }),
      )
      await finish(canvasElement, "fail")
      await shows(canvasElement, "cannot fail")
    },
  }
})()

export const InquiryNotFound: StoryObj = page(() => ({
  emulator: createRuntime(),
  url: `${ORIGIN}/verify?inquiry-id=inq_000000000000000000000000`,
}))
