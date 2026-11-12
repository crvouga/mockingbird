import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { hands } from "../../../src/interact.js"
import { page } from "../../../src/story.js"
import { stripe } from "./stripe.js"

/**
 * The hosted Checkout page (`/c/pay/{session}`) served in place of checkout.stripe.com, opened on
 * a real Checkout Session. Every story is usable: type a card, press Pay, and the emulator
 * answers. The Pay button posts to the emulator; a success leaves for the merchant's
 * `success_url`, where the story stops.
 */
export default {
  title: "Emulators/Stripe/Checkout",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/service/stripe/src/checkout-page.ts",
      "packages/service/stripe/src/browser.ts",
      "packages/service/stripe/src/card-input.ts",
    ],
  },
} satisfies Meta

/** `session` → open its hosted page. */
const checkout = (create: (s: ReturnType<typeof stripe>) => Promise<{ url?: string }>) =>
  page(async () => {
    const s = stripe()
    const session = await create(s)
    return { emulator: s.emulator, url: session.url ?? "" }
  })

const trial = (s: ReturnType<typeof stripe>) =>
  s.plan().then((price) =>
    s.checkout({
      mode: "subscription",
      customer_email: "alice@gmail.com",
      line_items: [{ price: price.id, quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
    }),
  )

/** A subscription that starts with a free trial: nothing is due today. */
export const SubscriptionWithTrial: StoryObj = checkout(trial)

export const Subscription: StoryObj = checkout((s) =>
  s
    .plan("Pro", 2900)
    .then((price) =>
      s.checkout({ mode: "subscription", line_items: [{ price: price.id, quantity: 1 }] }),
    ),
)

/** A one-time payment for several items, with the customer's email still to be typed. */
export const OneTimePayment: StoryObj = checkout(async (s) => {
  const shirt = await s.oneTime("Mockingbird T-shirt", 2500)
  const stickers = await s.oneTime("Sticker pack", 600)
  return s.checkout({
    mode: "payment",
    line_items: [
      { price: shirt.id, quantity: 2 },
      { price: stickers.id, quantity: 1 },
    ],
  })
})

/** `allow_promotion_codes`: the summary offers a promotion code field. */
export const PromotionCodes: StoryObj = checkout(async (s) => {
  const price = await s.plan("Team", 4900)
  const coupon = await s.post("/v1/coupons", { percent_off: 20, duration: "once" })
  await s.post("/v1/promotion_codes", { coupon: coupon.id, code: "WELCOME20" })
  return s.checkout({
    mode: "subscription",
    allow_promotion_codes: true,
    line_items: [{ price: price.id, quantity: 1 }],
  })
})

/** Setup mode: save a card for later, nothing is charged. */
export const SaveCard: StoryObj = checkout(async (s) => {
  const customer = await s.customer()
  return s.checkout({ mode: "setup", currency: "usd", customer: customer.id })
})

/** A free trial with `payment_method_collection=if_required`: no card is asked for. */
export const TrialWithoutCard: StoryObj = checkout((s) =>
  s.plan().then((price) =>
    s.checkout({
      mode: "subscription",
      payment_method_collection: "if_required",
      line_items: [{ price: price.id, quantity: 1 }],
      subscription_data: { trial_period_days: 14 },
    }),
  ),
)

/** The page on a phone: the summary stacks above the form. */
export const OnAPhone: StoryObj = {
  ...checkout(trial),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Typing a card: grouped as it is typed, focus moving on once each field is complete. */
export const TypingACard: StoryObj = {
  ...checkout(trial),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "4242424242424242" + "1234" + "123")
    expect((await page.get<HTMLInputElement>("stripe-mock-card")).value).toBe("4242 4242 4242 4242")
    expect((await page.get<HTMLInputElement>("stripe-mock-exp")).value).toBe("12 / 34")
    expect((await page.get<HTMLInputElement>("stripe-mock-cvc")).value).toBe("123")
  },
}

/** Pay pressed with an incomplete card: Stripe's messages, and the first bad field focused. */
export const IncompleteCard: StoryObj = {
  ...checkout(trial),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "4242 4242")
    await page.click("stripe-mock-pay")
    const error = await page.get("stripe-mock-error")
    expect(error.textContent).toContain("Your card number is incomplete.")
  },
}

/** A Luhn-invalid number is flagged as soon as it is complete. */
export const InvalidNumber: StoryObj = {
  ...checkout(trial),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "4242424242424241")
    expect((await page.get("stripe-mock-error")).textContent).toContain(
      "Your card number is invalid.",
    )
  },
}

/** The test-card panel fills every field in one click. */
export const FilledFromTestCard: StoryObj = {
  ...checkout(trial),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    page.doc.querySelector("details.testcards")?.setAttribute("open", "")
    const visa = page.doc.querySelector<HTMLElement>('[data-test-card="4242424242424242"]')
    visa?.click()
    expect((await page.get<HTMLInputElement>("stripe-mock-card")).value).toBe("4242 4242 4242 4242")
  },
}

/** The generic decline card: the emulator refuses it and the page says so. */
export const Declined: StoryObj = {
  ...checkout(async (s) => {
    const shirt = await s.oneTime("Mockingbird T-shirt", 2500)
    return s.checkout({ mode: "payment", line_items: [{ price: shirt.id, quantity: 1 }] })
  }),
  play: async ({ canvasElement }) => {
    let page = await hands(canvasElement)
    await page.type("stripe-mock-email", "alice@gmail.com")
    await page.type("stripe-mock-card", "4000000000000002" + "1234" + "123")
    await page.type("stripe-mock-name", "Alice Liddell")
    await page.type("stripe-mock-zip", "94107")
    await page.click("stripe-mock-pay")
    page = await page.navigated()
    expect((await page.get("stripe-mock-error")).textContent).toContain("Your card was declined.")
  },
}

/** A session that was paid: the page says so instead of taking another payment. */
export const Completed: StoryObj = page(async () => {
  const s = stripe()
  const session = await trial(s)
  await s.emulator.fetch(
    new Request(`https://stripe.mock/__admin/checkout/sessions/${session.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card: "4242424242424242" }),
    }),
  )
  return { emulator: s.emulator, url: session.url ?? "" }
})

/** An expired session. */
export const Expired: StoryObj = page(async () => {
  const s = stripe()
  const session = await trial(s)
  await s.post(`/v1/checkout/sessions/${session.id}/expire`)
  return { emulator: s.emulator, url: session.url ?? "" }
})

/** A session id the emulator does not know. */
export const UnknownSession: StoryObj = page(() => ({
  emulator: stripe().emulator,
  url: "https://stripe.mock/c/pay/cs_test_unknown",
}))
