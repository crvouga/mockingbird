import { createRuntime as plane } from "@crvouga/mockingbird-service-plane"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { admin, choose, SHELL_SOURCES, shows } from "./admin.js"
import { fresh, store } from "./store.js"

/**
 * Every screen of the admin shell (the `#hash` it keeps the screen in), on a Stripe emulator in
 * use: the controls put in place through the admin API first, so each screen shows them.
 */
export default {
  title: "Admin/Admin UI/Screens",
  parameters: {
    layout: "fullscreen",
    sources: [
      ...SHELL_SOURCES,
      "packages/admin-ui/src/manual.tsx",
      "packages/admin-ui/src/manual-model.ts",
      "packages/admin-ui/src/state.tsx",
      "packages/admin-ui/src/resource.ts",
      "packages/admin-ui/src/download.ts",
    ],
  },
} satisfies Meta

const screen = (view: string, ready: string, prepare?: Parameters<typeof store>[0]) =>
  admin(store(prepare), { view, ready })

/** Arm a delay, a timeout or a 503 for the next matching request, and watch its attempts. */
export const ManualControls: StoryObj = screen("manual", "Armed rules")

/** A delay armed for `POST /v1/charges` from the form. */
export const ManualDelayArmed: StoryObj = screen("manual", "Armed rules")
ManualDelayArmed.play = async ({ canvasElement }) => {
  await shows(canvasElement, "Armed rules")
  const page = within(canvasElement)
  await userEvent.type(page.getByLabelText("Manual request path"), "/v1/charges")
  await userEvent.click(page.getByRole("button", { name: "Delay next request" }))
  await shows(canvasElement, "Armed delay for the next 1 matching request(s)")
}

/** A path without its leading slash is refused before anything is armed. */
export const ManualInvalidPath: StoryObj = screen("manual", "Armed rules")
ManualInvalidPath.play = async ({ canvasElement }) => {
  await shows(canvasElement, "Armed rules")
  const page = within(canvasElement)
  await userEvent.type(page.getByLabelText("Manual request path"), "v1/charges")
  await userEvent.click(page.getByRole("button", { name: "Fail next request (503)" }))
  await shows(canvasElement, "Request path must start with /")
}

/** Collections and their records; the first one with records is open. */
export const State: StoryObj = screen("state", "New record")

/** Another collection chosen from the picker. */
export const StateCollection: StoryObj = screen("state", "New record")
StateCollection.play = async ({ canvasElement }) => {
  await shows(canvasElement, "New record")
  await choose(canvasElement, "Collection", "customers", /^Customers acct \w+ \(\d+\)$/)
  await shows(canvasElement, "alice@gmail.com")
}

/** A record opened in the editor. */
export const StateRecordEditor: StoryObj = screen("state", "New record")
StateRecordEditor.play = async ({ canvasElement }) => {
  await shows(canvasElement, "New record")
  const [edit] = await within(canvasElement).findAllByRole("button", { name: /^Edit / })
  if (!edit) throw new Error("No record to edit")
  await userEvent.click(edit)
  await shows(canvasElement, "Edit record")
}

/** The editor for a new record. */
export const StateNewRecord: StoryObj = screen("state", "New record")
StateNewRecord.play = async ({ canvasElement }) => {
  await shows(canvasElement, "New record")
  await userEvent.click(within(canvasElement).getByRole("button", { name: /New record/ }))
  await shows(canvasElement, "New record")
}

/** State on an emulator with nothing stored yet. */
export const StateEmpty: StoryObj = admin(fresh, { view: "state", ready: "State" })

export const Clock: StoryObj = screen("clock", "Current time")

/** Frozen at a set instant. */
export const ClockFrozen: StoryObj = screen("clock", "2026-01-01T09:00:00.000Z", ({ admin }) =>
  admin("POST", "/clock", { now: "2026-01-01T09:00:00Z", frozen: true }),
)

export const Latency: StoryObj = screen("latency", "Baseline")

/** A baseline with jitter and a slower operation. */
export const LatencyWithOverrides: StoryObj = screen("latency", "PostCharges", ({ admin }) =>
  admin("PUT", "/latency", {
    delay: "40ms",
    jitter: "10ms",
    operations: { PostCharges: { delay: "250ms" } },
  }),
)

/** No rules yet: the form and this emulator's presets. */
export const Faults: StoryObj = screen("faults", "card_declined")

/** A custom rule and a preset switched on. */
export const FaultsActive: StoryObj = screen("faults", "fault_1", async ({ admin }) => {
  await admin("POST", "/faults", { operationId: "PostCharges", status: 402, count: 3 })
  await admin("POST", "/faults", { preset: "card_declined" })
})

export const Snapshots: StoryObj = screen("snapshots", "Saved snapshots")

/** Two saved snapshots, ready to restore or download. */
export const SnapshotsSaved: StoryObj = screen("snapshots", "before-upgrade", async ({ admin }) => {
  await admin("POST", "/snapshots", { name: "baseline" })
  await admin("POST", "/snapshots", { name: "before-upgrade" })
})

/** Every request the emulator answered, grouped into attempts. */
export const Journal: StoryObj = screen("journal", "PostSubscriptions")

export const JournalEmpty: StoryObj = admin(fresh, { view: "journal", ready: "Request attempts" })

/** Branches and the checkpoints successful writes saved. */
export const Checkpoints: StoryObj = screen("checkpoints", "cp_00000002", async ({ admin }) => {
  await admin("POST", "/checkpoints", {})
  await admin("POST", "/branches/experiment", {})
})

/** The admin request runner, over every admin route. */
export const Routes: StoryObj = screen("routes", "Admin request runner")

/** `GET /health` run from the runner: the emulator's answer below. */
export const RouteRun: StoryObj = screen("routes", "Admin request runner")
RouteRun.play = async ({ canvasElement }) => {
  await shows(canvasElement, "Admin request runner")
  const page = within(canvasElement)
  await choose(canvasElement, "Admin route", "health", "GET /health")
  await userEvent.click(page.getByRole("button", { name: "Send request" }))
  const answer = await page.findByLabelText<HTMLTextAreaElement>("JSON data")
  await waitFor(() => expect(answer.value).toContain('"status"'))
}

/**
 * A `route` extension (Plane's "Move a work item"): an admin action with a prefilled body, in
 * the navigation beside the built-in screens.
 */
export const RouteExtension: StoryObj = admin(
  () => ({ emulator: plane(), origin: "https://plane.mock" }),
  {
    view: "move-work-item",
    ready: "Move a work item",
  },
)
RouteExtension.play = async ({ canvasElement }) => {
  await shows(canvasElement, "resolves a state by id or by name")
  await expect(within(canvasElement).getAllByText("Move a work item").length).toBeGreaterThan(0)
}
