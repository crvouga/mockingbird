import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import {
  type AccountOption,
  chip,
  formPostPage,
  renderCardPage,
  renderErrorPage,
  renderInspectorPage,
  renderProviderPage,
  renderSignInPage,
  section,
  table,
} from "../../../../../packages/http/provider/src/vendor/core/ui.js"
import { frameDocument } from "../../../src/frame.js"
import { markup } from "../../../src/story.js"

/**
 * The page kit the ported provider emulators (GitHub, Google, Apple, Okta, Linear, Slack, Twilio,
 * Resend, AWS, Vercel, …) draw their hosted pages with: a route describes the page as data and
 * the Mockingbird design system draws it, `CenteredCard` for sign-in, error and redirect pages
 * and `AppShell` for inspectors and settings. Each layout is drawn here with representative
 * content; the pages built on them are stories of their emulators and in `Admin/Inspectors`.
 */
export default {
  title: "Admin/Shared provider UI/Layouts",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/core/ui.ts",
      "packages/http/provider/src/ui/model.ts",
      "packages/http/provider/src/ui/page.tsx",
      "packages/http/provider/src/ui/server.tsx",
    ],
  },
} satisfies Meta

const shows =
  (text: string) =>
  async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const doc = await frameDocument(canvasElement)
    await expect(doc.body.textContent).toContain(text)
  }

const account = (letter: string, login: string, name: string, email: string): AccountOption => ({
  letter,
  login,
  name,
  email,
  formAction: "/login/oauth/authorize",
  hiddenFields: { client_id: "Iv1.storybook", state: "xyz" },
})

/** An account picker: one button per seeded user. */
export const CardWithAccounts: StoryObj = markup(
  () =>
    renderSignInPage(
      "Sign in to Gamezilla",
      ["Choose an account to continue to ", { strong: "gamezilla.dev" }],
      [
        account("A", "alice", "Alice Liddell", "alice@gmail.com"),
        account("B", "bob", "Bob Marley", "bob@example.com"),
      ],
      "GitHub",
    ),
  { play: shows("bob@example.com") },
)

/** An account picker with no seeded users. */
export const CardEmpty: StoryObj = markup(
  () => renderSignInPage("Sign in to Gamezilla", "Choose a seeded user to continue.", [], "GitHub"),
  { play: shows("No users in the emulator store.") },
)

/** A card with other content: details and a JSON block. */
export const CardWithDetails: StoryObj = markup(
  () =>
    renderCardPage(
      "Device authorized",
      "You can close this window.",
      [
        {
          type: "details",
          items: [
            { label: "Client", value: "Gamezilla CLI" },
            { label: "Code", value: "WDJB-MJHT", mono: true },
            { label: "Status", value: chip("approved") },
          ],
        },
      ],
      "GitHub",
    ),
  { play: shows("WDJB-MJHT") },
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

/** Settings: a list of links, and a section with a destructive action. */
export const SettingsPage: StoryObj = markup(
  () =>
    renderProviderPage({
      layout: "app",
      service: "GitHub",
      title: "Authorized OAuth Apps",
      description: "Applications you have granted access to your account.",
      nav: [{ label: "Authorized apps", href: "#", current: true }],
      blocks: [
        {
          type: "links",
          empty: "No authorized applications.",
          items: [
            {
              href: "#gamezilla",
              title: "Gamezilla",
              description: "read:user, user:email",
              letter: "G",
            },
          ],
        },
        {
          type: "section",
          title: "Permissions",
          action: { type: "form", action: "#", label: "Revoke access", variant: "danger" },
          blocks: [
            {
              type: "checklist",
              items: ["Read all user profile data", "Access user email addresses (read-only)"],
              empty: "No specific permissions granted.",
            },
          ],
        },
      ],
    }),
  { play: shows("Revoke access") },
)

/** An inspector: tabs in the top bar, tables with status chips, an empty table and JSON. */
export const InspectorPage: StoryObj = markup(
  () =>
    renderInspectorPage(
      "Example Inspector",
      [
        { id: "state", label: "State", href: "#state" },
        { id: "raw", label: "Raw", href: "#raw" },
      ],
      "state",
      [
        section(
          "Customers",
          table(
            ["ID", "Email", "Name", "Status"],
            [
              ["cus_1", "alice@gmail.com", "Alice Liddell", chip("active")],
              ["cus_2", "bob@example.com", "Bob Marley", chip("deleted")],
            ],
            "No customers.",
          ),
        ),
        section("Invoices", table(["ID", "Amount"], [], "No invoices.")),
        section("Last request", {
          type: "json",
          label: "POST /v1/customers",
          value: { method: "POST", path: "/v1/customers", status: 200 },
        }),
      ],
      "Example",
    ),
  { play: shows("alice@gmail.com") },
)

/**
 * The page that posts a response back to the app (`response_mode=form_post`). It submits itself
 * on load; here that is turned off, so it stays on screen.
 */
export const FormPostRedirect: StoryObj = markup(
  () =>
    renderProviderPage({
      ...formPostPage("#", { code: "c0de", state: "xyz", id_token: "eyJhbGciOi…" }, "Apple"),
      autoSubmit: false,
    }),
  { play: shows("Redirecting") },
)

export const CardOnAPhone: StoryObj = {
  ...CardWithAccounts,
  globals: { viewport: { value: "phone", isRotated: false } },
}

export const InspectorOnAPhone: StoryObj = {
  ...InspectorPage,
  globals: { viewport: { value: "phone", isRotated: false } },
}
