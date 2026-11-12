import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"
import { press, shows } from "../oauth/browser.js"
import { CLIENT_ID, github, ORIGIN } from "./github.js"

/**
 * GitHub's settings for the OAuth apps a user has authorized (`/settings/applications`) and one
 * app's grant, with its Revoke button. The user authorizes the app through the emulator's OAuth
 * flow first; the browser then carries that session (as a bearer token: browsers keep `Cookie`
 * out of a story's requests).
 */
export default {
  title: "Emulators/GitHub/Authorized apps",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/github/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const signedIn = (path: string) =>
  page(async () => ({ emulator: await github().authorize(), url: `${ORIGIN}${path}` }))

export const AuthorizedApps: StoryObj = signedIn("/settings/applications")

export const AppGrant: StoryObj = signedIn(`/settings/connections/applications/${CLIENT_ID}`)

export const AppGrantOnAPhone: StoryObj = {
  ...signedIn(`/settings/connections/applications/${CLIENT_ID}`),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** From the list to the grant, then Revoke access: back to an empty list. */
export const Revoked: StoryObj = {
  ...signedIn("/settings/applications"),
  play: async ({ canvasElement }) => {
    await press(canvasElement, "Acme CI", "a.app-link")
    await press(canvasElement, "Revoke access")
    await shows(canvasElement, "No authorized applications.")
  },
}

/** An app the user never authorized. */
export const NoGrant: StoryObj = signedIn("/settings/connections/applications/Iv1.never-authorized")

/** Opened without a session. */
export const SignedOut: StoryObj = page(() => ({
  emulator: github().emulator,
  url: `${ORIGIN}/settings/applications`,
}))
