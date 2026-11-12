import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { hands } from "../../../src/interact.js"
import { shopStory } from "./elements.js"

type Args = {
  theme: "stripe" | "night" | "flat" | "none"
  labels: "above" | "floating"
  inputs: "spaced" | "condensed"
  colorPrimary: string
  colorBackground: string
  colorText: string
  colorDanger: string
  fontFamily: string
  borderRadius: string
  spacingUnit: string
  /** `fields.billingDetails`: "auto" collects country and postal code, "never" does not. */
  billingDetails: "auto" | "never"
}

/**
 * The Payment Element from the Stripe.js stand-in, themed with the Appearance API. Every control
 * below is an Appearance option; Pay runs `elements.submit()` then `confirmPayment` against the
 * emulator, so the test cards behave as they do in Stripe test mode.
 */
export default {
  title: "Emulators/Stripe/Stripe.js/Payment Element",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/service/stripe/src/stripe-js.ts",
      "packages/service/stripe/src/stripe-js-ui.ts",
      "packages/service/stripe/src/card-input.ts",
    ],
  },
  args: {
    theme: "stripe",
    labels: "above",
    inputs: "spaced",
    colorPrimary: "",
    colorBackground: "",
    colorText: "",
    colorDanger: "",
    fontFamily: "",
    borderRadius: "",
    spacingUnit: "",
    billingDetails: "auto",
  },
  argTypes: {
    theme: { control: "inline-radio", options: ["stripe", "night", "flat", "none"] },
    labels: { control: "inline-radio", options: ["above", "floating"] },
    inputs: { control: "inline-radio", options: ["spaced", "condensed"] },
    colorPrimary: { control: "color" },
    colorBackground: { control: "color" },
    colorText: { control: "color" },
    colorDanger: { control: "color" },
    billingDetails: { control: "inline-radio", options: ["auto", "never"] },
  },
} satisfies Meta<Args>

const VARIABLES = [
  "colorPrimary",
  "colorBackground",
  "colorText",
  "colorDanger",
  "fontFamily",
  "borderRadius",
  "spacingUnit",
] as const

const element = (rules: Record<string, Record<string, string>> = {}) =>
  shopStory<Args>((args) => {
    const variables = Object.fromEntries(
      VARIABLES.filter((key) => args[key]).map((key) => [key, args[key]]),
    )
    const appearance = {
      theme: args.theme,
      labels: args.labels,
      inputs: args.inputs,
      variables,
      rules,
    }
    const options =
      args.billingDetails === "never" ? { fields: { billingDetails: { address: "never" } } } : {}
    return {
      dark: args.theme === "night",
      slots: '<div id="payment-element"></div>',
      script: `
var elements = stripe.elements({ clientSecret: clientSecret, appearance: ${JSON.stringify(appearance)} });
elements.create("payment", ${JSON.stringify(options)}).mount("#payment-element");
function pay() {
  return elements.submit().then(function (submitted) {
    if (submitted.error) return submitted;
    return stripe.confirmPayment({ elements: elements, redirect: "if_required", confirmParams: { return_url: "https://merchant.example/done" } });
  });
}`,
    }
  })

export const Default: StoryObj<Args> = element()

export const Night: StoryObj<Args> = { ...element(), args: { theme: "night" } }

export const Flat: StoryObj<Args> = { ...element(), args: { theme: "flat" } }

export const FloatingLabels: StoryObj<Args> = {
  ...element(),
  args: { theme: "flat", labels: "floating" },
}

/** `inputs: "condensed"`: one card block and one address block, labelled as groups. */
export const Condensed: StoryObj<Args> = { ...element(), args: { inputs: "condensed" } }

/** A brand's own colours, font and corner radius, and a rule for the focused input. */
export const BrandedWithRules: StoryObj<Args> = {
  ...element({
    ".Input": { boxShadow: "none", borderColor: "#d7d3f5" },
    ".Input:focus": { borderColor: "#7a5af8", boxShadow: "0 0 0 3px rgba(122,90,248,.2)" },
    ".Label": { fontWeight: "600", textTransform: "uppercase", letterSpacing: ".04em" },
  }),
  args: {
    colorPrimary: "#7a5af8",
    colorText: "#2a2350",
    fontFamily: "Georgia, serif",
    borderRadius: "12px",
    spacingUnit: "3px",
  },
}

/** `fields.billingDetails.address: "never"`: the merchant collects the address itself. */
export const CardFieldsOnly: StoryObj<Args> = { ...element(), args: { billingDetails: "never" } }

export const OnAPhone: StoryObj<Args> = {
  ...element(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Typing: the number is grouped and the brand icon chosen as it is typed, focus moves on. */
export const Typing: StoryObj<Args> = {
  ...element(),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "378282246310005" + "1234" + "1234")
    expect((await page.get<HTMLInputElement>("stripe-mock-card")).value).toBe("3782 822463 10005")
    expect((await page.get<HTMLInputElement>("stripe-mock-cvc")).value).toBe("1234")
  },
}

/** Pay pressed on an empty form: every field says what is missing, the first one has focus. */
export const SubmittedEmpty: StoryObj<Args> = {
  ...element(),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.click("shop-pay")
    await expect((await page.get("shop-message")).textContent).toContain(
      "Your card number is incomplete.",
    )
  },
}

/** An error shows once the field is left, not while it is being typed. */
export const ErrorAfterBlur: StoryObj<Args> = {
  ...element(),
  play: async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", "4242 4242")
    await page.type("stripe-mock-zip", "9")
    expect(page.doc.body.textContent).toContain("Your card number is incomplete.")
  },
}

const payWith =
  (card: string, expected: string): NonNullable<StoryObj<Args>["play"]> =>
  async ({ canvasElement }) => {
    const page = await hands(canvasElement)
    await page.type("stripe-mock-card", `${card}1234123`)
    await page.type("stripe-mock-zip", "94107")
    await page.click("shop-pay")
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await page.get("shop-message")).textContent) break
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect((await page.get("shop-message")).textContent).toContain(expected)
  }

export const Succeeds: StoryObj<Args> = {
  ...element(),
  play: payWith("4242424242424242", "Payment succeeded"),
}

export const Declined: StoryObj<Args> = {
  ...element(),
  play: payWith("4000000000000002", "Your card was declined."),
}

/** A 3-D Secure card: the stand-in authenticates it in place and the payment succeeds. */
export const ThreeDSecure: StoryObj<Args> = {
  ...element(),
  play: payWith("4000002500003155", "Payment succeeded"),
}
