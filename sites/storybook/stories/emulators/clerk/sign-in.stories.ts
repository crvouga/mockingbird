import { createRuntime } from "@crvouga/mockingbird-service-clerk"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { page } from "../../../src/story.js"
import { CALLBACK, pickAccount, query } from "../oauth/browser.js"

/**
 * Clerk as an OAuth provider (`/oauth/authorize`): one button per user of the Clerk instance.
 * Picking one answers with a redirect to the OAuth application's callback, where the story
 * stops. The instance always has its sample application, so a `client_id` must be registered.
 */
export default {
  title: "Emulators/Clerk/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/clerk/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://clerk.mock"
const CLIENT_ID = "storybook_oauth_app"

const clerk = () =>
  createRuntime({
    fixtures: {
      users: [{ email_addresses: ["ada@example.test"], first_name: "Ada", last_name: "Lovelace" }],
      oauth_applications: [
        {
          client_id: CLIENT_ID,
          client_secret: "storybook-secret",
          name: "Acme Notes",
          redirect_uris: [CALLBACK],
        },
      ],
    },
  })

const visit = (params: Record<string, string> = {}) =>
  page(() => ({
    emulator: clerk(),
    url: `${ORIGIN}/oauth/authorize?${query({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: "openid profile email",
      state: "story-state",
      ...params,
    })}`,
  }))

export const ChooseAUser: StoryObj = visit()

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Picking a user: back to the app's callback with a code and the app's state. */
export const SignedIn: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "ada@example.test")
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
    expect(callback.searchParams.get("state")).toBe("story-state")
  },
}

/** Anything but `response_type=code`. */
export const UnsupportedResponseType: StoryObj = visit({ response_type: "token" })

export const MissingRedirectUri: StoryObj = visit({ redirect_uri: "" })

export const UnknownApplication: StoryObj = visit({ client_id: "unknown_oauth_app" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
