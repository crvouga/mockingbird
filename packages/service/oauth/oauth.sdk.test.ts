import { expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import * as oauth from "oauth4webapi"
import { OAuthAPI } from "./src/index.js"

const issuer = new URL("https://identity.test")
const callback = "https://app.test/callback"
const account = { id: "ada", name: "Ada Lovelace", email: "ada@example.test" }
const transaction = (html: string) => {
  const value = /name="transaction" value="([^"]+)"/.exec(html)?.[1]
  if (!value) throw new Error("Missing transaction")
  return value
}
const post = (api: OAuthAPI, path: string, body: Record<string, string>) =>
  api.fetch(new Request(new URL(path, issuer), { method: "POST", body: new URLSearchParams(body) }))

test("oauth4webapi discovery, PKCE, Basic auth, ID signature and userinfo work without client patches", async () => {
  const api = new OAuthAPI({
    accounts: [account],
    clients: [{ id: "app", name: "App", redirectUris: [callback], secret: "fixture" }],
  })
  const options = {
    [oauth.customFetch]: (
      input: string,
      init: oauth.CustomFetchOptions<string, URLSearchParams | undefined>,
    ) =>
      api.fetch(
        new Request(input, {
          method: init.method,
          headers: init.headers,
          ...(init.body ? { body: init.body } : {}),
        }),
      ),
  }
  const as = await oauth.processDiscoveryResponse(
    issuer,
    await oauth.discoveryRequest(issuer, options),
  )
  const client: oauth.Client = { client_id: "app" }
  const verifier = oauth.generateRandomCodeVerifier()
  const challenge = await oauth.calculatePKCECodeChallenge(verifier)
  const authorization = new URL(as.authorization_endpoint ?? "")
  authorization.search = new URLSearchParams({
    client_id: "app",
    redirect_uri: callback,
    response_type: "code",
    scope: "openid email profile",
    nonce: "nonce",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()
  const tx = transaction(await (await api.fetch(new Request(authorization))).text())
  await post(api, "/interaction", { transaction: tx, action: "select", account: "ada" })
  const redirect = await post(api, "/interaction", { transaction: tx, action: "allow" })
  const params = oauth.validateAuthResponse(
    as,
    client,
    new URL(redirect.headers.get("location") ?? ""),
    "state",
  )
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    oauth.ClientSecretBasic("fixture"),
    params,
    callback,
    verifier,
    options,
  )
  const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
    expectedNonce: "nonce",
    requireIdToken: true,
  })
  await oauth.validateApplicationLevelSignature(as, response, options)
  expect(oauth.getValidatedIdTokenClaims(tokens)?.sub).toBe("ada")
  const user = await oauth.processUserInfoResponse(
    as,
    client,
    "ada",
    await oauth.userInfoRequest(as, client, tokens.access_token, options),
  )
  expect(user.email).toBe(account.email)
})

test("Apple verifies real ES256 client-secret JWTs and rejects wrong team, signature and expiry", async () => {
  const keys = await generateKeyPair("ES256", { extractable: true })
  const publicKey = await exportJWK(keys.publicKey)
  const api = new OAuthAPI({
    provider: "apple",
    accounts: [account],
    clients: [
      {
        id: "app",
        name: "App",
        redirectUris: [callback],
        apple: { teamId: "TEAM", keyId: "KEY", publicKey },
      },
    ],
  })
  const auth = new URL("/auth/authorize", issuer)
  auth.search = new URLSearchParams({
    client_id: "app",
    redirect_uri: callback,
    response_type: "code",
    scope: "openid email",
    response_mode: "form_post",
  }).toString()
  const tx = transaction(await (await api.fetch(new Request(auth))).text())
  await post(api, "/interaction", { transaction: tx, action: "select", account: "ada" })
  const html = await (await post(api, "/interaction", { transaction: tx, action: "allow" })).text()
  const code = /name="code" value="([^"]+)"/.exec(html)?.[1] ?? ""
  const sign = (team: string, exp: number) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "KEY" })
      .setIssuer(team)
      .setSubject("app")
      .setAudience("https://appleid.apple.com")
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(keys.privateKey)
  const exchange = (secret: string) =>
    post(api, "/auth/token", {
      client_id: "app",
      client_secret: secret,
      grant_type: "authorization_code",
      code,
      redirect_uri: callback,
    })
  const now = Math.floor(Date.now() / 1000)
  expect((await exchange(await sign("WRONG", now + 300))).status).toBe(401)
  expect((await exchange(await sign("TEAM", now - 1))).status).toBe(401)
  const valid = await sign("TEAM", now + 300)
  expect((await exchange(`${valid.slice(0, -10)}aaaaaaaaaa`)).status).toBe(401)
  const result = await exchange(valid)
  expect(result.status).toBe(200)
  expect((await result.json()).id_token).toBeString()
})
