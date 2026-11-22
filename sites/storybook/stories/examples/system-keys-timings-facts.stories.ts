import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  mountSystemHarness,
  type SystemBackends,
  type SystemFactGroup,
  type SystemFactsSection,
  type SystemHarnessOptions,
  type SystemService,
  type SystemServiceField,
  type SystemServiceMode,
  type SystemServices,
} from "../../../../packages/ui/src/system-harness.js"
import { SYSTEM_ICONS } from "../../../../packages/ui/src/system-icons.js"
import { ORDER_KEY, ROTATION_KEY } from "../../../../packages/ui/src/system-rotation.js"

/**
 * Three optional additions to the System screen (#903): a service that takes the developer's own
 * key typed here (for a preview with no dev proxy), each backend's start-up time with a start-up
 * timeline, and a read-only facts section (feature flags) with a filter.
 */
export default {
  title: "Examples/System harness/Keys, timings and facts",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/ui/src/system-screen.tsx",
      "packages/ui/src/system-credentials.tsx",
      "packages/ui/src/system-facts-section.tsx",
      "packages/ui/src/system-facts.ts",
      "packages/ui/src/system-timeline.ts",
      "packages/ui/src/system-services-store.ts",
      "packages/ui/src/system-types.ts",
    ],
  },
} satisfies Meta

const SURFACES = [
  { id: "app", label: "Lab workspace", icon: SYSTEM_ICONS.emulators },
  { id: "notifications", label: "Notifications", icon: SYSTEM_ICONS.notifications },
]

let stop: (() => void) | undefined
const screen = (options: SystemHarnessOptions) => () => {
  stop?.()
  localStorage.removeItem(ROTATION_KEY)
  localStorage.removeItem(ORDER_KEY)
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
    options,
  )
  stop = () => harness.destroy()
  return host
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- Services: a key typed in the browser.

const STRIPE_FIELDS: readonly SystemServiceField[] = [
  { name: "secretKey", label: "Secret key", secret: true, placeholder: "sk_test_…" },
  {
    name: "account",
    label: "Account",
    options: [
      { value: "test", label: "Test mode" },
      { value: "sandbox", label: "Sandbox" },
    ],
  },
]
const NO_PROXY = "No dev proxy is configured for this preview"

/**
 * No dev proxy, so every service is unavailable, except Stripe: it takes a key, kept in memory by
 * this fake host (never by the screen).
 */
function keyedServices({
  dev = false,
  configured = false,
  refuse,
}: {
  dev?: boolean
  configured?: boolean
  /** setCredentials rejects with this message. */
  refuse?: string
} = {}) {
  let saved: Record<string, string> | undefined = configured
    ? { secretKey: "sk_test_saved", account: "test" }
    : undefined
  const modes = new Map<string, SystemServiceMode>([
    ["stripe", dev ? "dev" : "emulated"],
    ["resend", "emulated"],
    ["twilio", "emulated"],
  ])
  const calls: string[] = []
  const services: SystemServices = {
    async list() {
      await wait(60)
      return {
        dev: { state: "none", message: `${NO_PROXY}.` },
        services: [
          {
            id: "stripe",
            label: "Stripe",
            category: "Payments",
            mode: modes.get("stripe") ?? "emulated",
            unavailable: NO_PROXY,
            fields: STRIPE_FIELDS,
            configured: saved !== undefined,
          },
          ...(["resend", "twilio"] as const).map(
            (id): SystemService => ({
              id,
              label: id === "resend" ? "Resend" : "Twilio",
              category: id === "resend" ? "Email" : "SMS",
              mode: modes.get(id) ?? "emulated",
              unavailable: NO_PROXY,
            }),
          ),
        ],
      }
    },
    async setMode(id, mode) {
      await wait(60)
      if (id !== "stripe" && mode === "dev") throw new Error(NO_PROXY)
      modes.set(id, mode)
    },
    async test(id) {
      await wait(150)
      if (id !== "stripe" || !saved) return { ok: false, message: "Save a key first." }
      return { ok: true, message: `Stripe answered with the ${saved.account} account.` }
    },
    async setCredentials(id, values) {
      await wait(150)
      calls.push(`set ${id} ${Object.keys(values).join(",")}`)
      if (refuse) throw new Error(refuse)
      saved = { ...values }
    },
    async clearCredentials(id) {
      await wait(60)
      calls.push(`clear ${id ?? "all"}`)
      saved = undefined
    },
  }
  return { services, calls, saved: () => saved }
}

const row = (canvas: HTMLElement, id: string) => {
  const found = canvas.querySelector<HTMLElement>(`[data-service="${id}"]`)
  if (!found) throw new Error(`No row for ${id}`)
  return within(found)
}
const loaded = (canvas: HTMLElement) =>
  waitFor(() => expect(canvas.querySelector('[data-service="stripe"]')).not.toBeNull(), {
    timeout: 3000,
  })

