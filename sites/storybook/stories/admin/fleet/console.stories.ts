import { mount } from "@crvouga/mockingbird-ui/react/client"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { createElement } from "react"
import { expect, userEvent } from "storybook/test"
import { FleetConsole } from "../../../../../packages/service/core/src/ui/fleet-console.js"
import { fleetConsolePage } from "../../../../../packages/service/core/src/ui/server.js"
import { frame, frameDocument } from "../../../src/frame.js"
import type { Emulator } from "../../../src/story.js"

/**
 * The node adapter's fleet console (`GET /__admin/ui` on the fleet supervisor): admin key and
 * namespace, the children's admin links, and namespace actions, over the fleet API. The page is
 * React and HeroUI (packages/service/core/src/ui), server-rendered and then hydrated, as the
 * adapter serves it. `FleetManagement` needs Node, so the fleet API is answered by a recorded
 * process of three children, through the frame's `fetch`.
 */
export default {
  title: "Admin/Node adapter/Fleet console",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/adapters/node/src/fleet-management.ts",
      "packages/service/core/src/ui/fleet-console.tsx",
      "packages/service/core/src/ui/server.tsx",
      "packages/service/core/src/ui/client.tsx",
    ],
  },
} satisfies Meta

const ORIGIN = "https://fleet.mock"
const KEY = "mb_admin_storybook"
const BASE = `${ORIGIN}/__admin/fleet`

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
 * The console in a frame: the server-rendered page, hydrated as its client bundle does, with the
 * frame's own `fetch` (which the frame routes to the recorded fleet).
 */
const fleetPage = (dashboard?: string, theme?: "dark"): StoryObj => ({
  render: () => {
    let html = fleetConsolePage({ base: BASE, ...(dashboard ? { dashboard } : {}) })
    if (theme)
      html = html.replace(
        '<html lang="en">',
        `<html lang="en" data-theme="${theme}" class="${theme}">`,
      )
    const iframe = frame(html, { url: `${ORIGIN}/__admin/ui`, emulator: fleet })
    iframe.addEventListener(
      "load",
      () => {
        const win = iframe.contentWindow as (Window & typeof globalThis) | null
        const root = iframe.contentDocument?.getElementById("root")
        if (!win || !root) return
        mount(
          root,
          createElement(FleetConsole, {
            base: BASE,
            ...(dashboard ? { dashboard } : {}),
            fetch: (input, init) => win.fetch(input, init),
          }),
        )
      },
      { once: true },
    )
    return iframe
  },
})

const hydrated = async (canvas: HTMLElement) => {
  const doc = await frameDocument(canvas)
  for (let attempt = 0; attempt < 100 && !doc.querySelector('[aria-label="Theme"]'); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 30))
  return doc
}

async function connect(canvas: HTMLElement, key = KEY) {
  const doc = await hydrated(canvas)
  const user = userEvent.setup({ document: doc })
  const keyInput = doc.querySelector<HTMLInputElement>('[data-testid="fleet-key"]')
  if (!keyInput) throw new Error("No admin key field")
  await user.type(keyInput, key)
  return { doc, user }
}

const answer = async (doc: Document, text: string) => {
  const read = () => doc.querySelector('[data-testid="fleet-answer"]')?.textContent ?? ""
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (read().includes(text)) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  await expect(read()).toContain(text)
}

const press = async (doc: Document, user: ReturnType<typeof userEvent.setup>, testId: string) =>
  user.click(doc.querySelector(`[data-testid="${testId}"]`) as HTMLElement)

/** As opened: nothing loaded until Refresh. */
export const Console: StoryObj = {
  ...fleetPage(),
  play: async ({ canvasElement }) => {
    const doc = await hydrated(canvasElement)
    await expect(doc.querySelector("h1")?.textContent).toBe("Fleet console")
  },
}

/** Pinned dark. */
export const Dark: StoryObj = fleetPage(undefined, "dark")

/** On a phone. */
export const OnAPhone: StoryObj = {
  ...fleetPage(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Started with a dashboard: the console links to it. */
export const WithDashboard: StoryObj = {
  ...fleetPage("http://127.0.0.1:6006/"),
  play: async ({ canvasElement }) => {
    const doc = await hydrated(canvasElement)
    await expect(doc.querySelector("#dashboard a")?.getAttribute("href")).toBe(
      "http://127.0.0.1:6006/",
    )
  },
}

/** Refreshed with the admin key: each child's admin link, then the namespace's operations. */
export const Refreshed: StoryObj = {
  ...fleetPage(),
  play: async ({ canvasElement }) => {
    const { doc, user } = await connect(canvasElement)
    await press(doc, user, "fleet-refresh")
    await answer(doc, "op_01")
    await expect(doc.querySelector('[data-testid="fleet-children"]')?.textContent).toContain(
      "postgres",
    )
    await expect(doc.querySelector('a[href="http://127.0.0.1:4012/__admin/ui"]')).not.toBeNull()
  },
}

/** Reset namespace run. */
export const ResetNamespace: StoryObj = {
  ...fleetPage(),
  play: async ({ canvasElement }) => {
    const { doc, user } = await connect(canvasElement)
    await press(doc, user, "fleet-reset")
    await answer(doc, '"reset"')
  },
}

/** A wrong key: the fleet's error, as JSON. */
export const WrongKey: StoryObj = {
  ...fleetPage(),
  play: async ({ canvasElement }) => {
    const { doc, user } = await connect(canvasElement, "nope")
    await press(doc, user, "fleet-checkpoint")
    await answer(doc, "admin key required")
  },
}
