import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { type Hands, hands } from "../../../src/interact.js"
import { page } from "../../../src/story.js"
import { flex, type Session } from "./flex.js"

/**
 * The hosted HSA/FSA checkout (`/pay/{session}`) served in place of Flex's, opened on a real
 * Checkout Session. Every story is usable: fill the form, press Pay, and the emulator answers. A
 * paid session leaves for the merchant's `success_url`, where the story stops.
 */
export default {
  title: "Emulators/Flex/Checkout",
  parameters: { layout: "fullscreen", sources: ["packages/service/flex/src/hosted.ts"] },
} satisfies Meta

type Flex = ReturnType<typeof flex>

/** `create` a session (then `prepare` it through the admin API), and open its hosted page. */
const checkout = (
  create: (f: Flex) => Promise<Session>,
  prepare?: (f: Flex, session: Session) => Promise<unknown>,
) =>
  page(async () => {
    const f = flex()
    const session = await create(f)
    await prepare?.(f, session)
    return { emulator: f.emulator, url: session.redirect_url }
  })

const payment = (f: Flex) => f.payment()

/** Every contact field, then the card; `card` defaults to the HSA/FSA test card. */
const fill = async (page: Hands, card = "4000051230000072", exp = "12/34", cvc = "123") => {
  await page.type("flex-mock-email", "ada@example.com")
  await page.type("flex-mock-first-name", "Ada")
  await page.type("flex-mock-last-name", "Lovelace")
  await page.type("flex-mock-phone", "6025550142")
  await page.type("flex-mock-card", card)
  if (exp) await page.type("flex-mock-exp", exp)
  if (cvc) await page.type("flex-mock-cvc", cvc)
  await page.type("flex-mock-zip", "85004")
}

/** Fill the form with `card`, press Pay, and return the page the emulator answers with. */
const pay = async (canvas: HTMLElement, card?: string, exp?: string, cvc?: string) => {
  const page = await hands(canvas)
  await fill(page, card, exp, cvc)
  await page.click("flex-mock-pay")
  return page.navigated()
}

/** A one-time payment for a lab panel and a supplement. */
export const Payment: StoryObj = checkout(payment)

/** A membership billed monthly: the total says how often. */
export const Subscription: StoryObj = checkout((f) => f.subscription())

/** A membership billed every three months. */
export const QuarterlySubscription: StoryObj = checkout((f) => f.subscription(3))

/** Setup mode: save an HSA/FSA card for later, nothing is charged. */
export const SaveCard: StoryObj = checkout((f) => f.setup())

/** A session with no `cancel_url`: no way back to the merchant. */
export const WithoutCancelLink: StoryObj = checkout(async (f) => {
  const product = await f.product("Annual physical")
  return f.checkout({
    mode: "payment",
    cancel_url: undefined,
    line_items: [{ price_data: { product, unit_amount: 15000 }, quantity: 1 }],
  })
})

/** The page on a phone. */
export const OnAPhone: StoryObj = {
  ...checkout(payment),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Every field filled in, before Pay. */
export const Filled: StoryObj = {
  ...checkout(payment),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await fill(page)
    expect((await page.get<HTMLInputElement>("flex-mock-card")).value).toBe("4000051230000072")
  },
}

/** Pay pressed with half a card number. */
export const IncompleteCard: StoryObj = {
  ...checkout(payment),
  play: async ({ canvasElement }) => {
    const page = await pay(canvasElement, "40000512")
    expect((await page.get("flex-mock-error")).textContent).toBe("Your card number is incomplete.")
  },
}

/** A Luhn-invalid card number. */
export const InvalidCard: StoryObj = {
  ...checkout(payment),
  play: async ({ canvasElement }) => {
    const page = await pay(canvasElement, "4000051230000071")
    expect((await page.get("flex-mock-error")).textContent).toBe("Your card number is invalid.")
  },
}

