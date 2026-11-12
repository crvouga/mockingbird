import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent } from "storybook/test"
import source from "../../../../../packages/adapters/node/src/fleet-management.ts?raw"
import { frame, frameDocument } from "../../../src/frame.js"
import type { Emulator } from "../../../src/story.js"

/**
 * The node adapter's fleet console (`GET /__admin/ui` on the fleet supervisor): admin key and namespace, the
 * children's admin links, and namespace actions, over the fleet API. `FleetManagement` needs
 * Node (`node:async_hooks`, `node:crypto`), so it cannot run in the browser: the story draws the
 * console with the module's own `fleetConsole` template (read from its source) and answers the
 * fleet API with a recorded process of three children.
 */
export default {
  title: "Admin/Node adapter/Fleet console",
  parameters: { layout: "fullscreen", sources: ["packages/adapters/node/src/fleet-management.ts"] },
} satisfies Meta

const ORIGIN = "https://fleet.mock"
const KEY = "mb_admin_storybook"

/** `fleetConsole(prefix, dashboard?)` as `fleet-management.ts` defines it. */
function fleetConsole(prefix: string, dashboard?: string): string {
  const template =
    /\nconst fleetConsole = \(prefix: string, dashboard\?: string\) =>\s*(`[\s\S]*?`)\n/.exec(
      source,
    )?.[1]
  const escaping = /\nconst escapeAttribute = \(value: string\) =>\s*([\s\S]*?)\n\n/.exec(
    source,
  )?.[1]
  if (!template || !escaping)
    throw new Error("fleet-management.ts no longer defines fleetConsole and escapeAttribute")
  const escapeAttribute = new Function("value", `return ${escaping}`) as (value: string) => string
  return (
    new Function("prefix", "dashboard", "escapeAttribute", `return ${template}`) as (
      prefix: string,
      dashboard: string | undefined,
      escapeAttribute: (value: string) => string,
    ) => string
  )(prefix, dashboard, escapeAttribute)
}

/** A fleet of Stripe, Resend and Postgres children, answering as `FleetManagement.handle` does. */
const fleet: Emulator = {
  async fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get("x-mockingbird-admin-key") !== KEY)
      return Response.json(
        {
          error: { type: "mockingbird_admin", code: "unauthorized", message: "admin key required" },
        },
        { status: 401 },
      )
    const route = url.pathname.replace(/^\/__admin\/fleet/, "")
    if (route === "" && request.method === "GET")
      return Response.json({
        version: 1,
        archiveFormat: "mockingbird.fleet/v1",
        manifest: {
          version: 1,
          services: {
            stripe: {
              protocol: "http",
              url: "http://127.0.0.1:4010",
              adminUrl: "http://127.0.0.1:4010/__admin/ui",
            },
            resend: {
              protocol: "http",
              url: "http://127.0.0.1:4011",
              adminUrl: "http://127.0.0.1:4011/__admin/ui",
            },
            postgres: {
              protocol: "postgres",
              url: "postgres://127.0.0.1:5433",
              adminUrl: "http://127.0.0.1:4012/__admin/ui",
            },
          },
        },
        namespaces: [{ namespace: "default", services: 3, idleMs: 1200 }],
      })
    if (route === "/operations")
      return Response.json({
        operations: [
          {
            id: "op_01",
            kind: "snapshot",
            namespace: url.searchParams.get("namespace"),
            status: "succeeded",
          },
        ],
      })
    const action = /^\/namespaces\/([^/]+)\/(snapshots|reset)$/.exec(route)
    if (action && request.method === "POST")
      return Response.json(
        action[2] === "reset"
          ? { namespace: action[1], reset: ["stripe", "resend", "postgres"] }
          : { id: "cp_01", namespace: action[1], services: ["stripe", "resend", "postgres"] },
      )
    return Response.json(
      { error: { type: "mockingbird_admin", code: "not_found", message: "not found" } },
      { status: 404 },
    )
  },
}

/**
 * The console in a frame. Its script fetches the root-relative `/__admin/fleet`; a frame drawn
 * from markup resolves that against Storybook's address, so a `<base>` gives it the fleet's.
 */
const fleetPage = (dashboard?: string): StoryObj => ({
  render: () =>
    frame(
      fleetConsole("/__admin", dashboard).replace(
        '<meta charset="utf-8">',
        `<meta charset="utf-8"><base href="${ORIGIN}/">`,
      ),
      {
        url: `${ORIGIN}/__admin/ui`,
        emulator: fleet,
      },
    ),
})

async function connect(canvas: HTMLElement, key = KEY) {
  const doc = await frameDocument(canvas)
  const user = userEvent.setup({ document: doc })
  const keyInput = doc.querySelector<HTMLInputElement>("#key")
  if (!keyInput) throw new Error("No admin key field")
  await user.type(keyInput, key)
  return { doc, user }
}

const result = async (doc: Document, text: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (doc.querySelector("#result")?.textContent?.includes(text)) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  await expect(doc.querySelector("#result")?.textContent).toContain(text)
}

/** As opened: nothing loaded until Refresh. */
export const Console: StoryObj = fleetPage()

/** Started with a dashboard: the console links to it. */
export const WithDashboard: StoryObj = fleetPage("http://127.0.0.1:6006/")

/** Refreshed with the admin key: each child's admin link, then the namespace's operations. */
export const Refreshed: StoryObj = {
  ...fleetPage(),
  play: async ({ canvasElement }) => {
    const { doc, user } = await connect(canvasElement)
    await user.click(doc.querySelector("#refresh") as HTMLElement)
    await result(doc, "op_01")
    await expect(doc.querySelector("#children")?.textContent).toContain("postgres (postgres)")
  },
}

/** Reset namespace run. */
export const ResetNamespace: StoryObj = {
  ...fleetPage(),
  play: async ({ canvasElement }) => {
    const { doc, user } = await connect(canvasElement)
    await user.selectOptions(doc.querySelector("#action") as HTMLSelectElement, "reset")
    await user.click(doc.querySelector("#run") as HTMLElement)
    await result(doc, '"reset"')
  },
}

/** A wrong key: the fleet's error, as JSON. */
export const WrongKey: StoryObj = {
  ...fleetPage(),
  play: async ({ canvasElement }) => {
    const { doc, user } = await connect(canvasElement, "nope")
    await user.click(doc.querySelector("#run") as HTMLElement)
    await result(doc, "admin key required")
  },
}
