import { OAuthAPI } from "@crvouga/mockingbird-service-oauth"
import * as oauth from "oauth4webapi"
import type { HostedFlowStep } from "../../app/ports/hostedFlow.js"
import type {
  IdentityProfile,
  IdentityProvider,
  IdentityProviderKey,
} from "../../app/ports/identityProvider.js"

type ClientConfig = { clientId: string; clientSecret: string; issuer: string; scope: string }

// Fake issuer origins and a fake redirect_uri — never resolved over a real
// network. Requests to them are always dispatched straight into an
// in-process `OAuthAPI.fetch` below; a `.fetch(request)` call *is* the
// in-process, no-socket call, the same pattern this repo uses for payments
// and lab testing.
const CLIENTS: Record<IdentityProviderKey, ClientConfig> = {
  google: {
    clientId: "cove-web",
    clientSecret: "cove-oauth-demo-secret",
    issuer: "https://accounts.google.mockingbird.internal",
    scope: "openid email profile",
  },
  apple: {
    clientId: "cove-web",
    clientSecret: "cove-oauth-demo-secret",
    issuer: "https://appleid.apple.mockingbird.internal",
    scope: "openid email name",
  },
}
const REDIRECT_URI = (provider: IdentityProviderKey) =>
  `https://cove.mockingbird.internal/auth/callback/${provider}`

type PendingFlow = {
  provider: IdentityProviderKey
  state: string
  nonce: string
  verifier: string
  as: oauth.AuthorizationServer
  redirectUri: string
  expires: number
}

/** Builds one branded provider mock per key, seeded with a single demo account. */
const createProviderApis = (): Record<IdentityProviderKey, OAuthAPI> => {
  const client = (provider: IdentityProviderKey) => {
    const config = CLIENTS[provider]
    return {
      id: config.clientId,
      name: "Cove",
      secret: config.clientSecret,
      redirectUris: [REDIRECT_URI(provider)],
      requirePkce: true,
    }
  }
  return {
    google: new OAuthAPI({
      provider: "google",
      issuer: CLIENTS.google.issuer,
      accounts: [
        {
          id: "ada",
          name: "Ada Lovelace",
          email: "ada@example.test",
          emailVerified: true,
          givenName: "Ada",
          familyName: "Lovelace",
          picture: "https://api.dicebear.com/9.x/notionists/svg?seed=ada",
        },
      ],
      clients: [client("google")],
    }),
    apple: new OAuthAPI({
      provider: "apple",
      issuer: CLIENTS.apple.issuer,
      accounts: [
        { id: "grace", name: "Grace Hopper", email: "grace@example.test", emailVerified: true },
      ],
      clients: [client("apple")],
    }),
  }
}

const dispatchFor =
  (api: OAuthAPI) =>
  (
    input: string | URL,
    init?: oauth.CustomFetchOptions<string, URLSearchParams | undefined> | RequestInit,
  ): Promise<Response> => {
    const requestInit: RequestInit = {}
    if (init?.method) requestInit.method = init.method
    if (init?.headers) requestInit.headers = init.headers
    const body = (init as { body?: BodyInit } | undefined)?.body
    if (body !== undefined) requestInit.body = body
    return api.fetch(new Request(input, requestInit))
  }

const isRedirectUri = (url: URL, redirectUri: string): boolean =>
  `${url.origin}${url.pathname}` === redirectUri

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const extractFormAction = (html: string): string | undefined => {
  const match = html.match(/<form[^>]*\baction="([^"]*)"/i)
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined
}

