import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { mountSystemHarness } from "../../../../packages/ui/src/system-harness.js"
import { SYSTEM_ICONS } from "../../../../packages/ui/src/system-icons.js"
import { ORDER_KEY, ROTATION_KEY } from "../../../../packages/ui/src/system-rotation.js"
import type {
  SystemDevStatus,
  SystemService,
  SystemServiceMode,
  SystemServices,
} from "../../../../packages/ui/src/system-screen.js"

/**
 * The System screen of the preview shell: the apps in this tab, the dev proxy's status, and every
 * third-party service switched between its emulator and a real non-production resource (a
 * vendor's test mode or sandbox, a dev instance). Services come from an in-memory fake with
 * the lab's services.
 */
export default {
  title: "Examples/System harness/System screen",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-harness.ts",
      "packages/ui/src/system-screen.ts",
      "packages/ui/src/system-rotation.ts",
      "packages/ui/src/system-icons.ts",
    ],
  },
} satisfies Meta

const ENDPOINT = "https://lab-preview.example.dev/__dev"

type Lab = { id: string; label: string; category: string; unavailable?: string }
const LAB: readonly Lab[] = [
  { id: "stripe", label: "Stripe", category: "Payments" },
  { id: "junction", label: "Junction", category: "Lab testing" },
  { id: "resend", label: "Resend", category: "Email" },
  { id: "twilio", label: "Twilio", category: "SMS" },
  { id: "fcm", label: "Firebase Cloud Messaging", category: "Push" },
  { id: "slack", label: "Slack", category: "Staff chat" },
  {
    id: "oauth",
    label: "Google and Apple sign-in",
    category: "Identity",
    unavailable: "Sign-in redirects can't be forwarded",
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    category: "Database",
    unavailable: "Runs in this browser; there is no remote dev instance to reach",
  },
]

type Fake = {
  /** What the dev proxy on this app's origin says. */
  state: SystemDevStatus["state"]
  dev?: readonly string[]
  /** The proxy blocks these ids with this reason (its allow-list did not match). */
  blocked?: Record<string, string>
  /** setMode rejects for these ids with this message. */
  failing?: Record<string, string>
  /** Milliseconds every call takes. */
  delay?: number
}

/** An in-memory SystemServices with the proxy behaviour the preview package implements. */
function fakeServices({
  state,
  dev = [],
  blocked = {},
  failing = {},
  delay = 120,
}: Fake): SystemServices {
  const modes = new Map<string, SystemServiceMode>(
    LAB.map((lab) => [lab.id, dev.includes(lab.id) ? "dev" : "emulated"]),
  )
  const wait = () => new Promise((resolve) => setTimeout(resolve, delay))
  const status = (): SystemDevStatus => {
    if (state === "none") return { state, message: "No dev proxy is configured for this preview." }
    if (state === "unreachable")
      return { state, message: "The dev proxy did not answer.", endpoint: ENDPOINT }
    return { state: "ready", message: "Dev proxy connected.", endpoint: ENDPOINT }
  }
  const reason = (lab: Lab) => {
    if (lab.unavailable) return lab.unavailable
    const now = status()
    if (now.state !== "ready") return now.message.replace(/\.$/, "")
    return blocked[lab.id]
  }
  return {
    async list() {
      await wait()
      return {
        dev: status(),
        services: LAB.map((lab): SystemService => {
          const unavailable = reason(lab)
          return {
            id: lab.id,
            label: lab.label,
            category: lab.category,
            mode: modes.get(lab.id) ?? "emulated",
            ...(unavailable ? { unavailable } : {}),
          }
        }),
      }
    },
    async setMode(id, mode) {
      await wait()
      const lab = LAB.find((candidate) => candidate.id === id)
      if (!lab) throw new Error(`Unknown service ${id}`)
      if (mode === "dev") {
        const blocked = reason(lab)
        if (blocked) throw new Error(blocked)
        if (failing[id]) throw new Error(failing[id])
      }
      modes.set(id, mode)
    },
  }
}

