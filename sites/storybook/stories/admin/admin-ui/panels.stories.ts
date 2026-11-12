import type { Panel } from "@crvouga/mockingbird-admin-ui/browser"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { userEvent, within } from "storybook/test"
import { type AdminVisit, admin, emulatorFetch, SHELL_SOURCES, shows } from "./admin.js"
import { brandCatalog } from "./brand.js"
import { ORIGIN, shop } from "./store.js"

/**
 * A bespoke panel an emulator adds to its admin (`adminUi.panels`: markup plus a script given
 * `(root, api)`), in the navigation beside the built-in screens. No published emulator ships one
 * yet, so the story adds one to Stripe's `GET /__admin/ui/manifest` answer.
 */
export default {
  title: "Admin/Admin UI/Custom panel",
  parameters: {
    layout: "fullscreen",
    sources: [...SHELL_SOURCES, "packages/service/core/src/surface.ts"],
  },
} satisfies Meta

const PANEL: Panel = {
  id: "records",
  title: "Record counter",
  description: "Counts the records in every collection of this namespace.",
  html: '<p>Press Count to read <code>GET /__admin/state</code>.</p><button type="button" data-testid="count">Count</button> <output data-testid="total"></output>',
  script: `const button = root.querySelector("button"), output = root.querySelector("output");
button.onclick = async () => {
  const state = await api.get("/state");
  output.textContent = state.collections.reduce((sum, c) => sum + c.count, 0) + " records";
};`,
}

/** Stripe in use, its manifest carrying `panel`. */
const withPanel =
  (panel: Panel, panelScript?: AdminVisit["panelScript"]) => async (): Promise<AdminVisit> => {
    const { s } = await shop()
    const forward = emulatorFetch(s.emulator, ORIGIN, await brandCatalog("stripe"))
    return {
      emulator: s.emulator,
      origin: ORIGIN,
      ...(panelScript !== undefined ? { panelScript } : {}),
      fetch: async (input, init) => {
        const response = await forward(input, init)
        if (!String(input).endsWith("/ui/manifest")) return response
        const manifest = (await response.json()) as { panels: Panel[] }
        return Response.json({ ...manifest, panels: [...manifest.panels, panel] })
      },
    }
  }

/** The panel's script running: Count reads the admin API. */
export const Running: StoryObj = admin(withPanel(PANEL), { view: "records", ready: "Press Count" })
Running.play = async ({ canvasElement }) => {
  await shows(canvasElement, "Press Count")
  await userEvent.click(within(canvasElement).getByTestId("count"))
  await shows(canvasElement, / \d+ records/)
}

/**
 * A page that runs no scripts given as text (the `./browser` module, or a strict Content
 * Security Policy): the panel shows its markup and says where it works.
 */
export const Inactive: StoryObj = admin(withPanel(PANEL, false), {
  view: "records",
  ready: "This panel works on the emulator's own admin page",
})

/** A script that throws: the error shows above the panel. */
export const ScriptError: StoryObj = admin(
  withPanel({ ...PANEL, script: 'throw new Error("records is not defined")' }),
  { view: "records", ready: "records is not defined" },
)
