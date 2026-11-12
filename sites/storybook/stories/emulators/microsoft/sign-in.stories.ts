import { createRuntime } from "@crvouga/mockingbird-service-microsoft"
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
 * The Microsoft identity platform's sign-in page (`/oauth2/v2.0/authorize`) as the Microsoft
 * emulator serves it: one button per seeded account. Picking one answers with a redirect to the
 * app's callback, where the story stops, or with `response_mode=form_post` a "Redirecting…" page
 * that posts the code on (held on screen here).
 */
export default {
  title: "Emulators/Microsoft/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/microsoft/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://login.microsoftonline.mock"
const CLIENT_ID = "00000000-0000-4000-8000-00000000c11e"

const microsoft = (registered = true) =>
  holdFormPosts(
    createRuntime({
      fixtures: {
        users: [
          {
            email: "ada@example.test",
            name: "Ada Lovelace",
            given_name: "Ada",
            family_name: "Lovelace",
          },
        ],
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
    }),
  )

const visit = (params: Record<string, string> = {}, registered = true) =>
  page(() => ({
    emulator: microsoft(registered),
    url: `${ORIGIN}/oauth2/v2.0/authorize?${query({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: "openid email profile offline_access",
      state: "story-state",
      ...params,
    })}`,
  }))

export const PickAnAccount: StoryObj = visit()

/** No app registration: the page names no app. */
export const NoAppRegistered: StoryObj = visit({}, false)

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

/** `response_mode=form_post`: the page that posts the code on to the app. */
export const Redirecting: StoryObj = {
  ...visit({ response_mode: "form_post" }),
  play: async ({ canvasElement }) => {
    await pickAccountFormPost(canvasElement, "ada@example.test")
  },
}

export const UnknownApp: StoryObj = visit({ client_id: "00000000-0000-4000-8000-000000000000" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