const SURFACES = [
  {
    id: "app",
    label: "Lab workspace",
    description: "The patient, clinician and admin app, signed out and seeded with demo data.",
    // An app without an icon of its own: an image URL (here Storybook's favicon).
    icon: { src: "./favicon.svg" },
  },
  {
    id: "emulators",
    label: "Emulators",
    description: "The admin UI of every emulator: state, requests, clock, faults and SQL.",
    icon: SYSTEM_ICONS.emulators,
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Every email, text, push and staff chat message the app sent.",
    icon: SYSTEM_ICONS.notifications,
  },
]

let stop: (() => void) | undefined
const screen =
  (services?: Fake, extra: { docs?: boolean } = { docs: true }) =>
  () => {
    stop?.()
    localStorage.removeItem(ROTATION_KEY)
    localStorage.removeItem(ORDER_KEY)
    localStorage.removeItem("mockingbird.system-switcher.dock")
    const host = document.createElement("div")
    host.style.height = "100vh"
    const harness = mountSystemHarness(
      host,
      SURFACES.map((surface) => ({
        ...surface,
        mount(panel: HTMLElement) {
          panel.textContent = `${surface.label} is open.`
          return () => panel.replaceChildren()
        },
      })),
      {
        ...(services ? { services: fakeServices(services) } : {}),
        ...(extra.docs ? { docsUrl: "https://mockingbird.chrisvouga.dev/docs/dev-resources" } : {}),
      },
    )
    stop = () => harness.destroy()
    return host
  }

const row = (canvas: HTMLElement, id: string) => {
  const found = canvas.querySelector<HTMLElement>(`[data-service="${id}"]`)
  if (!found) throw new Error(`No row for ${id}`)
  return within(found)
}
const summary = (canvas: HTMLElement) =>
  within(canvas).findByTestId("system-services-summary", {}, { timeout: 3000 })
const loaded = async (canvas: HTMLElement) => {
  await waitFor(() => expect(canvas.querySelector('[data-service="stripe"]')).not.toBeNull(), {
    timeout: 3000,
  })
}

