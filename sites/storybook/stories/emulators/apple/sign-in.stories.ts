import { createRuntime } from "@crvouga/mockingbird-service-apple"
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
 * Sign in with Apple (`/auth/authorize`) as the Apple emulator serves it: one button per seeded
 * Apple ID. Asking for `name email` makes Apple answer in `form_post`, a "Redirecting…" page
 * that posts the code (and, the first time, the user's name) on to the app; the story holds it on
 * screen. In `query` mode the answer is a redirect, where the story stops.
 */
export default {
  title: "Emulators/Apple/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/apple/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://appleid.apple.mock"
const CLIENT_ID = "com.example.notes.web"

const apple = (registered = true) =>
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
                  team_id: "TEAMID1234",
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
    emulator: apple(registered),
    url: `${ORIGIN}/auth/authorize?${query({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      response_type: "code",
      response_mode: "form_post",
      scope: "name email",
      state: "story-state",
      ...params,
    })}`,
  }))

export const ChooseAnAppleId: StoryObj = visit()

/** No Services ID registered: the page names no app. */
export const NoClientRegistered: StoryObj = visit({}, false)

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** `form_post`: the page that posts the code and the user's name on to the app. */
export const Redirecting: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const page = await pickAccountFormPost(canvasElement, "ada@example.test")
    expect(page.doc.querySelector<HTMLInputElement>('input[name="user"]')?.value).toContain("Ada")
  },
}

/** `query` mode, no name or email asked for: straight back to the app with a code. */
export const SignedIn: StoryObj = {
  ...visit({ response_mode: "query", scope: "" }),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "ada@example.test")
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
  },
}

export const UnknownClient: StoryObj = visit({ client_id: "com.example.unknown" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
