import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import {
  renderCardPage,
  renderCheckoutPage,
  renderErrorPage,
  renderFormPostPage,
  renderInspectorPage,
  renderJsonDetails,
  renderSettingsPage,
  renderStateView,
  renderUserButton,
} from "../../../../../packages/http/provider/src/vendor/core/ui.js"
import { frameDocument } from "../../../src/frame.js"
import { markup } from "../../../src/story.js"

/**
 * The page kit the ported provider emulators (GitHub, Google, Apple, Okta, Linear, Slack, Twilio,
 * Resend, AWS, Vercel, …) draw their hosted pages with: the emulator bar, card, error, settings
 * and inspector layouts, the account picker button, the auto-submitting form post, and a
 * checkout. Each layout is drawn here with representative content; the pages built on them are
 * stories of their emulators and in `Admin/Inspectors`.
 */
export default {
  title: "Admin/Shared provider UI/Layouts",
  parameters: { layout: "fullscreen", sources: ["packages/http/provider/src/vendor/core/ui.ts"] },
} satisfies Meta

const shows =
  (text: string) =>
  async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const doc = await frameDocument(canvasElement)
    await expect(doc.body.textContent).toContain(text)
  }

const account = (letter: string, login: string, name: string, email: string) =>
  renderUserButton({
    letter,
    login,
    name,
    email,
    formAction: "/login/oauth/authorize",
    hiddenFields: { client_id: "Iv1.storybook", state: "xyz" },
  })

/** A card: the account picker an OAuth emulator shows, built from user buttons. */
export const CardWithAccounts: StoryObj = markup(
  () =>
    renderCardPage(
      "Sign in to Gamezilla",
      "Choose an account to continue to <strong>gamezilla.dev</strong>",
      account("A", "alice", "Alice Liddell", "alice@gmail.com") +
        account("B", "bob", "Bob Marley", "bob@example.com"),
      "GitHub",
    ),
  { play: shows("bob@example.com") },
)

/** A card with nothing in it yet. */
export const CardEmpty: StoryObj = markup(
  () =>
    renderCardPage(
      "Inbox",
      "0 emails sent",
      '<div class="empty">No emails sent yet.</div>',
      "Resend",
    ),
  { play: shows("No emails sent yet.") },
)

export const ErrorPage: StoryObj = markup(
  () =>
    renderErrorPage(
      "Redirect URI mismatch",
      "The redirect_uri https://evil.example/callback is not registered for this application.",
      "Google",
    ),
  { play: shows("Redirect URI mismatch") },
)

/** Settings: a sidebar of sections and the page body. */
export const SettingsPage: StoryObj = markup(
  () =>
    renderSettingsPage(
      "Authorized OAuth Apps",
      '<a class="active" href="#">Applications</a><a href="#">Developer settings</a>',
      `<div class="s-card"><h2 class="section-heading">Authorized OAuth Apps</h2><p class="s-subtitle">You have granted 1 application access to your account.</p>${account("G", "Gamezilla", "Read access to profile", "Last used today")}</div>`,
      "GitHub",
    ),
  { play: shows("Developer settings") },
)

/** An inspector: tabs, a state table and JSON details. */
export const InspectorPage: StoryObj = markup(
  () =>
    renderInspectorPage(
      "Inspector",
      [
        { id: "state", label: "State", href: "#state" },
        { id: "raw", label: "Raw", href: "#raw" },
      ],
      "state",
      renderStateView({
        customers: [
          { id: "cus_1", email: "alice@gmail.com", name: "Alice Liddell" },
          { id: "cus_2", email: "bob@example.com", name: "Bob Marley" },
        ],
        settings: { currency: "usd", livemode: false },
      }) +
        renderJsonDetails("Last request", { method: "POST", path: "/v1/customers", status: 200 }),
      "Example",
    ),
  { play: shows("alice@gmail.com") },
)

/** A value that is not a table of records: one open JSON block. */
export const StateAsJson: StoryObj = markup(
  () => renderInspectorPage("Inspector", [], "", renderStateView(["queued", "sent"]), "Example"),
  { play: shows("Current state") },
)

/**
 * The page that posts a response back to the app (`response_mode=form_post`). It submits itself
 * on load; here its action is `javascript:void 0`, so it stays on screen.
 */
export const FormPostRedirect: StoryObj = markup(
  () =>
    renderFormPostPage(
      "javascript:void 0",
      { code: "c0de", state: "xyz", id_token: "eyJhbGciOi…" },
      "Apple",
    ),
  { play: shows("Redirecting") },
)

export const Checkout: StoryObj = markup(
  () =>
    renderCheckoutPage({
      merchantName: "Gamezilla",
      lineItems: [
        { name: "Unlimited plan", quantity: 1, unitPrice: 700, totalPrice: 700, currency: "usd" },
        { name: "Sticker pack", quantity: 3, unitPrice: 200, totalPrice: 600, currency: "usd" },
      ],
      subtotal: 1300,
      total: 1300,
      currency: "usd",
      sessionId: "cs_test_storybook",
      cancelUrl: "https://gamezilla.dev/cart",
    }),
  { play: shows("Pay $13.00") },
)

/** A checkout with no line items. */
export const CheckoutEmpty: StoryObj = markup(
  () =>
    renderCheckoutPage({
      lineItems: [],
      subtotal: 0,
      total: 0,
      currency: "usd",
      sessionId: "cs_test_empty",
    }),
  { play: shows("No line items") },
)

export const CardOnAPhone: StoryObj = {
  ...CardWithAccounts,
  globals: { viewport: { value: "phone", isRotated: false } },
}
