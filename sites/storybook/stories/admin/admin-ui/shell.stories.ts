import { createRuntime } from "@crvouga/mockingbird-service-stripe"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, within } from "storybook/test"
import { SECRET_KEY } from "../../emulators/stripe/stripe.js"
import { type AdminVisit, admin, SHELL_SOURCES, shows } from "./admin.js"
import { fresh, ORIGIN, store } from "./store.js"

/**
 * The admin shell every emulator serves at `/__admin/ui`: header (namespace, admin key, theme,
 * the ⌘K palette), navigation and the overview screen, on a Stripe emulator in use. Each other
 * screen is in `Admin/Admin UI/Screens`.
 */
export default {
  title: "Admin/Admin UI/Shell",
  parameters: { layout: "fullscreen", sources: SHELL_SOURCES },
} satisfies Meta

const phone = { viewport: { value: "phone", isRotated: false } }

/** Overview: service, collection and record counts, environment, recent requests. */
export const Overview: StoryObj = admin(store(), { ready: "PostSubscriptions" })

/** An emulator nothing has called yet: no records, no requests. */
export const Empty: StoryObj = admin(fresh, { ready: "Reset namespace" })

export const DarkTheme: StoryObj = admin(store(), { dark: true, ready: "PostSubscriptions" })

/** Under 760px the navigation collapses to icons and the header wraps. */
export const OnAPhone: StoryObj = {
  ...admin(store(), { width: 390, ready: "PostSubscriptions" }),
  globals: phone,
}

/** Several namespaces in use: the namespace picker opened. */
export const Namespaces: StoryObj = admin(
  store(async ({ s }) => {
    for (const namespace of ["staging", "checkout-e2e"])
      await s.emulator.fetch(
        new Request(`${ORIGIN}/v1/customers`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            "content-type": "application/x-www-form-urlencoded",
            "x-mockingbird-namespace": namespace,
          },
          body: "email=carol%40example.com",
        }),
      )
  }),
  { query: "?namespace=staging" },
)
Namespaces.play = async ({ canvasElement }) => {
  await shows(canvasElement, "PostCustomers")
  await userEvent.click(await within(canvasElement).findByRole("combobox", { name: "Namespace" }))
  await shows(canvasElement, "checkout-e2e")
}

/** The navigation collapsed to icons by its trigger. */
export const SidebarCollapsed: StoryObj = admin(store())
SidebarCollapsed.play = async ({ canvasElement }) => {
  await shows(canvasElement, "PostSubscriptions")
  const trigger = canvasElement.querySelector<HTMLElement>(".ant-layout-sider-trigger")
  if (!trigger) throw new Error("No sider trigger")
  await userEvent.click(trigger)
  await expect(canvasElement.querySelector(".ant-layout-sider-collapsed")).not.toBeNull()
}

/** Waiting on the first answer from the emulator. */
export const Loading: StoryObj = admin(
  async () => ({ ...fresh(), fetch: () => new Promise<Response>(() => {}) }),
  {
    ready: "Loading administration",
  },
)

/** The emulator cannot be reached: every request fails. */
export const Unreachable: StoryObj = admin(
  async () => ({ ...fresh(), fetch: () => Promise.reject(new TypeError("Failed to fetch")) }),
  { ready: "Failed to fetch" },
)

const ADMIN_KEY = "mb_admin_storybook"

/** An emulator started with `adminKey`: the admin API refuses a request without it. */
async function locked(): Promise<AdminVisit> {
  const emulator = createRuntime({ adminKey: ADMIN_KEY })
  await emulator.fetch(
    new Request(`${ORIGIN}/v1/customers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "email=alice%40gmail.com",
    }),
  )
  return { emulator, origin: ORIGIN }
}

export const AdminKeyRequired: StoryObj = admin(locked, { ready: "Request failed" })

/** The key typed into the header and connected: the overview loads. */
export const ConnectingWithAKey: StoryObj = admin(locked)
ConnectingWithAKey.play = async ({ canvasElement }) => {
  await shows(canvasElement, "Request failed")
  await userEvent.type(within(canvasElement).getByLabelText("Admin key"), ADMIN_KEY)
  await userEvent.click(within(canvasElement).getByRole("button", { name: "Connect" }))
  await shows(canvasElement, "PostCustomers")
}

/** `?admin_key=` on the address: connected at once, and the key leaves the address. */
export const AdminKeyInTheAddress: StoryObj = admin(locked, {
  query: `?admin_key=${ADMIN_KEY}`,
  ready: "PostCustomers",
})

/** The ⌘K palette: every screen of every emulator the shell presents. */
export const CommandPalette: StoryObj = admin(store())
CommandPalette.play = async ({ canvasElement }) => {
  await openPalette(canvasElement)
}

/** Press Jump in the header; resolves with the palette's search box. */
async function openPalette(canvas: HTMLElement): Promise<HTMLElement> {
  await shows(canvas, "PostSubscriptions")
  await userEvent.click(within(canvas).getByRole("button", { name: /Jump/ }))
  const search = await within(canvas).findByRole("combobox", { name: "Admin command palette" })
  await shows(canvas, "stripe · Snapshot & restore")
  return search
}

/** Ctrl + K on the shell opens the palette too. */
export const PaletteShortcut: StoryObj = admin(store())
PaletteShortcut.play = async ({ canvasElement }) => {
  await shows(canvasElement, "PostSubscriptions")
  // The shell listens on its host (`shortcutTarget`), the element inside the story's page.
  canvasElement.firstElementChild?.firstElementChild?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
  )
  await within(canvasElement).findByRole("combobox", { name: "Admin command palette" })
}

/** Typing narrows the commands; keywords match too ("rollback" finds Snapshot & restore). */
export const PaletteSearch: StoryObj = admin(store())
PaletteSearch.play = async ({ canvasElement }) => {
  await userEvent.type(await openPalette(canvasElement), "rollback")
  await expect(within(canvasElement).getAllByRole("option")).toHaveLength(1)
}

export const PaletteNoMatches: StoryObj = admin(store())
PaletteNoMatches.play = async ({ canvasElement }) => {
  await userEvent.type(await openPalette(canvasElement), "zebra")
  await shows(canvasElement, "No commands found")
}

/** A palette command chosen with the keyboard: the shell switches screen. */
export const PaletteJump: StoryObj = admin(store())
PaletteJump.play = async ({ canvasElement }) => {
  await userEvent.type(await openPalette(canvasElement), "journal{Enter}")
  await shows(canvasElement, "Request attempts")
}
