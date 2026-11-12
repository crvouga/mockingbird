import { createRuntime } from "@crvouga/mockingbird-service-okta"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { page } from "../../../src/story.js"
import {
  CALLBACK,
  holdFormPosts,
  pickAccount,
  pickAccountFormPost,
  query,
} from "../oauth/browser.js"

/**
 * Okta's sign-in page (`/oauth2/{authServerId}/v1/authorize`, or `/oauth2/v1/authorize` for the
 * org authorization server): one button per user in the org. Picking one answers with a redirect
 * to the app's callback, where the story stops, or with `response_mode=form_post` a
 * "Redirecting…" page that posts the code on (held on screen here).
 */
export default {
  title: "Emulators/Okta/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/okta/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://example.okta.mock"
const CLIENT_ID = "0oastorybook"

const okta = () =>
  holdFormPosts(
    createRuntime({
      fixtures: {
        users: [
          {
            login: "ada@example.test",
            email: "ada@example.test",
            first_name: "Ada",
            last_name: "Lovelace",
          },
        ],
        oauth_clients: [
          {
            client_id: CLIENT_ID,
            client_secret: "storybook-secret",
            name: "Acme Notes",
            redirect_uris: [CALLBACK],
            auth_server_id: "default",
          },
        ],
      },
    }),
  )

const visit = (params: Record<string, string> = {}, server = "default") =>
  page(() => ({
    emulator: okta(),
    url: `${ORIGIN}/oauth2/${server === "org" ? "" : `${server}/`}v1/authorize?${query({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: "openid profile email",
      state: "story-state",
      ...params,
    })}`,
  }))

/** The `default` custom authorization server, where the app is registered. */
export const SignIn: StoryObj = visit()

/** The org authorization server, with no app registered on it: the page names no app. */
export const OrgAuthorizationServer: StoryObj = visit({}, "org")

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Picking a user: back to the app's callback with a code and the app's state. */
export const SignedIn: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "Ada Lovelace")
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
    expect(callback.searchParams.get("state")).toBe("story-state")
  },
}

/** `response_mode=form_post`: the page that posts the code on to the app. */
export const Redirecting: StoryObj = {
  ...visit({ response_mode: "form_post" }),
  play: async ({ canvasElement }) => {
    await pickAccountFormPost(canvasElement, "Ada Lovelace")
  },
}

/** Anything but `response_type=code`. */
export const UnsupportedResponseType: StoryObj = visit({ response_type: "token" })

export const MissingRedirectUri: StoryObj = visit({ redirect_uri: "" })

export const UnknownClient: StoryObj = visit({ client_id: "0oaunknown" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