/** Everything emulated with the proxy ready; arrows on the segmented control switch a service. */
export const AllEmulated: StoryObj = {
  render: screen({ state: "ready" }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await expect(page.getByRole("heading", { level: 1, name: "System" })).toBeVisible()
    await expect(page.getByText("Everything this preview runs, in this browser tab.")).toBeVisible()
    await expect(page.getByRole("link", { name: /How dev resources work/ })).toBeVisible()
    // Without a live build, no status dot, update toast or Preview card.
    await expect(page.queryByTestId("system-build-dot")).toBeNull()
    await expect(page.queryByTestId("system-update-toast")).toBeNull()
    await expect(page.queryByTestId("system-preview")).toBeNull()
    await loaded(canvasElement)
    await expect(await summary(canvasElement)).toHaveTextContent("8 services · 8 emulated · 0 dev")
    const access = page.getByTestId("system-dev-proxy")
    await expect(access).toHaveAttribute("data-state", "ready")
    await expect(within(access).getByText("Dev proxy connected.")).toBeVisible()
    await expect(within(access).getByText(ENDPOINT)).toBeVisible()
    await expect(
      within(access).getByText("It runs on this app's own origin and adds the credentials itself."),
    ).toBeVisible()
    await expect(within(access).queryByRole("textbox")).toBeNull()
    await expect(within(access).queryByRole("button")).toBeNull()
    await expect(
      page.queryAllByText("Dev resource").filter((node) => !isHidden(node)),
    ).toHaveLength(0)
    const oauth = row(canvasElement, "oauth")
    await expect(oauth.getByRole("radio", { name: "Dev" })).toBeDisabled()
    await expect(oauth.getByText("Sign-in redirects can't be forwarded")).toBeVisible()

    const stripe = row(canvasElement, "stripe")
    stripe.getByRole("radio", { name: "Emulated" }).focus()
    await userEvent.keyboard("{ArrowRight}")
    await waitFor(() =>
      expect(stripe.getByRole("radio", { name: "Dev" })).toHaveAttribute("aria-checked", "true"),
    )
    await expect(stripe.getByRole("radio", { name: "Dev" })).toHaveFocus()
    await waitFor(() => expect(stripe.getByText("Dev resource")).toBeVisible())
    await waitFor(() =>
      expect(page.getByTestId("system-services-summary")).toHaveTextContent(
        "8 services · 7 emulated · 1 dev",
      ),
    )
    // The switch is optimistic; the row stays busy until the proxy answers.
    await waitFor(() =>
      expect(stripe.getByRole("radiogroup")).toHaveAttribute("aria-busy", "false"),
    )
    await userEvent.keyboard("{ArrowLeft}")
    await waitFor(() =>
      expect(stripe.getByRole("radio", { name: "Emulated" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    )
  },
}
const isHidden = (node: HTMLElement) =>
  node.closest("[hidden]") !== null || getComputedStyle(node).visibility === "hidden"

/**
 * Stripe (test mode) and Junction (its sandbox) already on dev resources; Twilio joins them with
 * a pending state. The proxy blocks Resend: its allow-list has no pattern for RESEND_API_KEY.
 */
export const MixedDev: StoryObj = {
  render: screen({
    state: "ready",
    dev: ["stripe", "junction"],
    blocked: { resend: "No allow-list pattern for RESEND_API_KEY" },
    delay: 600,
  }),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement)
    // One scroller: the System panel scrolls; the page around a full-height shell never does.
    await expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight)
    await expect(await summary(canvasElement)).toHaveTextContent("8 services · 6 emulated · 2 dev")
    await expect(row(canvasElement, "stripe").getByText("Dev resource")).toBeVisible()
    await expect(row(canvasElement, "junction").getByText("Dev resource")).toBeVisible()
    const access = within(canvasElement).getByTestId("system-dev-proxy")
    await expect(
      within(access).getByText(
        "Only credentials that match the proxy's non-production allow-list are used. They never reach this browser.",
      ),
    ).toBeVisible()
    // A service the proxy blocks shows the host's reason and cannot be switched.
    const resend = row(canvasElement, "resend")
    await expect(resend.getByText("No allow-list pattern for RESEND_API_KEY")).toBeVisible()
    await expect(resend.getByRole("radio", { name: "Dev" })).toBeDisabled()
    await expect(resend.getByRole("radio", { name: "Dev" })).toHaveAccessibleDescription(
      /No allow-list pattern for RESEND_API_KEY/,
    )
    const twilio = row(canvasElement, "twilio")
    const twilioRow = canvasElement.querySelector<HTMLElement>('[data-service="twilio"]')
    if (!twilioRow) throw new Error("no Twilio row")
    // Switching never moves anything: same height, label in the same place.
    const label = twilio.getByText("Twilio")
    const layout = () => [
      twilioRow.offsetHeight,
      label.getBoundingClientRect().top - twilioRow.getBoundingClientRect().top,
    ]
    const before = layout()
    // The control is a toggle: clicking the half that is already selected flips it too.
    await userEvent.click(twilio.getByRole("radio", { name: "Emulated" }))
    await expect(twilio.getByRole("status")).toHaveTextContent("Switching to the dev resource…")
    await expect(twilio.getByRole("radiogroup")).toHaveAttribute("aria-busy", "true")
    await expect(layout()).toEqual(before)
    await waitFor(() => expect(twilio.getByRole("status").textContent).toBe(""), {
      timeout: 3000,
    })
    await expect(twilio.getByText("Dev resource")).toBeVisible()
    await expect(twilioRow).toHaveAttribute("data-mode", "dev")
    await expect(layout()).toEqual(before)
    await userEvent.click(twilio.getByRole("radio", { name: "Dev" }))
    await waitFor(() => expect(twilioRow).toHaveAttribute("data-mode", "emulated"))
    await waitFor(() => expect(twilio.getByRole("status").textContent).toBe(""), {
      timeout: 3000,
    })
    await expect(layout()).toEqual(before)
    await userEvent.click(twilio.getByRole("radio", { name: "Dev" }))
    await waitFor(() => expect(twilioRow).toHaveAttribute("data-mode", "dev"))
    await waitFor(() => expect(twilio.getByRole("status").textContent).toBe(""), {
      timeout: 3000,
    })
  },
}

