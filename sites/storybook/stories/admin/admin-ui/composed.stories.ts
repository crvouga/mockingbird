import { createRuntime as plane } from "@crvouga/mockingbird-service-plane"
import { createRuntime as resend } from "@crvouga/mockingbird-service-resend"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { composeAdminRoutes } from "../../../../../packages/admin-ui/src/compose.js"
import type { Emulator } from "../../../src/story.js"
import { type AdminVisit, admin, choose, SHELL_SOURCES, servedConfig, shows } from "./admin.js"
import { shop } from "./store.js"

/**
 * One admin shell over several emulators (`composeAdminRoutes`, what `composeAdminApis` and the
 * fleet dashboard serve): an emulator picker in the header, each API behind
 * `/__admin/apis/<id>`, and a palette that jumps across all of them.
 */
export default {
  title: "Admin/Admin UI/Several emulators",
  parameters: {
    layout: "fullscreen",
    sources: [
      ...SHELL_SOURCES,
      "packages/admin-ui/src/compose.ts",
      "packages/admin-ui/src/index.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://admin.mock"

/** Stripe in use, a Resend that has sent mail, and a Plane workspace, behind one shell. */
async function fleet(): Promise<AdminVisit> {
  const { s } = await shop()
  const mail = resend()
  for (const subject of ["Welcome to Gamezilla", "Your receipt", "Your plan renews soon"])
    await mail.fetch(
      new Request("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: "Bearer re_storybook", "content-type": "application/json" },
        body: JSON.stringify({
          from: "Gamezilla <hello@gamezilla.dev>",
          to: ["alice@gmail.com"],
          subject,
          html: "<p>Hi</p>",
        }),
      }),
    )
  const apis = await Promise.all(
    (
      [
        ["stripe", "Stripe", s.emulator],
        ["resend", "Resend", mail],
        ["plane", "Plane", plane()],
      ] as const
    ).map(async ([id, label, emulator]: readonly [string, string, Emulator]) => {
      const served = await servedConfig(emulator, `https://${id}.mock/__admin/ui`)
      return { ...served, id, label, fetch: (request: Request) => emulator.fetch(request) }
    }),
  )
  const composed = composeAdminRoutes(apis, { brandsUrl: "/__admin/ui/brands.json" })
  return { emulator: composed, origin: ORIGIN, config: composed.config }
}

export const Overview: StoryObj = admin(fleet, { ready: "PostSubscriptions" })

/** The emulator picker opened. */
export const EmulatorPicker: StoryObj = admin(fleet)
EmulatorPicker.play = async ({ canvasElement }) => {
  await shows(canvasElement, "PostSubscriptions")
  await choose(canvasElement, "Emulator", "res", "Resend")
  await shows(canvasElement, "SendEmail")
}

/** `?emulator=resend`: the shell opens on Resend's journal. */
export const OpenedOnAnotherEmulator: StoryObj = admin(fleet, {
  query: "?emulator=resend",
  view: "journal",
  ready: "SendEmail",
})

/** The palette lists every screen of every emulator. */
export const PaletteAcrossEmulators: StoryObj = admin(fleet)
PaletteAcrossEmulators.play = async ({ canvasElement }) => {
  await shows(canvasElement, "PostSubscriptions")
  canvasElement.firstElementChild?.firstElementChild?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
  )
  await shows(canvasElement, "Plane · Clock")
}
