import type { Meta, StoryObj } from "@storybook/html-vite"
import { api } from "../../../../../packages/examples/medical-testing/src/client/api.js"
import { CLINICIAN, cove, NEWCOMER, PATIENT, paidOrder, phone, SHELL } from "./cove.js"

/**
 * The signed-in overview (`Dashboard`): the sidebar and top bar every signed-in screen shares,
 * order counts, recent activity, and the next step, for a patient and for care staff.
 */
export default {
  title: "Examples/Medical testing/Overview",
  parameters: {
    layout: "fullscreen",
    sources: [...SHELL, "packages/examples/medical-testing/src/client/pages/Dashboard.ts"],
  },
} satisfies Meta

/** A patient with two reports, one not yet reviewed: "New results are available". */
export const Patient: StoryObj = cove({ as: PATIENT })

/** A patient with an order on its way to the lab: "An order is in progress". */
export const OrderInProgress: StoryObj = cove({
  as: NEWCOMER,
  prepare: async () => {
    await paidOrder("Thyroid Panel")
  },
})

/** A first sign-in: no orders yet. */
export const NoOrdersYet: StoryObj = cove({ as: NEWCOMER })

/** Result highlights turned off in Account: "Quick access" instead of "Next steps". */
export const HighlightsOff: StoryObj = cove({
  as: PATIENT,
  prepare: async () => {
    await api.profile("Ada Lovelace", false)
  },
})

/** A clinician: every patient's orders, and the reports waiting for review. */
export const Clinician: StoryObj = cove({ as: CLINICIAN })

export const OnAPhone: StoryObj = cove({ as: PATIENT }, { globals: phone })
