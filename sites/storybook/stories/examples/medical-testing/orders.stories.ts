import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import {
  CLINICIAN,
  cove,
  NEWCOMER,
  PATIENT,
  type Person,
  paidOrder,
  person,
  phone,
  placeOrder,
  type Setup,
  SHELL,
} from "./cove.js"

/**
 * Orders and Results: the list with its search, status filter and sort, and one order's detail
 * (progress, results and clinical review, timeline, files). The demo patient has two reports,
 * one reviewed; clinicians see every patient's orders and record reviews.
 */
export default {
  title: "Examples/Medical testing/Orders",
  parameters: {
    layout: "fullscreen",
    sources: [
      ...SHELL,
      "packages/examples/medical-testing/src/client/pages/Orders.ts",
      "packages/examples/medical-testing/src/client/components/Tabs.ts",
    ],
  },
} satisfies Meta

const orders = (
  setup: Setup,
  play?: (page: Person) => Promise<void>,
  extra: Parameters<typeof cove>[1] = {},
): StoryObj => ({
  ...cove({ route: "orders", ...setup }, extra),
  play: async ({ canvasElement }) => {
    const page = person(canvasElement)
    await page.find(".cove-order-list, .cove-empty")
    await play?.(page)
  },
})

/** Open the order whose card mentions `text`. */
const openOrder = (text: string) => async (page: Person) => {
  await page.click(".cove-order-card", text)
  await page.find(".cove-progress")
}

/** A patient's orders, newest first. */
export const PatientOrders: StoryObj = orders({ as: PATIENT })

/** Every status at once: awaiting payment, at the lab, and reports. */
export const EveryStatus: StoryObj = orders({
  as: PATIENT,
  prepare: async () => {
    await placeOrder("HbA1c")
    await paidOrder("Thyroid Panel")
  },
})

/** Results: only the orders with a report. */
export const Results: StoryObj = orders({ as: PATIENT, route: "results" })

/** A search that matches nothing. */
export const NoMatchingOrders: StoryObj = orders({ as: PATIENT }, async (page) => {
  await page.type('.cove-toolbar input[type="search"]', "zinc")
  await page.find(".cove-empty", "No matching orders")
})

/** A first sign-in: nothing ordered yet. */
export const NoOrdersYet: StoryObj = orders({ as: NEWCOMER })

/** A report: biomarkers against their ranges and the prior sample, with the clinician's review. */
export const Report: StoryObj = orders({ as: PATIENT }, async (page) => {
  await page.click(".cove-order-card:last-child")
  await page.find(".cove-results-table")
})

/** A report still waiting for its review. */
export const ReportAwaitingReview: StoryObj = orders({ as: PATIENT }, async (page) => {
  await page.click(".cove-order-card:first-child")
  await page.find(".cove-results-table")
})

/** An unpaid order: its tests are saved, and checkout can be resumed. */
export const AwaitingPayment: StoryObj = orders(
  {
    as: PATIENT,
    prepare: async () => {
      await placeOrder("HbA1c", "Complete Blood Count")
    },
  },
  openOrder("HbA1c"),
)

/** A paid order at the lab: the report is in progress. */
export const AtTheLab: StoryObj = orders(
  {
    as: PATIENT,
    prepare: async () => {
      await paidOrder("Thyroid Panel")
    },
  },
  openOrder("Thyroid Panel"),
)

/** The timeline tab: every step from payment to review. */
export const Timeline: StoryObj = orders({ as: PATIENT }, async (page) => {
  await page.click(".cove-order-card:last-child")
  await page.click("#order-tab-timeline")
  await page.find(".cove-event-list")
})

/** The files tab: the results spreadsheet, receipt and order record, and the order summary. */
export const Files: StoryObj = orders({ as: PATIENT }, async (page) => {
  await page.click(".cove-order-card:last-child")
  await page.click("#order-tab-files")
  await page.find(".cove-file-row")
})

/** A file downloaded: the confirmation. */
export const Downloaded: StoryObj = orders({ as: PATIENT }, async (page) => {
  await page.click(".cove-order-card:last-child")
  await page.click("#order-tab-files")
  await page.click(".cove-file-row button", "Download")
  await page.find('.cove-alert-success[role="status"]', "Your file is ready.")
})

/** A clinician: every patient's orders. */
export const AllPatients: StoryObj = orders({ as: CLINICIAN })

/** A clinician on a report awaiting review: the review form. */
export const ReviewForm: StoryObj = orders({ as: CLINICIAN }, async (page) => {
  await page.click(".cove-order-card:first-child")
  await page.find("textarea.cove-input")
})

/** The review written and saved: it joins the report and the timeline. */
export const ReviewSaved: StoryObj = orders({ as: CLINICIAN }, async (page) => {
  await page.click(".cove-order-card:first-child")
  await page.type("textarea.cove-input", "Values reviewed. Repeat the lipid panel in three months.")
  await page.click("form button.cove-btn-primary", "Complete review")
  expect(
    (await page.find('.cove-alert-success[role="status"]', "Review saved")).textContent,
  ).toContain("timeline")
})

export const OnAPhone: StoryObj = orders({ as: PATIENT }, undefined, { globals: phone })

/** A report on a phone: the results table scrolls on its own. */
export const ReportOnAPhone: StoryObj = { ...Report, globals: phone }
