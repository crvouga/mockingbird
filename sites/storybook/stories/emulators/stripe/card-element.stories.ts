import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { hands } from "../../../src/interact.js"
import { shopStory } from "./elements.js"

/**
 * The classic card Element and the split card Elements from the Stripe.js stand-in. Like
 * Stripe's, they draw an unboxed line of inputs: the merchant styles the container through the
 * `StripeElement` classes, and the text through the `style` option.
 */
export default {
  title: "Emulators/Stripe/Stripe.js/Card Element",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/service/stripe/src/stripe-js.ts",
      "packages/service/stripe/src/stripe-js-ui.ts",
      "packages/service/stripe/src/card-input.ts",
    ],
  },
} satisfies Meta

/** The container CSS Stripe's own examples ship, keyed off the state classes on the mount node. */
const CONTAINER = `
.StripeElement{padding:14px 12px;border:1px solid #e0e0e6;border-radius:8px;background:#fff;transition:border-color .15s,box-shadow .15s}
.StripeElement--focus{border-color:#3a64e4;box-shadow:0 0 0 3px rgba(58,100,228,.18)}
.StripeElement--invalid{border-color:#df1b41}
.StripeElement--complete{border-color:#1ea672}
.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
label.field{display:grid;gap:6px;font-size:14px;color:#6d6e78}`

const STYLE = {
  base: {
    color: "#32325d",
    fontFamily: '"Inter", system-ui, sans-serif',
    fontSize: "16px",
    "::placeholder": { color: "#aab7c4" },
  },
  invalid: { color: "#df1b41", iconColor: "#df1b41" },
}

const card = (options: Record<string, unknown> = {}, css = CONTAINER) =>
  shopStory(() => ({
    css,
    slots: '<div id="card-element"></div>',
    script: `
var card = stripe.elements().create("card", ${JSON.stringify(options)});
card.mount("#card-element");
function pay() { return stripe.confirmCardPayment(clientSecret, { payment_method: { card: card } }); }`,
  }))

/** No merchant CSS at all: exactly what Stripe's iframe draws, a bare line of inputs. */
export const Unstyled: StoryObj = card({}, "")

/** Container CSS and a `style` object, as in Stripe's card Element examples. */
export const Styled: StoryObj = card({ style: STYLE })

export const WithoutPostalCode: StoryObj = card({ style: STYLE, hidePostalCode: true })

export const WithoutIcon: StoryObj = card({ style: STYLE, hideIcon: true })

export const Disabled: StoryObj = card({ style: STYLE, disabled: true })

/** A complete card: the container turns green through `StripeElement--complete`. */
export const Complete: StoryObj = {
  ...card({ style: STYLE }),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "4242424242424242" + "1234" + "123" + "94107")
    expect((await page.get<HTMLInputElement>("stripe-mock-zip")).value).toBe("94107")
  },
}

/** A Luhn-invalid number: the text and icon turn red, the container gets `--invalid`. */
export const InvalidNumber: StoryObj = {
  ...card({ style: STYLE }),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "4242424242424241")
    expect((await page.get("stripe-mock-card")).getAttribute("aria-invalid")).toBe("true")
  },
}

/** The CVC field shows the card-back icon while it has focus. */
export const CvcFocused: StoryObj = {
  ...card({ style: STYLE }),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "4242424242424242" + "1234")
  },
}

export const Succeeds: StoryObj = {
  ...card({ style: STYLE }),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "4242424242424242" + "1234" + "123" + "94107")
    await page.click("shop-pay")
    for (
      let attempt = 0;
      attempt < 100 && !(await page.get("shop-message")).textContent;
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await page.get("shop-message")).textContent).toContain("Payment succeeded")
  },
}

const split = (numberOptions: Record<string, unknown> = {}) =>
  shopStory(() => ({
    css: CONTAINER,
    slots: `<label class="field">Card number<div id="card-number"></div></label>
<div class="split"><label class="field">Expiration<div id="card-expiry"></div></label>
<label class="field">CVC<div id="card-cvc"></div></label></div>`,
    script: `
var elements = stripe.elements();
var style = ${JSON.stringify(STYLE)};
var number = elements.create("cardNumber", Object.assign({ style: style }, ${JSON.stringify(numberOptions)}));
number.mount("#card-number");
elements.create("cardExpiry", { style: style }).mount("#card-expiry");
elements.create("cardCvc", { style: style }).mount("#card-cvc");
function pay() { return stripe.confirmCardPayment(clientSecret, { payment_method: { card: number } }); }`,
  }))

/** `cardNumber`, `cardExpiry` and `cardCvc` mounted separately, sharing one card. */
export const SplitFields: StoryObj = split()

export const SplitFieldsWithIcon: StoryObj = split({ showIcon: true })

export const SplitFieldsTyping: StoryObj = {
  ...split({ showIcon: true }),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "5555555555554444")
    await page.type("stripe-mock-exp", "1")
    expect((await page.get<HTMLInputElement>("stripe-mock-exp")).value).toBe("1")
  },
}