const extractFormFields = (html: string): URLSearchParams => {
  const params = new URLSearchParams()
  const inputRegex = /<input[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"/gi
  for (const match of html.matchAll(inputRegex)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined)
      params.set(decodeHtmlEntities(name), decodeHtmlEntities(value))
  }
  return params
}

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** Implements `IdentityProvider` against Mockingbird's in-process OAuth mock. */
export const createOAuthMockIdentity = (): IdentityProvider => {
  const apis = createProviderApis()
  const flows = new Map<string, PendingFlow>()

  const pruneExpired = (): void => {
    const now = Date.now()
    for (const [id, flow] of flows) if (flow.expires < now) flows.delete(id)
  }

  const startSignIn = async (
    provider: IdentityProviderKey,
  ): Promise<HostedFlowStep<IdentityProfile>> => {
    pruneExpired()
    const config = CLIENTS[provider]
    const api = apis[provider]
    const dispatch = dispatchFor(api)
    const options = { [oauth.customFetch]: dispatch }

    let as: oauth.AuthorizationServer
    try {
      const discovery = await oauth.discoveryRequest(new URL(config.issuer), options)
      as = await oauth.processDiscoveryResponse(new URL(config.issuer), discovery)
    } catch (err) {
      return { kind: "error", message: `Could not reach ${provider}: ${describe(err)}` }
    }

    const state = oauth.generateRandomState()
    const nonce = oauth.generateRandomNonce()
    const verifier = oauth.generateRandomCodeVerifier()
    const flowId = crypto.randomUUID()
    const redirectUri = REDIRECT_URI(provider)
    flows.set(flowId, {
      provider,
      state,
      nonce,
      verifier,
      as,
      redirectUri,
      expires: Date.now() + 600_000,
    })

    const authorizationUrl = new URL(as.authorization_endpoint ?? "")
    const params: Record<string, string> = {
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: config.scope,
      state,
      nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    }
    if (provider === "apple") params.response_mode = "form_post"
    authorizationUrl.search = new URLSearchParams(params).toString()

    return handleProviderResponse(flowId, api, await dispatch(authorizationUrl))
  }

  const continueSignIn = async (
    flowId: string,
    action: string,
    method: string,
    body: string,
  ): Promise<HostedFlowStep<IdentityProfile>> => {
    pruneExpired()
    const flow = flows.get(flowId)
    if (!flow) return { kind: "error", message: "This sign-in attempt expired. Please try again." }
    const dispatch = dispatchFor(apis[flow.provider])
    const isGet = method.toUpperCase() === "GET"
    const target = isGet && body ? `${action}${action.includes("?") ? "&" : "?"}${body}` : action
    const init: RequestInit = isGet
      ? { method: "GET" }
      : { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body }
    return handleProviderResponse(flowId, apis[flow.provider], await dispatch(target, init))
  }

  const handleProviderResponse = async (
    flowId: string,
    api: OAuthAPI,
    response: Response,
  ): Promise<HostedFlowStep<IdentityProfile>> => {
    const flow = flows.get(flowId)
    if (!flow) return { kind: "error", message: "This sign-in attempt expired. Please try again." }

    const location = response.headers.get("location")
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      const resolved = new URL(location, flow.redirectUri)
      if (isRedirectUri(resolved, flow.redirectUri))
        return completeFlow(flowId, resolved.searchParams)
      const dispatch = dispatchFor(api)
      return handleProviderResponse(flowId, api, await dispatch(resolved))
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("text/html")) {
      const html = await response.text()
      const formTarget = extractFormAction(html)
      if (formTarget && isRedirectUri(new URL(formTarget, flow.redirectUri), flow.redirectUri))
        return completeFlow(flowId, extractFormFields(html))
      return { kind: "html", flowId, html }
    }

    flows.delete(flowId)
    const text = await response.text().catch(() => "")
    return { kind: "error", message: `Sign-in failed (${response.status}). ${text.slice(0, 200)}` }
  }

  const completeFlow = async (
    flowId: string,
    params: URLSearchParams,
  ): Promise<HostedFlowStep<IdentityProfile>> => {
    const flow = flows.get(flowId)
    flows.delete(flowId)
    if (!flow) return { kind: "error", message: "This sign-in attempt expired. Please try again." }

    const errorCode = params.get("error")
    if (errorCode) return { kind: "error", message: params.get("error_description") ?? errorCode }

    const config = CLIENTS[flow.provider]
    const client = { client_id: config.clientId }
    const dispatch = dispatchFor(apis[flow.provider])
    const options = { [oauth.customFetch]: dispatch }

    try {
      const callbackUrl = new URL(flow.redirectUri)
      callbackUrl.search = params.toString()
      const authResponse = oauth.validateAuthResponse(flow.as, client, callbackUrl, flow.state)

      const tokenResponse = await oauth.authorizationCodeGrantRequest(
        flow.as,
        client,
        oauth.ClientSecretPost(config.clientSecret),
        authResponse,
        flow.redirectUri,
        flow.verifier,
        options,
      )
      const tokens = await oauth.processAuthorizationCodeResponse(flow.as, client, tokenResponse, {
        expectedNonce: flow.nonce,
        requireIdToken: true,
      })
      await oauth.validateApplicationLevelSignature(flow.as, tokenResponse, options)
      const claims = oauth.getValidatedIdTokenClaims(tokens)
      if (!claims)
        return { kind: "error", message: "The provider did not return an identity token." }

      let profile: IdentityProfile = {
        provider: flow.provider,
        subject: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
        name: typeof claims.name === "string" ? claims.name : null,
        picture: typeof claims.picture === "string" ? claims.picture : null,
      }

      if (flow.provider === "google" && flow.as.userinfo_endpoint) {
        const userinfoResponse = await oauth.userInfoRequest(
          flow.as,
          client,
          tokens.access_token ?? "",
          options,
        )
        const info = await oauth.processUserInfoResponse(
          flow.as,
          client,
          claims.sub,
          userinfoResponse,
        )
        profile = {
          provider: flow.provider,
          subject: typeof info.sub === "string" ? info.sub : profile.subject,
          email: typeof info.email === "string" ? info.email : profile.email,
          name: typeof info.name === "string" ? info.name : profile.name,
          picture: typeof info.picture === "string" ? info.picture : profile.picture,
        }
      } else if (flow.provider === "apple") {
        // Apple only ever sends the name once, in a one-time `user` JSON param on first consent.
        const userParam = params.get("user")
        if (userParam) {
          try {
            const appleUser = JSON.parse(userParam) as {
              name?: { firstName?: string; lastName?: string }
            }
            const full = [appleUser.name?.firstName, appleUser.name?.lastName]
              .filter(Boolean)
              .join(" ")
            if (full) profile = { ...profile, name: full }
          } catch {
            // Malformed/absent `user` param — keep the ID token's claims.
          }
        }
      }

      return { kind: "done", result: profile }
    } catch (err) {
      return { kind: "error", message: `Sign-in could not be completed: ${describe(err)}` }
    }
  }

  return { startSignIn, continueSignIn }
}