/** No expiration date. */
export const IncompleteExpiry: StoryObj = {
  ...checkout(payment),
  play: async ({ canvasElement }) => {
    const page = await pay(canvasElement, undefined, "")
    expect((await page.get("flex-mock-error")).textContent).toBe(
      "Your card's expiration date is incomplete.",
    )
  },
}

/** No security code. */
export const IncompleteSecurityCode: StoryObj = {
  ...checkout(payment),
  play: async ({ canvasElement }) => {
    const page = await pay(canvasElement, undefined, "12/34", "")
    expect((await page.get("flex-mock-error")).textContent).toBe(
      "Your card's security code is incomplete.",
    )
  },
}

/** The decline test card: the emulator refuses it and the form asks again. */
export const Declined: StoryObj = {
  ...checkout(payment),
  play: async ({ canvasElement }) => {
    const page = await pay(canvasElement, "4000000000000002")
    expect((await page.get("flex-mock-error")).textContent).toBe("Your card was declined.")
  },
}

/** The HSA/FSA card pays: the browser leaves for the merchant's `success_url`. */
export const Paid: StoryObj = {
  ...checkout(payment),
  play: async ({ canvasElement }) => {
    const page = await pay(canvasElement)
    expect((await page.get("storybook-departure")).textContent).toContain(
      "https://clinic.example/paid?session=fcs_",
    )
  },
}

/**
 * A regular card on an item that needs a letter of medical necessity: the page moves on to the
 * questionnaire step.
 */
export const RegularCardNeedsALetter: StoryObj = {
  ...checkout((f) => f.payment(true)),
  play: async ({ canvasElement }) => {
    const page = await pay(canvasElement, "4242424242424242")
    expect((await page.get("flex-mock-lmn")).textContent).toContain("letter of medical necessity")
  },
}

/** The letter-of-medical-necessity step, as the session's next action. */
export const LetterOfMedicalNecessity: StoryObj = checkout(
  (f) => f.payment(true),
  (f, s) =>
    f.admin(`/sessions/${s.checkout_session_id}/require_action`, {
      next_action_type: "collect_letter_of_medical_necessity",
    }),
)

/** The questionnaire submitted: the payment settles and the browser leaves for `success_url`. */
export const LetterSubmitted: StoryObj = {
  ...LetterOfMedicalNecessity,
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.click("flex-mock-lmn-submit")
    const next = await page.navigated()
    expect((await next.get("storybook-departure")).textContent).toContain(
      "https://clinic.example/paid",
    )
  },
}

/** Next action `payment_failed`: the card form again, saying why. */
export const PaymentFailed: StoryObj = checkout(payment, (f, s) =>
  f.admin(`/sessions/${s.checkout_session_id}/require_action`, {
    next_action_type: "payment_failed",
  }),
)

/** Next action `provide_second_payment_method`: a second card for the rest. */
export const SecondCardNeeded: StoryObj = checkout(payment, (f, s) =>
  f.admin(`/sessions/${s.checkout_session_id}/require_action`, {
    next_action_type: "provide_second_payment_method",
  }),
)

/** Next action `provide_alternative_payment_method`: another way to pay. */
export const AnotherMethodNeeded: StoryObj = checkout(payment, (f, s) =>
  f.admin(`/sessions/${s.checkout_session_id}/require_action`, {
    next_action_type: "provide_alternative_payment_method",
  }),
)

/** A session that was paid: nothing more to pay. */
export const Completed: StoryObj = checkout(payment, (f, s) =>
  f.admin(`/sessions/${s.checkout_session_id}/complete`),
)

/** An expired session. */
export const Expired: StoryObj = checkout(payment, (f, s) =>
  f.admin(`/sessions/${s.checkout_session_id}/expire`),
)

/** A session id the emulator does not know. */
export const UnknownSession: StoryObj = page(async () => {
  const f = flex()
  const session = await f.payment()
  return { emulator: f.emulator, url: session.redirect_url.replace(/fcs_\w+$/, "fcs_unknown") }
})
