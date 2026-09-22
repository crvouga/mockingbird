import { expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { decodeJwt } from "jose"
import { OAuthAPI, type OAuthAPIOptions, type Provider } from "./src/index.js"

const origin = "https://identity.test"
const callback = "https://app.test/callback"
const now = () => 1_700_000_000_000
const account = {
  id: "ada",
  name: "Ada Lovelace",
  email: "ada@example.test",
  givenName: "Ada",
  familyName: "Lovelace",
  hostedDomain: "example.test",
  preferredUsername: "ada@example.test",
  tenantId: "00000000-0000-4000-8000-000000000001",
  objectId: "00000000-0000-4000-8000-000000000002",
  github: { id: 101, login: "ada", publicEmail: null },
}
const client = { id: "app", name: "App", secret: "fixture", redirectUris: [callback] }
const post = (api: OAuthAPI, path: string, body: Record<string, string>) =>
  api.fetch(
    new Request(origin + path, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    }),
  )
const hidden = (html: string, name: string) =>
  (new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")

async function walk(provider: Provider, options: OAuthAPIOptions) {
  const api = new OAuthAPI({ provider, accounts: [account], clients: [client], now, ...options })
  const scope =
    provider === "apple"
      ? "openid name email"
      : provider === "github"
        ? "read:user user:email"
        : provider === "google"
          ? "openid profile email"
          : "openid profile email offline_access"
  const authorize = new URL(provider === "github" ? "/login/oauth/authorize" : "/authorize", origin)
  authorize.search = new URLSearchParams({
    client_id: "app",
    redirect_uri: callback,
    response_type: "code",
    scope,
    state: "state",
    nonce: "nonce",
    ...(provider === "apple" ? { response_mode: "form_post" } : {}),
    ...(provider === "google" ? { access_type: "offline" } : {}),
  }).toString()
  const login = await api.fetch(new Request(authorize))
  const transaction = hidden(await login.text(), "transaction")
  expect(transaction).not.toBe("")
  await post(api, "/interaction", { transaction, action: "select", account: "ada" })
  const completed = await post(api, "/interaction", { transaction, action: "allow" })
  const completedText = await completed.text()
  const code =
    provider === "apple"
      ? hidden(completedText, "code")
      : (new URL(completed.headers.get("location") ?? "").searchParams.get("code") ?? "")
  const token = await post(api, provider === "github" ? "/login/oauth/access_token" : "/token", {
    client_id: "app",
    client_secret: "fixture",
    grant_type: "authorization_code",
    redirect_uri: callback,
    code,
  })
  const body = (await token.json()) as Record<string, unknown>
  const claims = typeof body.id_token === "string" ? decodeJwt(body.id_token) : undefined
  if (claims) {
    delete claims.at_hash
    delete claims.c_hash
  }
  const stable = {
    status: token.status,
    tokenType: body.token_type,
    expiresIn: body.expires_in,
    extExpiresIn: body.ext_expires_in,
    scope: body.scope,
    hasAccess: typeof body.access_token === "string",
    hasRefresh: typeof body.refresh_token === "string",
    claims,
  }
  if (typeof body.access_token !== "string") return stable
  if (provider === "apple") return stable
  const profile = await api.fetch(
    new Request(origin + (provider === "github" ? "/user" : "/userinfo"), {
      headers: { authorization: `Bearer ${body.access_token}` },
    }),
  )
  const identity = await profile.json()
  const emails =
    provider === "github"
      ? await (
          await api.fetch(
            new Request(`${origin}/user/emails`, {
              headers: { authorization: `Bearer ${body.access_token}` },
            }),
          )
        ).json()
      : undefined
  return { ...stable, identity, emails }
}

test(
  "self-parity: every provider is deterministic across randomized claim and privacy configurations",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          provider: fc.constantFrom<Provider>("google", "apple", "microsoft", "github", "oidc"),
          omitEmail: fc.boolean(),
          omitName: fc.boolean(),
          unverifiedEmail: fc.boolean(),
          hideEmail: fc.boolean(),
          booleanAppleClaims: fc.boolean(),
          seed: fc.integer(),
        }),
        async (sample) => {
          const options: OAuthAPIOptions = {
            seed: sample.seed,
            behavior: {
              claims: {
                omitEmail: sample.omitEmail,
                omitName: sample.omitName,
                unverifiedEmail: sample.unverifiedEmail,
              },
              apple: {
                emailMode: sample.hideEmail ? "hide" : "share",
                booleanClaims: sample.booleanAppleClaims ? "boolean" : "string",
              },
            },
          }
          expect(await walk(sample.provider, options)).toEqual(await walk(sample.provider, options))
        },
      ),
      { ...fcParameters(process.env), numRuns: 50 },
    )
  },
  { timeout: 30_000 },
)