/** The proxy URL is set but nothing answers. */
export const Unreachable: StoryObj = {
  render: screen({ state: "unreachable" }),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement)
    const access = within(canvasElement).getByTestId("system-dev-proxy")
    await expect(access).toHaveAttribute("data-state", "unreachable")
    await expect(within(access).getByText("Unreachable")).toBeVisible()
    await expect(within(access).getByText(ENDPOINT)).toBeVisible()
    // The proxy's reason is said once above the list, not under every row.
    await expect(
      within(canvasElement).getByText(
        "Dev is unavailable for every service: The dev proxy did not answer.",
      ),
    ).toBeVisible()
    const slack = row(canvasElement, "slack")
    await expect(slack.getByText("The dev proxy did not answer")).not.toBeVisible()
    await expect(slack.getByRole("radio", { name: "Dev" })).toHaveAccessibleDescription(
      /The dev proxy did not answer/,
    )
    await expect(
      row(canvasElement, "postgres").getByText(
        "Runs in this browser; there is no remote dev instance to reach",
      ),
    ).toBeVisible()
  },
}

/** No proxy configured for this preview: everything is emulated. */
export const NoProxy: StoryObj = {
  render: screen({ state: "none" }),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement)
    const access = within(canvasElement).getByTestId("system-dev-proxy")
    await expect(access).toHaveAttribute("data-state", "none")
    await expect(within(access).getByText("Not set up")).toBeVisible()
    await expect(within(access).getByText("Proxy")).not.toBeVisible()
  },
}

