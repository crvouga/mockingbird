import { type Context, Hono } from "hono"
import * as oauth from "oauth4webapi"
import { type BehaviorInput, OAuthAPI, type Provider } from "../../src/index.js"
import { type AppUser, appPage } from "./page.js"
import { COOKIE_HEADERS, ORIGIN_HEADER } from "./transport.js"

export const APP = "https://app.example.test"
export const IDENTITY = "https://accounts.example.test"
export type Trace = { sequence: number; actor: string; method: string; url: string; status: number }
type Identity = AppUser
const callback = `${APP}/auth/callback`
const client = { client_id: "example-app" }
const secret = "example-only-client-secret"
export type ExampleProvider = Extract<Provider, "google" | "apple" | "microsoft" | "github">

/** A complete application server. Every outbound OAuth request uses the local dispatcher. */
export function createExample(
  behavior: BehaviorInput = {},
  onTrace: (entry: Trace) => void = () => {},
  providerProfile: ExampleProvider = "google",
) {
  const provider = new OAuthAPI({
    provider: providerProfile,
    cookieHeaders: COOKIE_HEADERS,
    issuer: IDENTITY,
    behavior,
    accounts: [
      {
        id: "ada",
        name: "Ada Lovelace",
        email: "ada@example.test",
        github: {
          id: 101,
          login: "ada",
          publicEmail: null,
          emails: [
            {
              email: "ada@example.test",
              primary: true,
              verified: true,
              visibility: "private",
            },
          ],
        },
      },
      {
        id: "grace",
        name: "Grace Hopper",
        email: "grace@example.test",
        github: {
          id: 102,
          login: "grace",
          publicEmail: "grace@example.test",
          emails: [
            {
              email: "grace@example.test",
              primary: true,
              verified: true,
              visibility: "public",
            },
          ],
        },
      },
    ],
    clients: [
      {
        id: client.client_id,
        name: "Example app",
        secret,
        redirectUris: [callback],
        requirePkce: true,
      },
    ],
  })
  const preferences = { reuseLastAccount: false }
  const app = new Hono()
  const pending = new Map<
    string,
    { state: string; nonce: string; verifier: string; expires: number }
  >()
  const sessions = new Map<string, { user: Identity; expires: number }>()
  let sequence = 0
  async function dispatch(request: Request, actor = "Browser"): Promise<Response> {
    const url = new URL(request.url)
    if (![APP, IDENTITY].includes(url.origin))
      throw new Error("This example only routes its two in-process origins.")
    const id = ++sequence
    const response = await (url.origin === APP ? app.fetch(request) : provider.fetch(request))
    onTrace({
      sequence: id,
      actor,
      method: request.method,
      url: `${url.host}${url.pathname}`,
      status: response.status,
    })
    return response
  }
  const options = {
    [oauth.customFetch]: (
      input: string,
      init: oauth.CustomFetchOptions<string, URLSearchParams | undefined>,
    ) =>
      dispatch(
        new Request(input, {
          method: init.method,
          headers: init.headers,
          ...(init.body ? { body: init.body } : {}),
        }),
        "Hono server",
      ),
  }
  let discovery: Promise<oauth.AuthorizationServer> | undefined
  const metadata = () =>
    (discovery ??=
      providerProfile === "github"
        ? Promise.resolve({
            issuer: IDENTITY,
            authorization_endpoint: `${IDENTITY}/login/oauth/authorize`,
            token_endpoint: `${IDENTITY}/login/oauth/access_token`,
            userinfo_endpoint: `${IDENTITY}/user`,
          })
        : oauth
            .discoveryRequest(new URL(IDENTITY), options)
            .then((response) => oauth.processDiscoveryResponse(new URL(IDENTITY), response)))
  const current = (cookie: string | undefined) => {
    const session = cookie ? sessions.get(cookie) : undefined
    return session && session.expires > Date.now() ? session.user : undefined
  }
  app.get("/", (c) => c.html(appPage(current(cookie(c, "session")))))
  app.get("/api/session", (c) => c.json({ user: current(cookie(c, "session")) ?? null }))
  app.get("/auth/start", async (c) => {
    const as = await metadata()
    const state = oauth.generateRandomState()
    const nonce = oauth.generateRandomNonce()
    const verifier = oauth.generateRandomCodeVerifier()
    const key = crypto.randomUUID()
    for (const [id, value] of pending) if (value.expires < Date.now()) pending.delete(id)
    pending.set(key, { state, nonce, verifier, expires: Date.now() + 600_000 })
    setCookie(c, "login", key, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    })
    const url = new URL(as.authorization_endpoint ?? "")
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: callback,
      response_type: "code",
      ...(!preferences.reuseLastAccount ? { prompt: "select_account" } : {}),
      scope:
        providerProfile === "apple"
          ? "openid email name"
          : providerProfile === "github"
            ? "read:user user:email"
            : "openid email profile",
      ...(providerProfile === "apple" ? { response_mode: "form_post" } : {}),
      state,
      nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    }).toString()
    return c.redirect(url.href)
  })
  const callbackHandler = async (c: Context) => {
    const key = cookie(c, "login") ?? ""
    const transaction = pending.get(key)
    pending.delete(key)
    deleteCookie(c, "login", { path: "/" })
    try {
      if (!transaction || transaction.expires < Date.now()) throw new Error("Login expired")
      const as = await metadata()
      const callbackUrl = new URL(c.req.url)
      let appleUser: { name?: { firstName?: string; lastName?: string }; email?: string } = {}
      if (c.req.method === "POST") {
        const form = new URLSearchParams(await c.req.text())
        for (const name of ["code", "state", "error", "error_description"])
          if (form.has(name)) callbackUrl.searchParams.set(name, form.get(name) ?? "")
        try {
          appleUser = JSON.parse(form.get("user") ?? "{}")
        } catch {
          appleUser = {}
        }
      }
      const params = oauth.validateAuthResponse(as, client, callbackUrl, transaction.state)
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        oauth.ClientSecretPost(secret),
        params,
        callback,
        transaction.verifier,
        options,
      )
      const tokens = await oauth.processAuthorizationCodeResponse(
        as,
        client,
        response,
        providerProfile === "github"
          ? { requireIdToken: false }
          : { expectedNonce: transaction.nonce, requireIdToken: true },
      )
      if (providerProfile !== "github")
        await oauth.validateApplicationLevelSignature(as, response, options)
      const claims =
        providerProfile === "github" ? undefined : oauth.getValidatedIdTokenClaims(tokens)
      const user: Identity =
        providerProfile === "github"
          ? await githubIdentity(as, tokens.access_token)
          : providerProfile === "apple" && claims
            ? {
                sub: claims.sub,
                ...(typeof claims.email === "string" ? { email: claims.email } : {}),
                ...(appleUser.name
                  ? {
                      name: [appleUser.name.firstName, appleUser.name.lastName]
                        .filter(Boolean)
                        .join(" "),
                    }
                  : {}),
              }
            : claims
              ? await oauth.processUserInfoResponse(
                  as,
                  client,
                  claims.sub,
                  await oauth.userInfoRequest(as, client, tokens.access_token, options),
                )
              : (() => {
                  throw new Error("Missing identity")
                })()
      const session = crypto.randomUUID()
      sessions.set(session, {
        user: {
          sub: user.sub,
          ...(typeof user.name === "string" ? { name: user.name } : {}),
          ...(typeof user.email === "string" ? { email: user.email } : {}),
        },
        expires: Date.now() + 3600_000,
      })
      setCookie(c, "session", session, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 3600,
      })
      return c.redirect("/")
    } catch {
      return c.html(
        appPage(
          undefined,
          "Sign-in could not be completed. Permission may have been declined, the provider may be unavailable, or the login may have expired. You can safely try again.",
        ),
        400,
      )
    }
  }

  async function githubIdentity(as: oauth.AuthorizationServer, accessToken: string) {
    const profileResponse = await oauth.userInfoRequest(as, client, accessToken, options)
    if (!profileResponse.ok) throw new Error("GitHub profile request failed")
    const profile = (await profileResponse.json()) as {
      id?: number
      name?: string | null
      login?: string
      email?: string | null
    }
    if (!Number.isSafeInteger(profile.id)) throw new Error("GitHub profile has no stable ID")
    let email = profile.email ?? undefined
    if (!email) {
      const emailResponse = await dispatch(
        new Request(`${IDENTITY}/user/emails`, {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
        "Hono server",
      )
      const emails = emailResponse.ok
        ? ((await emailResponse.json()) as { email: string; primary: boolean; verified: boolean }[])
        : []
      email = emails.find((item) => item.primary && item.verified)?.email
    }
    return {
      sub: String(profile.id),
      ...(profile.name || profile.login ? { name: profile.name ?? profile.login } : {}),
      ...(email ? { email } : {}),
    }
  }
  app.get("/auth/callback", callbackHandler)
  app.post("/auth/callback", callbackHandler)
  app.post("/auth/logout", (c) => {
    if (c.req.header(ORIGIN_HEADER) !== APP) return c.text("Invalid origin", 403)
    sessions.delete(cookie(c, "session") ?? "")
    deleteCookie(c, "session", { path: "/" })
    return c.redirect("/", 303)
  })
  return { dispatch, app, provider, preferences, providerProfile }
}

// Explicit local cookie envelope: browser Fetch strips native Cookie/Set-Cookie headers.
// The envelope is only used by this example's allowlisted in-process dispatcher.
function cookie(c: Context, name: string) {
  return c.req
    .header(COOKIE_HEADERS.request)
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}
function setCookie(
  c: Context,
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean; secure: boolean; sameSite: string; path: string },
) {
  c.header(
    COOKIE_HEADERS.response,
    `${name}=${value}; Path=${options.path}; HttpOnly; Secure; SameSite=${options.sameSite}; Max-Age=${options.maxAge}`,
    { append: true },
  )
}
function deleteCookie(c: Context, name: string, options: { path: string }) {
  c.header(COOKIE_HEADERS.response, `${name}=; Path=${options.path}; Max-Age=0`, { append: true })
}
