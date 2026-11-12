import { createRuntime } from "@crvouga/mockingbird-service-google"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { page } from "../../../src/story.js"
import { CALLBACK, pickAccount, query } from "../oauth/browser.js"

/**
 * Google's sign-in page (`/o/oauth2/v2/auth`) as the Google emulator serves it: one button per
 * seeded user. Picking one answers with a redirect to the app's callback, where the story stops.
 * With no OAuth client registered any `client_id` is accepted.
 */
export default {
  title: "Emulators/Google/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/google/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://accounts.google.mock"
const CLIENT_ID = "storybook.apps.googleusercontent.com"

const google = (registered = true) =>
  createRuntime({
    fixtures: {
      users: [{ email: "ada@example.test", name: "Ada Lovelace" }],
      ...(registered
        ? {
            oauth_clients: [
              {
                client_id: CLIENT_ID,
                client_secret: "storybook-secret",
                name: "Acme Notes",
                redirect_uris: [CALLBACK],
              },
            ],
          }
        : {}),
    },
  })

const visit = (params: Record<string, string> = {}, registered = true) =>
  page(() => ({
    emulator: google(registered),
    url: `${ORIGIN}/o/oauth2/v2/auth?${query({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: "openid email profile",
      state: "story-state",
      ...params,
    })}`,
  }))

export const ChooseAnAccount: StoryObj = visit()

/** No OAuth client registered: the page names no app. */
export const NoClientRegistered: StoryObj = visit({}, false)

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Picking an account: back to the app's callback with a code and the app's state. */
export const SignedIn: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "ada@example.test")
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
    expect(callback.searchParams.get("state")).toBe("story-state")
  },
}

export const UnknownClient: StoryObj = visit({ client_id: "unknown.apps.googleusercontent.com" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
