import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { page } from "../../../src/story.js"
import { CALLBACK, pickAccount, query } from "../oauth/browser.js"
import { CLIENT_ID, github, ORIGIN } from "./github.js"

/**
 * GitHub's OAuth authorize page (`/login/oauth/authorize`): one button per seeded user, standing
 * in for GitHub's sign-in and authorization. Picking one answers with a redirect to the app's
 * callback, where the story stops. With no OAuth app registered any `client_id` is accepted.
 */
export default {
  title: "Emulators/GitHub/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/github/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const authorize = (params: Record<string, string> = {}) =>
  `${ORIGIN}/login/oauth/authorize?${query({
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    scope: "read:user user:email",
    state: "story-state",
    ...params,
  })}`

const visit = (params: Record<string, string> = {}, registered = true) =>
  page(() => ({ emulator: github({ registered }).emulator, url: authorize(params) }))

export const AuthorizeApp: StoryObj = visit()

/** No OAuth app registered: the page names no app. */
export const NoAppRegistered: StoryObj = visit({ client_id: "Iv1.anything" }, false)

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Picking a user: back to the app's callback with a code and the app's state. */
export const Authorized: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "octocat")
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
    expect(callback.searchParams.get("state")).toBe("story-state")
  },
}

export const UnknownApp: StoryObj = visit({ client_id: "Iv1.unknown" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
