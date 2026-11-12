import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { cove, type Demo, NEWCOMER, PATIENT, person, phone, SHELL, signInCode } from "./cove.js"

/**
 * The signed-out landing page: a passwordless sign-in by emailed code, the Google and Apple
 * buttons, and the three demo accounts. The code is read from the Resend emulator's inbox, as a
 * person would read it from theirs.
 */
export default {
  title: "Examples/Medical testing/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      ...SHELL,
      "packages/examples/medical-testing/src/client/pages/Landing.ts",
      "packages/examples/medical-testing/src/client/components/InboxHint.ts",
      "packages/examples/medical-testing/src/client/components/OAuthButtons.ts",
    ],
  },
} satisfies Meta

export const SignedOut: StoryObj = cove()

export const OnAPhone: StoryObj = cove({}, { globals: phone })

/** A demo account pressed: its address fills the email field. */
export const DemoAccountPicked: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = person(canvasElement)
    await page.click('[data-testid="demo-account"]', "Morgan Chen")
    expect((await page.find<HTMLInputElement>('[data-testid="sign-in-email"]')).value).toBe(
      "clinician@example.test",
    )
  },
}

const sendCode = async (canvas: HTMLElement, email = PATIENT) => {
  const page = person(canvas)
  await page.type('[data-testid="sign-in-email"]', email)
  await page.click('[data-testid="sign-in-email-submit"]')
  await page.find('[data-testid="sign-in-code"]')
  return page
}

/** The code is on its way: the code step, with the resend cooldown counting down. */
export const CodeSent: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = await sendCode(canvasElement)
    expect((await page.find('[data-testid="inbox-hint"]')).textContent).toContain(PATIENT)
    expect((await page.find('[data-testid="sign-in-resend"]')).textContent).toMatch(
      /Send a new code in \d+s/,
    )
  },
}

/** A wrong code: how many tries are left. */
export const WrongCode: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = await sendCode(canvasElement)
    await page.type('[data-testid="sign-in-code"]', "000000")
    await page.click('[data-testid="sign-in-code-submit"]')
    expect((await page.find('[data-testid="sign-in-error"]')).textContent).toMatch(
      /That code is not right\. \d tries left\./,
    )
  },
}

/** A second code asked for inside the cooldown: the server's wait, and the button counting it down. */
export const ResendTooSoon: StoryObj = {
  ...cove(),
  play: async ({ canvasElement }) => {
    const page = await sendCode(canvasElement)
    await page.click("button.cove-btn-link", "Use a different email")
    await page.click('[data-testid="sign-in-email-submit"]')
    expect((await page.find('[data-testid="sign-in-error"]')).textContent).toContain(
      "We just sent a code.",
    )
  },
}

/** The emailed code typed in: a new address gets an account and lands on its overview. */
export const SignedInWithCode: StoryObj = {
  ...cove(),
  play: async ({ canvasElement, loaded }) => {
    const page = await sendCode(canvasElement, NEWCOMER)
    const code = await signInCode((loaded as { demo: Demo }).demo, NEWCOMER)
    await page.type('[data-testid="sign-in-code"]', code)
    await page.click('[data-testid="sign-in-code-submit"]')
    expect((await page.find(".cove-page h1")).textContent).toBe("Welcome back, Grace.")
  },
}