let keyed = keyedServices()

/**
 * No proxy: Resend and Twilio cannot use Dev, but Stripe can. Dev shows its inputs (a password
 * input and a select, with Test beside Save); Save hands the values to the host and the row says
 * Key saved; Forget clears them.
 */
export const KeyTypedInTheBrowser: StoryObj = {
  render: () => {
    keyed = keyedServices()
    return screen({ services: keyed.services, initial: "system" })()
  },
  play: async ({ canvasElement }) => {
    await loaded(canvasElement)
    const page = within(canvasElement)
    await expect(row(canvasElement, "resend").getByRole("radio", { name: "Dev" })).toBeDisabled()
    await expect(
      await page.findByText(/A service that takes your own key can still use Dev/),
    ).toBeVisible()
    const stripe = row(canvasElement, "stripe")
    await expect(stripe.getByRole("radio", { name: "Dev" })).toBeEnabled()
    // Emulated: no inputs, and the reason for the others is not repeated under it.
    await expect(stripe.queryByTestId("system-service-credentials")).toBeNull()
    await userEvent.click(stripe.getByRole("radio", { name: "Dev" }))
    const form = await stripe.findByTestId("system-service-credentials")
    await expect(within(form).getByText("Not saved yet")).toBeVisible()
    const key = within(form).getByLabelText("Secret key")
    await expect(key).toHaveAttribute("type", "password")
    await expect(within(form).getByLabelText("Account").tagName).toBe("SELECT")
    // Test sits beside Save while the inputs show.
    await expect(within(form).getByTestId("system-service-test")).toBeVisible()
    const save = within(form).getByTestId("system-service-credentials-save")
    await expect(save).toBeDisabled()
    await userEvent.type(key, "sk_test_51storybook")
    await userEvent.selectOptions(within(form).getByLabelText("Account"), "sandbox")
    await userEvent.click(save)
    await waitFor(() =>
      expect(keyed.saved()).toEqual({ secretKey: "sk_test_51storybook", account: "sandbox" }),
    )
    await expect(await stripe.findByTestId("system-service-configured")).toHaveTextContent(
      "Key saved",
    )
    // The typed secret leaves the screen once saved.
    await expect(within(form).getByLabelText("Secret key")).toHaveValue("")
    await userEvent.click(within(form).getByTestId("system-service-test"))
    await waitFor(() =>
      expect(stripe.getByTestId("system-service-test-result")).toHaveTextContent(
        "Test passed: Stripe answered with the sandbox account.",
      ),
    )
    await userEvent.click(within(form).getByTestId("system-service-credentials-clear"))
    await waitFor(() => expect(within(form).getByText("Not saved yet")).toBeVisible())
    await expect(keyed.calls).toEqual(["set stripe secretKey,account", "clear stripe"])
  },
}

/** Stripe on Dev with a key the host already holds: "Key saved", Replace and Forget. */
export const KeySaved: StoryObj = {
  render: () => screen({ services: keyedServices({ dev: true, configured: true }).services })(),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement)
    const form = await row(canvasElement, "stripe").findByTestId("system-service-credentials")
    await expect(within(form).getByText("Key saved")).toBeVisible()
    await expect(within(form).getByRole("button", { name: "Replace key" })).toBeVisible()
    await expect(within(form).getByLabelText("Secret key")).toHaveAttribute(
      "placeholder",
      "Saved · type to replace",
    )
  },
}

/** The host refuses the key (a live key): its message shows under the inputs. */
export const KeyRefused: StoryObj = {
  render: () =>
    screen({
      services: keyedServices({
        dev: true,
        refuse: "That is a live key. Use a test-mode or sandbox key.",
      }).services,
    })(),
  play: async ({ canvasElement }) => {
    await loaded(canvasElement)
    const form = await row(canvasElement, "stripe").findByTestId("system-service-credentials")
    await userEvent.type(within(form).getByLabelText("Secret key"), "sk_live_123")
    await userEvent.click(within(form).getByTestId("system-service-credentials-save"))
    await expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Couldn't save the Stripe key: That is a live key.",
    )
  },
}

// ---- Backends: start-up times and the timeline.

const BACKENDS: SystemBackends = {
  list: () => [
    { id: "api", label: "Lab API", kind: "backend", state: "ready", startedInMs: 412 },
    { id: "worker", label: "Results worker", kind: "backend", state: "ready", startedInMs: 1630 },
    { id: "stripe", label: "Stripe", kind: "emulator", state: "ready" },
    { id: "junction", label: "Junction", kind: "emulator", state: "not started" },
  ],
  timeline: async () => {
    await wait(50)
    return [
      { label: "fetched", atMs: 180 },
      { label: "unpacked", atMs: 240 },
      { label: "evaluated", atMs: 390 },
      { label: "database", atMs: 820 },
      { label: "emulators", atMs: 1010 },
      { label: "first server", atMs: 1240 },
      { label: "second server", atMs: 1870 },
    ]
  },
}

