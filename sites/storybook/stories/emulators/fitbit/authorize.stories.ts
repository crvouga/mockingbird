import { createRuntime } from "@crvouga/mockingbird-service-fitbit"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * The OAuth consent page (`/oauth2/authorize`) served in place of www.fitbit.com's. It shows no
 * consent screen: the emulator's consent setting answers at once with a redirect to the app. What a
 * person sees are the pages for a request that cannot be redirected back to the app at all.
 */
export default {
  title: "Emulators/Fitbit/Authorize",
  parameters: { layout: "fullscreen", sources: ["packages/service/fitbit/src/index.ts"] },
} satisfies Meta

const ORIGIN = "https://www.fitbit.com"

/** An authorize request from `client_id` asking to come back to `redirect_uri`. */
const authorize = (query: Record<string, string>) =>
  page(() => ({
    emulator: createRuntime({
      clients: [
        {
          id: "mock_client",
          secret: "mock_client_secret",
          redirectUris: ["https://app.example/fitbit/callback"],
        },
        { id: "open_client", secret: "open_client_secret" },
      ],
    }),
    url: `${ORIGIN}/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      scope: "activity sleep profile",
      state: "xyz",
      ...query,
    })}`,
  }))

/** A `client_id` that no application is registered under. */
export const UnknownClient: StoryObj = authorize({
  client_id: "not_a_client",
  redirect_uri: "https://app.example/fitbit/callback",
})

/** A `redirect_uri` the application did not register. */
export const RedirectMismatch: StoryObj = authorize({
  client_id: "mock_client",
  redirect_uri: "https://evil.example/callback",
})

/** A `redirect_uri` that is not a URL. */
export const RedirectNotAUrl: StoryObj = authorize({
  client_id: "open_client",
  redirect_uri: "callback",
})
