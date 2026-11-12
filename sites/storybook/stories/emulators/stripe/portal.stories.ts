import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { hands } from "../../../src/interact.js"
import { page } from "../../../src/story.js"
import { stripe } from "./stripe.js"

/**
 * The hosted customer portal (`/p/session/{session}`) served in place of billing.stripe.com, on a
 * customer with a live subscription. Each flow a portal session can deep-link to has a story;
 * every form posts back to the emulator.
 */
export default {
  title: "Emulators/Stripe/Customer portal",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/service/stripe/src/portal-page.ts",
      "packages/service/stripe/src/browser.ts",
      "packages/service/stripe/src/card-input.ts",
    ],
  },
} satisfies Meta

type Opened = { s: ReturnType<typeof stripe>; customer: string; subscription: string }

/** A customer on the Starter plan (Pro is offered as an upgrade), and their portal. */
async function subscribed(): Promise<Opened> {
  const s = stripe()
  const starter = await s.plan("Starter", 900)
  await s.plan("Pro", 2900)
  const { customer, subscription } = await s.subscriber(starter.id)
  return { s, customer: customer.id, subscription: subscription.id }
}

const portal = (
  flow: (opened: Opened) => Record<string, unknown> | undefined = () => undefined,
  query: (opened: Opened) => string = () => "",
) =>
  page(async () => {
    const opened = await subscribed()
    const params = flow(opened)
    const session = await opened.s.portal(opened.customer, params ? { flow_data: params } : {})
    return { emulator: opened.s.emulator, url: `${session.url ?? ""}${query(opened)}` }
  })

/** Home: the current plan, payment methods, billing details and invoice history. */
export const Home: StoryObj = portal()

export const CancelSubscription: StoryObj = portal(
  undefined,
  (o) => `?flow=cancel&subscription=${o.subscription}`,
)

export const ChangePlan: StoryObj = portal(
  undefined,
  (o) => `?flow=update&subscription=${o.subscription}`,
)

export const AddPaymentMethod: StoryObj = portal(undefined, () => "?flow=payment_method")

export const UpdateBillingDetails: StoryObj = portal(undefined, () => "?flow=customer_update")

/** Typing a card: the same masking and focus flow as Checkout. */
export const TypingACard: StoryObj = {
  ...AddPaymentMethod,
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-portal-card", "5555555555554444" + "0830" + "737")
    expect((await page.get<HTMLInputElement>("stripe-mock-portal-card")).value).toBe(
      "5555 5555 5555 4444",
    )
    expect((await page.get<HTMLInputElement>("stripe-mock-portal-exp")).value).toBe("08 / 30")
  },
}

/** Add pressed with an expiry in the past. */
export const ExpiredCardRefused: StoryObj = {
  ...AddPaymentMethod,
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-portal-card", "4242424242424242" + "0120" + "123")
    await page.click("stripe-mock-portal-save-card")
    expect(page.doc.body.textContent).toContain("Your card's expiration year is in the past.")
  },
}

/** A portal session that does not exist. */
export const UnknownSession: StoryObj = page(() => ({
  emulator: stripe().emulator,
  url: "https://stripe.mock/p/session/bps_unknown",
}))
