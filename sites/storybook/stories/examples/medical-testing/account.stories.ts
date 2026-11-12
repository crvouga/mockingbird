import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import {
  CLINICIAN,
  cove,
  type Demo,
  NEWCOMER,
  PATIENT,
  type Person,
  person,
  phone,
  type Setup,
  SHELL,
} from "./cove.js"

/**
 * Account settings: profile, phone number verified by a code (Twilio Verify emulator), order
 * update channels, a test message on any channel, the role's permissions, and sign-out. The
 * demo patient has a verified number; a first sign-in has none.
 */
export default {
  title: "Examples/Medical testing/Account",
  parameters: {
    layout: "fullscreen",
    sources: [
      ...SHELL,
      "packages/examples/medical-testing/src/client/pages/Account.ts",
      "packages/examples/medical-testing/src/client/components/InboxHint.ts",
    ],
  },
} satisfies Meta

const NUMBER = "+14155550142"

const account = (
  setup: Setup,
  play?: (page: Person, demo: Demo) => Promise<void>,
  extra: Parameters<typeof cove>[1] = {},
): StoryObj => ({
  ...cove({ route: "account", ...setup }, extra),
  play: async ({ canvasElement, loaded }) => {
    const page = person(canvasElement)
    await page.find('[data-testid="phone-card"]')
    await play?.(page, (loaded as { demo: Demo }).demo)
  },
})

/** A patient with a verified number and every channel on. */
export const Patient: StoryObj = account({ as: PATIENT })

/** A first sign-in: no number yet, so texts cannot be turned on. */
export const NoPhoneYet: StoryObj = account({ as: NEWCOMER })

/** A clinician: more permissions, and a staff alert among the tests. */
export const Clinician: StoryObj = account({ as: CLINICIAN })

/** The name changed and saved. */
export const ProfileSaved: StoryObj = account({ as: PATIENT }, async (page) => {
  await page.type(".cove-card form .cove-input[required]", " King")
  await page.click(".cove-card form button.cove-btn-primary", "Save changes")
  await page.find('.cove-alert-success[role="status"]', "Your changes have been saved.")
})

/** Email updates switched off; the switch saves on its own. */
export const EmailUpdatesOff: StoryObj = account({ as: PATIENT }, async (page) => {
  await page.click('[data-testid="notify-email"]')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const toggle = await page.find<HTMLInputElement>('[data-testid="notify-email"]')
    if (!toggle.disabled && !toggle.checked) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error("email updates never turned off")
})

const sendCode = async (page: Person, number = "(415) 555-0142") => {
  await page.type('[data-testid="phone-input"]', number)
  await page.click('[data-testid="phone-send"]')
}

/** A number that is not one: the server's message. */
export const InvalidNumber: StoryObj = account({ as: NEWCOMER }, async (page) => {
  await sendCode(page, "555-01")
  await page.find('[data-testid="phone-error"]', "Enter a mobile number with its area code")
})

/** The code is on its way: the code step. */
export const PhoneCodeSent: StoryObj = account({ as: NEWCOMER }, async (page) => {
  await sendCode(page)
  await page.find('[data-testid="phone-code"]')
})

/** A wrong code. */
export const PhoneWrongCode: StoryObj = account({ as: NEWCOMER }, async (page, demo) => {
  await sendCode(page)
  const [otp] = await demo.notifications.waitFor({ channel: "sms", to: NUMBER })
  await page.type('[data-testid="phone-code"]', otp?.sms?.code === "000000" ? "000001" : "000000")
  await page.click('[data-testid="phone-verify"]')
  await page.find('[data-testid="phone-error"]', "That code is not right.")
})

/** The texted code typed in: the number is verified and texts can be turned on. */
export const PhoneVerified: StoryObj = account({ as: NEWCOMER }, async (page, demo) => {
  await page.click('[data-testid="phone-channel-whatsapp"]')
  await sendCode(page)
  const [otp] = await demo.notifications.waitFor({ channel: "sms", to: NUMBER })
  await page.type('[data-testid="phone-code"]', otp?.sms?.code ?? "")
  await page.click('[data-testid="phone-verify"]')
  expect((await page.find('[data-testid="phone-current"]')).textContent).toBe("(415) 555-0142")
})

/** Changing a verified number: the form, with a way back. */
export const ChangingNumber: StoryObj = account({ as: PATIENT }, async (page) => {
  await page.click('[data-testid="phone-card"] button', "Change")
  await page.find('[data-testid="phone-input"]')
})

/** A test email sent: where to read it. */
export const TestEmailSent: StoryObj = account({ as: PATIENT }, async (page) => {
  await page.click('[data-testid="test-email"]')
  await page.find(
    '[data-testid="test-notifications"] [data-testid="inbox-hint"]',
    "Test email sent",
  )
})

/** A test text with no number to send it to. */
export const TestTextUnavailable: StoryObj = account({ as: NEWCOMER }, async (page) => {
  await page.click('[data-testid="test-text"]')
  await page.find('[data-testid="test-error"]', "Verify a phone number first")
})

/** A clinician's test staff alert, posted to the staff channel. */
export const StaffAlertSent: StoryObj = account({ as: CLINICIAN }, async (page) => {
  await page.click('[data-testid="test-chat"]')
  await page.find(
    '[data-testid="test-notifications"] [data-testid="inbox-hint"]',
    "Test alert posted",
  )
})

/** Signing out: back to the sign-in page. */
export const SignedOut: StoryObj = account({ as: PATIENT }, async (page) => {
  await page.click(".cove-card button.cove-btn-ghost", "Sign out")
  await page.find('[data-testid="sign-in-email"]')
})

export const OnAPhone: StoryObj = account({ as: PATIENT }, undefined, { globals: phone })
