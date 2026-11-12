import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { cove, PATIENT, type Person, person, phone, SHELL } from "./cove.js"

/**
 * Paying for an order: the Stripe emulator's real hosted Checkout page, fetched by the app's
 * server and pasted into the app's modal, its form posted back through the app. A paid order is
 * fulfilled by the payments webhook and lands on Orders with a receipt notice.
 */
export default {
  title: "Examples/Medical testing/Checkout",
  parameters: {
    layout: "fullscreen",
    sources: [
      ...SHELL,
      "packages/examples/medical-testing/src/client/pages/Checkout.ts",
      "packages/examples/medical-testing/src/client/components/CheckoutModal.ts",
      "packages/examples/medical-testing/src/client/components/useEscapeKey.ts",
      "packages/examples/medical-testing/src/client/hostedPages.ts",
      "packages/examples/medical-testing/src/client/pasteHtml.ts",
      "packages/examples/medical-testing/src/adapters/payments/stripeMockPayments.ts",
      "packages/service/stripe/src/checkout-page.ts",
    ],
  },
} satisfies Meta

/** Pick two tests, agree, and continue to the hosted payment page. */
const toPayment = async (canvas: HTMLElement): Promise<Person> => {
  const page = person(canvas)
  await page.click(".cove-test-card:nth-child(1) button[aria-pressed]")
  await page.click(".cove-test-card:nth-child(3) button[aria-pressed]")
  await page.click(".cove-cart .cove-checkbox input")
  await page.click(".cove-cart .cove-btn-primary")
  await page.find('.hosted-page [data-testid="stripe-mock-pay"]')
  return page
}

const payWith = async (page: Person, card: string) => {
  await page.click(`[data-test-card="${card}"]`)
  await page.click('[data-testid="stripe-mock-pay"]')
}

/** The hosted payment page in the app's modal. */
export const PaymentPage: StoryObj = {
  ...cove({ as: PATIENT, route: "shop" }),
  play: async ({ canvasElement }) => {
    await toPayment(canvasElement)
  },
}

/** A test card picked: every field filled and formatted. */
export const CardFilled: StoryObj = {
  ...cove({ as: PATIENT, route: "shop" }),
  play: async ({ canvasElement }) => {
    const page = await toPayment(canvasElement)
    await page.click('[data-test-card="4242424242424242"]')
    expect((await page.find<HTMLInputElement>('[data-testid="stripe-mock-card"]')).value).toBe(
      "4242 4242 4242 4242",
    )
  },
}

/** The decline card: Stripe's answer on the page, and the order still awaiting payment. */
export const Declined: StoryObj = {
  ...cove({ as: PATIENT, route: "shop" }),
  play: async ({ canvasElement }) => {
    const page = await toPayment(canvasElement)
    await payWith(page, "4000000000000002")
    expect(
      (await page.find('[data-testid="stripe-mock-error"]', "declined")).textContent,
    ).toContain("Your card was declined.")
  },
}

/** Paid: back on Orders with the receipt notice. */
export const Paid: StoryObj = {
  ...cove({ as: PATIENT, route: "shop" }),
  play: async ({ canvasElement }) => {
    const page = await toPayment(canvasElement)
    await payWith(page, "4242424242424242")
    await page.find(
      ".cove-notice",
      "Payment successful. We emailed your receipt to ada@example.test.",
    )
  },
}

/** Checkout opened with no order to pay. */
export const NoOrderInProgress: StoryObj = cove({ as: PATIENT, route: "checkout" })

/** The payment page on a phone: the modal fills the screen. */
export const OnAPhone: StoryObj = { ...PaymentPage, globals: phone }
