/**
 * The OAuth emulator (one identity provider: Google, Apple, Microsoft, GitHub or plain OIDC) in
 * the browser, and the admin calls the stories make to put it in the state a page shows: the app
 * registered as a client, and the test accounts the chooser offers.
 */
import { createRuntime, type Provider } from "@crvouga/mockingbird-service-oauth"
import { CALLBACK, holdFormPosts, query } from "./browser.js"

/** The origin the emulator believes it is served from. */
export const ORIGIN = "https://accounts.oauth.mock"
export const CLIENT_ID = "storybook-app"

/** Where each profile's authorization endpoint lives, as its real provider names it. */
const AUTHORIZE: Record<Provider, string> = {
  google: "/o/oauth2/v2/auth",
  apple: "/auth/authorize",
  microsoft: "/oauth2/v2.0/authorize",
  github: "/login/oauth/authorize",
  oidc: "/authorize",
}

/** The scopes each profile's sign-in asks for. */
const SCOPE: Record<Provider, string> = {
  google: "openid email profile",
  apple: "openid email name",
  microsoft: "openid email profile offline_access",
  github: "read:user user:email",
  oidc: "openid email profile offline_access",
}

export const ADA = { id: "ada", email: "ada@example.test", name: "Ada Lovelace" }
export const GRACE = { id: "grace", email: "grace@example.test", name: "Grace Hopper" }

export function oauth(provider: Provider = "google") {
  const runtime = createRuntime({ provider })
  const admin = async (method: string, path: string, body?: unknown) => {
    const response = await runtime.fetch(
      new Request(`${ORIGIN}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    if (!response.ok) throw new Error(`${method} ${path}: ${await response.text()}`)
    return response.json()
  }
  return {
    /** Apple answers in `form_post`; the page stays put instead of leaving on load. */
    emulator: holdFormPosts(runtime),
    admin,
    client: () =>
      admin("POST", "/clients", {
        id: CLIENT_ID,
        name: "Acme Notes",
        redirectUris: [CALLBACK],
        secret: "storybook-secret",
      }),
    account: (account: { id: string; email: string; name: string; disabled?: boolean }) =>
      admin("POST", "/accounts", account),
    /** The chosen profile's authorization URL, as the app's sign-in button links to it. */
    authorize: (params: Record<string, string> = {}) =>
      `${ORIGIN}${AUTHORIZE[provider]}?${query({
        client_id: CLIENT_ID,
        redirect_uri: CALLBACK,
        response_type: "code",
        scope: SCOPE[provider],
        state: "story-state",
        ...(provider === "apple" ? { response_mode: "form_post" } : {}),
        ...params,
      })}`,
  }
}

/** A provider with the app registered and two accounts, opened on its authorization URL. */
export async function signIn(provider: Provider = "google", params: Record<string, string> = {}) {
  const o = oauth(provider)
  await o.client()
  await o.account(ADA)
  await o.account(GRACE)
  return { ...o, url: o.authorize(params) }
}
