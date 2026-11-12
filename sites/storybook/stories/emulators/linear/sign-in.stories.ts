import { createRuntime } from "@crvouga/mockingbird-service-linear"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { page } from "../../../src/story.js"
import { CALLBACK, pickAccount, query } from "../oauth/browser.js"

/**
 * Linear's OAuth authorize page (`/oauth/authorize`). As a user (`actor=user`) it lists the
 * workspace's members; as an app (`actor=app`) it offers to install the app itself. Either
 * answers with a redirect to the app's callback, where the story stops.
 */
export default {
  title: "Emulators/Linear/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/linear/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://linear.mock"
/** An app that acts as the person who authorizes it, and one that acts as itself. */
const USER_APP = "storybook-user-app"
const AGENT_APP = "storybook-agent-app"

const linear = () =>
  createRuntime({
    fixtures: {
      users: [{ email: "ada@example.test", name: "Ada Lovelace", display_name: "ada" }],
      oauth_apps: [
        {
          client_id: USER_APP,
          client_secret: "storybook-secret",
          name: "Acme Sync",
          redirect_uris: [CALLBACK],
          scopes: ["read", "write"],
          actor: "user",
        },
        {
          client_id: AGENT_APP,
          client_secret: "storybook-secret",
          name: "Acme Agent",
          redirect_uris: [CALLBACK],
          scopes: ["read", "write", "app:assignable"],
          actor: "app",
        },
      ],
    },
  })

const visit = (params: Record<string, string> = {}) =>
  page(() => ({
    emulator: linear(),
    url: `${ORIGIN}/oauth/authorize?${query({
      client_id: USER_APP,
      redirect_uri: CALLBACK,
      response_type: "code",
      scope: "read write",
      state: "story-state",
      ...params,
    })}`,
  }))

const install = { client_id: AGENT_APP, actor: "app", scope: "read write app:assignable" }

export const AuthorizeAsUser: StoryObj = visit()

/** `actor=app`: the app installs into the workspace as an actor of its own. */
export const InstallApp: StoryObj = visit(install)

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Picking a member: back to the app's callback with a code and the app's state. */
export const Authorized: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "ada@example.test")
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
    expect(callback.searchParams.get("state")).toBe("story-state")
  },
}

export const Installed: StoryObj = {
  ...visit(install),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "Install Acme Agent")
    expect(callback.searchParams.get("code")).toBeTruthy()
  },
}

/** `actor=app` for an app registered to act as its users. */
export const InvalidActor: StoryObj = visit({ actor: "app" })

/** A scope the app is not registered for. */
export const InvalidScope: StoryObj = visit({ scope: "read admin" })

/** Anything but `response_type=code`. */
export const UnsupportedResponseType: StoryObj = visit({ response_type: "token" })

export const MissingRedirectUri: StoryObj = visit({ redirect_uri: "" })

export const UnknownApp: StoryObj = visit({ client_id: "unknown-app" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
