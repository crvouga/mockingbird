import { createRuntime } from "@crvouga/mockingbird-service-slack"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { page } from "../../../src/story.js"
import { CALLBACK, pickAccount, query } from "../oauth/browser.js"

/**
 * Slack's OAuth v2 authorize page (`/oauth/v2/authorize`, "Add to Slack"): one button per member
 * of the workspace. Picking one answers with a redirect to the app's callback, where the story
 * stops. With no app registered any `client_id` is accepted.
 */
export default {
  title: "Emulators/Slack/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/slack/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://slack.mock"
const CLIENT_ID = "1234567890.storybook"

const slack = (registered = true) =>
  createRuntime({
    fixtures: {
      users: [{ name: "ada", real_name: "Ada Lovelace", email: "ada@example.test" }],
      ...(registered
        ? {
            oauth_apps: [
              {
                client_id: CLIENT_ID,
                client_secret: "storybook-secret",
                name: "Standup Bot",
                redirect_uris: [CALLBACK],
              },
            ],
          }
        : {}),
    },
  })

const visit = (params: Record<string, string> = {}, registered = true) =>
  page(() => ({
    emulator: slack(registered),
    url: `${ORIGIN}/oauth/v2/authorize?${query({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      scope: "chat:write channels:read",
      user_scope: "identity.basic",
      state: "story-state",
      ...params,
    })}`,
  }))

export const AuthorizeApp: StoryObj = visit()

/** No app registered: the page names no app. */
export const NoAppRegistered: StoryObj = visit({}, false)

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Picking a member: back to the app's callback with a code and the app's state. */
export const Authorized: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "Ada Lovelace")
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
    expect(callback.searchParams.get("state")).toBe("story-state")
  },
}

export const UnknownApp: StoryObj = visit({ client_id: "0000000000.unknown" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
