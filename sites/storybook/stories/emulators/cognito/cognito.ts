/**
 * A Cognito user pool in the browser, and the admin calls the hosted-UI stories make to put it in
 * the state a page shows: an app client with its callback URL, and the pool's users.
 */
import { createRuntime } from "@crvouga/mockingbird-service-cognito"
import { CALLBACK, query } from "../oauth/browser.js"

/** The origin the emulator believes it is served from (the pool's hosted-UI domain). */
export const ORIGIN = "https://auth.cognito.mock"
export const CLIENT_ID = "storybook-web"

type User = { username: string; email?: string; confirmed?: boolean; enabled?: boolean }

export function cognito() {
  const emulator = createRuntime()
  const admin = async (path: string, body: unknown) => {
    const response = await emulator.fetch(
      new Request(`${ORIGIN}/__admin${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    if (!response.ok) throw new Error(`POST ${path}: ${await response.text()}`)
    return response.json()
  }
  return {
    emulator,
    admin,
    /** The app client the hosted UI signs in for, offering the pool and Google. */
    client: () =>
      admin("/app-clients", {
        clientId: CLIENT_ID,
        callbackUrls: [CALLBACK],
        identityProviders: ["COGNITO", "Google"],
      }),
    user: ({ username, email, confirmed = true, enabled = true }: User) =>
      admin("/users", {
        username,
        password: "Synthetic-Passw0rd",
        confirmed,
        enabled,
        attributes: email
          ? [
              { Name: "email", Value: email },
              { Name: "email_verified", Value: "true" },
            ]
          : [],
      }),
    /** `/oauth2/authorize` for the app client, as the app's sign-in button links to it. */
    authorize: (params: Record<string, string> = {}) =>
      `${ORIGIN}/oauth2/authorize?${query({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK,
        scope: "openid email profile",
        state: "story-state",
        ...params,
      })}`,
  }
}
