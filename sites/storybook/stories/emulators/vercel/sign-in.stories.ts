import { createRuntime } from "@crvouga/mockingbird-service-vercel"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { expect } from "storybook/test"
import { page } from "../../../src/story.js"
import { CALLBACK, pickAccount, query } from "../oauth/browser.js"

/**
 * Vercel's integration authorize page (`/oauth/authorize`): one button per seeded user. Picking
 * one answers with a redirect to the integration's callback, where the story stops. With no
 * integration registered any `client_id` is accepted.
 */
export default {
  title: "Emulators/Vercel/Sign in",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/http/provider/src/vendor/vercel/routes/oauth.ts",
      "packages/http/provider/src/vendor/core/ui.ts",
    ],
  },
} satisfies Meta

const ORIGIN = "https://vercel.mock"
const CLIENT_ID = "oac_storybook"

const vercel = (registered = true) =>
  createRuntime({
    fixtures: {
      users: [{ username: "ada", email: "ada@example.test", name: "Ada Lovelace" }],
      ...(registered
        ? {
            integrations: [
              {
                client_id: CLIENT_ID,
                client_secret: "storybook-secret",
                name: "Acme Deploys",
                redirect_uris: [CALLBACK],
              },
            ],
          }
        : {}),
    },
  })

const visit = (params: Record<string, string> = {}, registered = true) =>
  page(() => ({
    emulator: vercel(registered),
    url: `${ORIGIN}/oauth/authorize?${query({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      state: "story-state",
      ...params,
    })}`,
  }))

export const AuthorizeIntegration: StoryObj = visit()

/** No integration registered: the page names none. */
export const NoIntegrationRegistered: StoryObj = visit({}, false)

export const OnAPhone: StoryObj = {
  ...visit(),
  globals: { viewport: { value: "phone", isRotated: false } },
}

/** Picking a user: back to the integration's callback with a code and its state. */
export const Authorized: StoryObj = {
  ...visit(),
  play: async ({ canvasElement }) => {
    const callback = await pickAccount(canvasElement, "Ada Lovelace")
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK)
    expect(callback.searchParams.get("code")).toBeTruthy()
    expect(callback.searchParams.get("state")).toBe("story-state")
  },
}

export const UnknownIntegration: StoryObj = visit({ client_id: "oac_unknown" })

export const RedirectMismatch: StoryObj = visit({
  redirect_uri: "https://elsewhere.example/callback",
})