/** Each backend's start-up time on its card, and the steps of start-up under the list. */
export const StartUpTimings: StoryObj = {
  render: screen({ backends: BACKENDS, initial: "system" }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await expect(
      await page.findByTestId("system-backend-started-api", {}, { timeout: 3000 }),
    ).toHaveTextContent("Started in 412 ms")
    await expect(page.getByTestId("system-backend-started-worker")).toHaveTextContent(
      "Started in 1.6 s",
    )
    // An emulator with no time says nothing about it.
    await expect(page.queryByTestId("system-backend-started-stripe")).toBeNull()
    const timeline = await page.findByTestId("system-backends-timeline")
    await expect(timeline).toHaveTextContent("Ready in 1.9 s")
    await expect(timeline.querySelectorAll("[data-step]")).toHaveLength(7)
    await expect(timeline.querySelector('[data-step="database"]')).toHaveTextContent("+430 ms")
  },
}

/** A host with backends but no timings: the list as before, no timeline. */
export const BackendsWithoutTimings: StoryObj = {
  render: screen({ backends: { list: () => [{ id: "api", label: "Lab API", state: "ready" }] } }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await expect(await page.findByText("Lab API", {}, { timeout: 3000 })).toBeVisible()
    await expect(page.queryByTestId("system-backends-timeline")).toBeNull()
    await expect(page.queryByTestId("system-backend-started-api")).toBeNull()
  },
}

// ---- A facts section.

const FLAGS: readonly SystemFactGroup[] = [
  {
    group: "Lab workspace",
    rows: [
      { label: "new-results-view", value: "on", tone: "on" },
      { label: "clinician-notes", value: "on", tone: "on" },
      {
        label: "sms-reminders",
        value: "off",
        tone: "off",
        note: "Kept off until the carrier approves the sender",
      },
      { label: "results-page-size", value: "25" },
    ],
  },
  {
    group: "Notifications",
    rows: [
      { label: "digest", value: "weekly" },
      { label: "push-badges", value: "n/a", tone: "muted", note: "No push in this preview" },
    ],
  },
]
const facts = (load: SystemFactsSection["load"]): SystemFactsSection => ({
  id: "flags",
  label: "Flags",
  icon: SYSTEM_ICONS.system,
  load,
})

/** Feature flags grouped by app, with a filter; a query that matches nothing says so. */
export const FeatureFlags: StoryObj = {
  render: screen({ initial: "system", sections: [facts(async () => FLAGS)] }),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    const nav = await page.findByRole("navigation", { name: "System sections" }, { timeout: 3000 })
    await expect(within(nav).getByRole("link", { name: "Flags" })).toBeVisible()
    const count = await page.findByTestId("system-facts-count")
    await expect(count).toHaveTextContent("6 rows in 2 groups")
    await expect(page.getByText("Kept off until the carrier approves the sender")).toBeVisible()
    const filter = page.getByRole("searchbox", { name: "Filter Flags" })
    await userEvent.type(filter, "carrier")
    await waitFor(() => expect(count).toHaveTextContent("1 of 6 rows match"))
    await expect(canvasElement.querySelectorAll("[data-fact]")).toHaveLength(1)
    await userEvent.clear(filter)
    await userEvent.type(filter, "notifications")
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-fact]")).toHaveLength(2))
    await userEvent.clear(filter)
    await userEvent.type(filter, "nothing-like-this")
    await expect(await page.findByTestId("system-facts-empty")).toHaveTextContent(
      "Nothing matches “nothing-like-this”.",
    )
  },
}

/** The section while `load()` is on its way. */
export const FeatureFlagsLoading: StoryObj = {
  render: screen({ initial: "system", sections: [facts(() => new Promise(() => {}))] }),
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("Loading Flags…", {}, { timeout: 3000 }),
    ).toBeVisible()
  },
}

let attempts = 0
/** `load()` rejects: the error with Retry, in that section only; Retry loads again. */
export const FeatureFlagsFailed: StoryObj = {
  render: () => {
    attempts = 0
    return screen({
      initial: "system",
      sections: [
        facts(async () => {
          attempts++
          if (attempts === 1) throw new Error("The flags service did not answer.")
          return FLAGS
        }),
      ],
    })()
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement)
    await expect(await page.findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent(
      "Couldn't load Flags",
    )
    await userEvent.click(page.getByRole("button", { name: "Retry" }))
    await expect(await page.findByTestId("system-facts-count")).toHaveTextContent("6 rows")
  },
}

/** Every addition at once, on a phone. */
export const OnAPhone: StoryObj = {
  render: () =>
    screen({
      initial: "system",
      services: keyedServices({ dev: true, configured: true }).services,
      backends: BACKENDS,
      sections: [facts(async () => FLAGS)],
    })(),
  globals: { viewport: { value: "phone" } },
}