/** The proxy rejects Twilio: the row reverts to Emulated and says why. */
export const SwitchFails: StoryObj = {
  render: screen({
    state: "ready",
    failing: { twilio: "Missing TWILIO_AUTH_TOKEN on the proxy" },
  }),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement)
    const twilio = row(canvasElement, "twilio")
    await userEvent.click(twilio.getByRole("radio", { name: "Dev" }))
    await expect(await twilio.findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent(
      "Couldn't switch Twilio to dev: Missing TWILIO_AUTH_TOKEN on the proxy",
    )
    await expect(twilio.getByRole("radio", { name: "Emulated" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await expect(within(canvasElement).getByTestId("system-services-summary")).toHaveTextContent(
      "8 services · 8 emulated · 0 dev",
    )
  },
}

/** A host app that passes no services gets an explanation instead of a list. */
export const NoServices: StoryObj = {
  render: screen(undefined, { docs: false }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await expect(page.getByText("No services listed")).toBeVisible()
    await expect(page.getByText(/The host app supplies them/)).toBeVisible()
    await expect(page.queryByTestId("system-dev-proxy")).toBeNull()
    await expect(page.queryByRole("link", { name: /How dev resources work/ })).toBeNull()
  },
}

/** Switching Emulators off: the arrows skip it, its card still opens it, and it is remembered. */
export const Rotation: StoryObj = {
  render: screen({ state: "ready" }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const toggle = await page.findByRole("switch", { name: "Emulators in switcher" })
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await expect(page.queryByRole("switch", { name: /System/ })).toBeNull()
    await userEvent.click(page.getByRole("button", { name: "Open Lab workspace" }))
    await expect(page.getByRole("button", { name: "Next app" })).toHaveAttribute(
      "aria-description",
      "Next: Emulators",
    )
    await userEvent.click(page.getByRole("button", { name: "Previous app" }))

    // Keyboard: Space flips the switch.
    toggle.focus()
    await userEvent.keyboard(" ")
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await expect(JSON.parse(localStorage.getItem(ROTATION_KEY) ?? "[]")).toEqual(["emulators"])
    await expect(page.getByText(/3 apps · 2 in the switcher/)).toBeVisible()

    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    await expect(
      canvasElement.querySelector("section[data-surface]:not([hidden])"),
    ).toHaveAttribute("data-surface", "app")
    await expect(page.getByRole("button", { name: "Next app" })).toHaveAttribute(
      "aria-description",
      "Next: Notifications",
    )
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    await expect(
      canvasElement.querySelector("section[data-surface]:not([hidden])"),
    ).toHaveAttribute("data-surface", "notifications")
    await userEvent.click(page.getByRole("button", { name: "Previous app" }))
    await userEvent.click(page.getByRole("button", { name: "Previous app" }))
    // The card still opens an app left out of the switcher.
    await userEvent.click(page.getByRole("button", { name: "Open Emulators" }))
    await expect(
      canvasElement.querySelector("section[data-surface]:not([hidden])"),
    ).toHaveAttribute("data-surface", "emulators")

    // A fresh mount reads the same rotation.
    const host = document.createElement("div")
    host.style.cssText = "position:fixed;inset:0"
    canvasElement.append(host)
    const again = mountSystemHarness(
      host,
      SURFACES.map((surface) => ({ ...surface, mount: () => () => {} })),
    )
    try {
      const fresh = within(host)
      await expect(
        await fresh.findByRole("switch", { name: "Emulators in switcher" }),
      ).toHaveAttribute("aria-checked", "false")
      await userEvent.click(fresh.getByRole("button", { name: "Open Lab workspace" }))
      await expect(fresh.getByRole("button", { name: "Next app" })).toHaveAttribute(
        "aria-description",
        "Next: Notifications",
      )
      await again.show("emulators")
      await expect(again.active()).toBe("emulators")
    } finally {
      again.destroy()
      host.remove()
      localStorage.removeItem(ROTATION_KEY)
    }
  },
}

const visible = (root: HTMLElement) =>
  root.querySelector("section[data-surface]:not([hidden])")?.getAttribute("data-surface")
const rows = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("ol.msh-apps > li")].map((row) => row.dataset.app)

/**
 * The switcher's order: drag a row by its grip, or move it with the keyboard. The arrows follow
 * the list, and a fresh mount reads the same order back. Each row shows its app's icon.
 */
export const Reorder: StoryObj = {
  render: screen({ state: "ready" }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await expect(await page.findByRole("list", { name: "Switcher order" })).toBeVisible()
    await expect(rows(canvasElement)).toEqual(["system", "app", "emulators", "notifications"])

    // Icons: Mockingbird's own as SVG; the app's as an image.
    const mark = (id: string) =>
      canvasElement.querySelector<HTMLElement>(`li[data-app="${id}"] .msh-mark`)
    await expect(mark("emulators")?.dataset.icon).toBe("svg")
    await expect(mark("system")?.dataset.icon).toBe("svg")
    await expect(mark("app")?.dataset.icon).toBe("image")
    await waitFor(() =>
      expect(mark("app")?.querySelector("img")?.naturalWidth ?? 0).toBeGreaterThan(0),
    )

    // Keyboard: Home moves Notifications to the top.
    page.getByRole("button", { name: "Reorder Notifications" }).focus()
    await userEvent.keyboard("{Home}")
    await expect(rows(canvasElement)).toEqual(["notifications", "system", "app", "emulators"])
    await expect(page.getByRole("status")).toHaveTextContent(
      "Notifications moved to position 1 of 4.",
    )
    await expect(page.getByRole("button", { name: "Reorder Notifications" })).toHaveFocus()
    await userEvent.keyboard("{ArrowDown}")
    await expect(rows(canvasElement)).toEqual(["system", "notifications", "app", "emulators"])

    // Pointer: drag Emulators' grip up past two rows.
    const grip = page.getByRole("button", { name: "Reorder Emulators" })
    const target = canvasElement.querySelector<HTMLElement>('li[data-app="notifications"]')
    if (!target) throw new Error("no Notifications row")
    const from = grip.getBoundingClientRect()
    const startY = from.top + from.height / 2
    const endY = target.getBoundingClientRect().top + 4
    const pointer = (type: string, y: number) =>
      grip.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          pointerId: 7,
          pointerType: "mouse",
          clientX: from.left + 4,
          clientY: y,
        }),
      )
    // The dragged row's own node must never move: moving it would release the real pointer
    // capture mid-drag (dragging up used to drop the row one slot early).
    const dragged = canvasElement.querySelector('li[data-app="emulators"]')
    let movedDragged = false
    const watch = new MutationObserver((records) => {
      for (const record of records)
        if ([...record.removedNodes].includes(dragged as Node)) movedDragged = true
    })
    watch.observe(dragged?.parentElement as Node, { childList: true })
    pointer("pointerdown", startY)
    for (let step = 1; step <= 8; step++)
      pointer("pointermove", startY + ((endY - startY) * step) / 8)
    await Promise.resolve()
    watch.disconnect()
    await expect(movedDragged).toBe(false)
    pointer("pointerup", endY)
    await expect(rows(canvasElement)).toEqual(["system", "emulators", "notifications", "app"])
    await expect(JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")).toEqual([
      "system",
      "emulators",
      "notifications",
      "app",
    ])

    // The arrows follow the new order.
    await expect(page.getByRole("button", { name: "Next app" })).toHaveAttribute(
      "aria-description",
      "Next: Emulators",
    )
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    await expect(visible(canvasElement)).toBe("emulators")
    await userEvent.click(page.getByRole("button", { name: "Next app" }))
    await expect(visible(canvasElement)).toBe("notifications")

    // Toggling is one click anywhere on the row.
    await userEvent.click(page.getByRole("button", { name: "Previous app" }))
    await userEvent.click(page.getByRole("button", { name: "Previous app" }))
    await userEvent.click(page.getByText("The admin UI of every emulator", { exact: false }))
    await expect(page.getByRole("switch", { name: "Emulators in switcher" })).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await expect(JSON.parse(localStorage.getItem(ROTATION_KEY) ?? "[]")).toEqual(["emulators"])

    // A fresh mount reads the same order and rotation.
    const host = document.createElement("div")
    host.style.cssText = "position:fixed;inset:0"
    canvasElement.append(host)
    const again = mountSystemHarness(
      host,
      SURFACES.map((surface) => ({ ...surface, mount: () => () => {} })),
    )
    try {
      await within(host).findByRole("list", { name: "Switcher order" })
      await expect(rows(host)).toEqual(["system", "emulators", "notifications", "app"])
      await expect(
        within(host).getByRole("switch", { name: "Emulators in switcher" }),
      ).toHaveAttribute("aria-checked", "false")
      await expect(within(host).getByRole("button", { name: "Next app" })).toHaveAttribute(
        "aria-description",
        "Next: Notifications",
      )
    } finally {
      again.destroy()
      host.remove()
      localStorage.removeItem(ORDER_KEY)
      localStorage.removeItem(ROTATION_KEY)
    }
  },
}

/** On a phone: cards stack, the segmented control spans the row, and nothing scrolls sideways. */
export const Phone: StoryObj = {
  render: screen({ state: "ready", dev: ["stripe"] }),
  globals: { viewport: { value: "phone" } },
  play: async ({ canvasElement }) => {
    await loaded(canvasElement)
    const panel = canvasElement.querySelector<HTMLElement>('section[data-surface="system"]')
    if (!panel) throw new Error("No System panel")
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth)
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    )
    await expect(row(canvasElement, "stripe").getByText("Dev resource")).toBeVisible()
  },
}
