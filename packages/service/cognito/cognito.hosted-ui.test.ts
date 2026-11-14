import { describe, expect, test } from "bun:test"
import { createLocalJWKSet, jwtVerify } from "jose"
import { createRuntime } from "./src/runtime.js"

// Hosted UI (#700). Best guess from the Cognito developer guide, not oracle-verified:
// https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html
// https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html
const origin = "http://cognito.test"
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const callback = "http://localhost:8081/auth/callback"
const verifier = "synthetic-verifier-0123456789-abcdefghijklmnopqrstuvwxyz"
const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url")
const ada = {
  username: "ada",
  password: "Synthetic1",
  confirmed: true,
  attributes: [
    { Name: "email", Value: "ada@example.test" },
    { Name: "email_verified", Value: "true" },
  ],
}

const setup = (options: Parameters<typeof createRuntime>[0] = {}) =>
  createRuntime({
    poolId,
    clientId,
    users: [ada],
    appClients: [{ clientId, callbackUrls: [callback] }],
    ...options,
  })
type Runtime = ReturnType<typeof setup>
const authorizeUrl = (params: Record<string, string>) =>
  `${origin}/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    scope: "openid email profile aws.cognito.signin.user.admin",
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...params,
  })}`
const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
})
const pick = async (runtime: Runtime, html: string, username: string) => {
  const transaction = /name="transaction" value="([^"]+)"/.exec(html)?.[1] as string
  return runtime.fetch(new Request(`${origin}/oauth2/idpresponse`, form({ transaction, username })))
}
const signIn = async (runtime: Runtime, provider = "Google", username = "ada") => {
  const picker = await runtime.fetch(new Request(authorizeUrl({ identity_provider: provider })))
  const redirect = await pick(runtime, await picker.text(), username)
  return new URL(redirect.headers.get("location") as string)
}
const exchange = (runtime: Runtime, code: string, overrides: Record<string, string> = {}) =>
  runtime.fetch(
    new Request(
      `${origin}/oauth2/token`,
      form({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: callback,
        code_verifier: verifier,
        ...overrides,
      }),
    ),
  )
const rpc = (runtime: Runtime, target: string, body: unknown, admin = false) =>
  runtime.fetch(
    new Request(`${origin}/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
        ...(admin ? { authorization: "AWS4-HMAC-SHA256 Credential=fixture/x" } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
const verify = async (runtime: Runtime, token: string) => {
  const jwks = await (
    await runtime.fetch(new Request(`${origin}/${poolId}/.well-known/jwks.json`))
  ).json()
  return (await jwtVerify(token, createLocalJWKSet(jwks))).payload
}

describe("Cognito hosted UI (#700)", () => {
  test("1: authorize shows a picker of the pool's users and redirects with code and state", async () => {
    const runtime = setup()
    const picker = await runtime.fetch(new Request(authorizeUrl({ identity_provider: "Google" })))
    expect(picker.status).toBe(200)
    expect(picker.headers.get("content-type")).toContain("text/html")
    const html = await picker.text()
    expect(html).toContain('data-username="ada"')
    expect(html).toContain("ada@example.test")
    const redirect = await pick(runtime, html, "ada")
    expect(redirect.status).toBe(302)
    const location = new URL(redirect.headers.get("location") as string)
    expect(`${location.origin}${location.pathname}`).toBe(callback)
    expect(location.searchParams.get("state")).toBe("state-123")
    expect(location.searchParams.get("code")).toBeString()
  })

  test("2: the code redeems for pool-signed tokens of the federated Google_<sub> user", async () => {
    const runtime = setup()
    const code = (await signIn(runtime)).searchParams.get("code") as string
    const response = await exchange(runtime, code)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(
      ["access_token", "expires_in", "id_token", "refresh_token", "token_type"].sort(),
    )
    expect(body.token_type).toBe("Bearer")
    expect(body.expires_in).toBe(3600)
    const ada = await (await runtime.fetch(new Request(`${origin}/__admin/users`))).json()
    const native = ada.users.find((u: { username: string }) => u.username === "ada")
    const id = await verify(runtime, body.id_token)
    expect(id.iss).toBe(`${origin}/${poolId}`)
    expect(id.aud).toBe(clientId)
    expect(id.token_use).toBe("id")
    expect(id["cognito:username"]).toBe(`Google_${native.sub}`)
    expect(id.email).toBe("ada@example.test")
    expect(id.identities).toEqual([
      expect.objectContaining({
        userId: native.sub,
        providerName: "Google",
        providerType: "Google",
        issuer: null,
        primary: "true",
      }),
    ])
    const access = await verify(runtime, body.access_token)
    expect(access.iss).toBe(`${origin}/${poolId}`)
    expect(access.client_id).toBe(clientId)
    expect(access.username).toBe(`Google_${native.sub}`)
    expect(access.scope).toBe("openid email profile aws.cognito.signin.user.admin")
    // The federated user lives in the pool and cannot sign in with a password.
    const listed = await (await rpc(runtime, "ListUsers", {}, true)).json()
    expect(listed.Users.map((u: { Username: string }) => u.Username)).toContain(
      `Google_${native.sub}`,
    )
    const password = await rpc(runtime, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: `Google_${native.sub}`, PASSWORD: "" },
    })
    expect((await password.json()).__type).toBe("NotAuthorizedException")
  })

  test("3: InitiateAuth REFRESH_TOKEN_AUTH accepts the hosted-UI refresh token", async () => {
    const runtime = setup()
    const code = (await signIn(runtime)).searchParams.get("code") as string
    const { refresh_token } = await (await exchange(runtime, code)).json()
    const refreshed = await rpc(runtime, "InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: clientId,
      AuthParameters: { REFRESH_TOKEN: refresh_token },
    })
    expect(refreshed.status).toBe(200)
    const result = (await refreshed.json()).AuthenticationResult
    expect(result.ExpiresIn).toBe(3600)
    expect(result.RefreshToken).toBeUndefined()
    const id = await verify(runtime, result.IdToken)
    expect(String(id["cognito:username"])).toStartWith("Google_")
    const access = await verify(runtime, result.AccessToken)
    expect(access.scope).toBe("openid email profile aws.cognito.signin.user.admin")
    // The token endpoint's refresh grant returns ID and access tokens, no refresh token.
    const grant = await runtime.fetch(
      new Request(
        `${origin}/oauth2/token`,
        form({ grant_type: "refresh_token", client_id: clientId, refresh_token }),
      ),
    )
    expect(grant.status).toBe(200)
    expect(Object.keys(await grant.json()).sort()).toEqual(
      ["access_token", "expires_in", "id_token", "token_type"].sort(),
    )
    // And a password sign-in's refresh token works at the token endpoint.
    const api = await rpc(runtime, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: "ada", PASSWORD: "Synthetic1" },
    })
    const apiRefresh = (await api.json()).AuthenticationResult.RefreshToken
    const viaEndpoint = await runtime.fetch(
      new Request(
        `${origin}/oauth2/token`,
        form({ grant_type: "refresh_token", client_id: clientId, refresh_token: apiRefresh }),
      ),
    )
    expect(viaEndpoint.status).toBe(200)
  })

  test("4: a federated sign-in follows the pool's linking state", async () => {
    const runtime = setup()
    const sub = (await (await rpc(runtime, "AdminGetUser", { Username: "ada" }, true)).json())
      .UserAttributes[0].Value
    // Unlinked: the same email gets a separate Google_<sub> user.
    const unlinked = await exchange(
      runtime,
      (await signIn(runtime)).searchParams.get("code") as string,
    )
    const first = await verify(runtime, (await unlinked.json()).id_token)
    expect(first["cognito:username"]).toBe(`Google_${sub}`)

    // Linked with AdminLinkProviderForUser: the provider subject signs in as the native user.
    const runtime2 = setup()
    const sub2 = (await (await rpc(runtime2, "AdminGetUser", { Username: "ada" }, true)).json())
      .UserAttributes[0].Value
    const link = await rpc(
      runtime2,
      "AdminLinkProviderForUser",
      {
        UserPoolId: poolId,
        DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: "ada" },
        SourceUser: {
          ProviderName: "Google",
          ProviderAttributeName: "Cognito_Subject",
          ProviderAttributeValue: sub2,
        },
      },
      true,
    )
    expect(link.status).toBe(200)
    const linked = await exchange(
      runtime2,
      (await signIn(runtime2)).searchParams.get("code") as string,
    )
    const second = await verify(runtime2, (await linked.json()).id_token)
    expect(second["cognito:username"]).toBe("ada")
    expect(second.sub).toBe(sub2)
    const users = await (await rpc(runtime2, "ListUsers", {}, true)).json()
    expect(users.Users).toHaveLength(1)
  })

  test("5: documented errors for verifier, client, redirect URI and reused codes", async () => {
    const runtime = setup()
    const code = (await signIn(runtime)).searchParams.get("code") as string
    const wrong = await exchange(runtime, code, { code_verifier: `${verifier}-wrong` })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: "invalid_grant" })
    // The code was consumed by that attempt.
    const reused = await exchange(runtime, code)
    expect(await reused.json()).toEqual({ error: "invalid_grant" })

    const unknownClient = await exchange(
      runtime,
      (await signIn(runtime)).searchParams.get("code") as string,
      { client_id: "nope" },
    )
    expect(unknownClient.status).toBe(400)
    expect(await unknownClient.json()).toEqual({ error: "invalid_client" })

    const otherRedirect = await exchange(
      runtime,
      (await signIn(runtime)).searchParams.get("code") as string,
      { redirect_uri: "http://localhost:8081/elsewhere" },
    )
    expect(await otherRedirect.json()).toEqual({
      error: "unauthorized_client",
      error_description: "invalid_redirect",
    })

    const mismatch = await runtime.fetch(
      new Request(
        authorizeUrl({ identity_provider: "Google", redirect_uri: "https://evil.test/" }),
      ),
    )
    expect(mismatch.status).toBe(302)
    const location = new URL(mismatch.headers.get("location") as string)
    expect(`${location.origin}${location.pathname}`).toBe(`${origin}/error`)
    expect(location.searchParams.get("error")).toBe("redirect_mismatch")
    const page = await runtime.fetch(new Request(location))
    expect(page.status).toBe(400)
    expect(await page.text()).toContain("redirect_mismatch")

    const badClient = await runtime.fetch(
      new Request(authorizeUrl({ identity_provider: "Google", client_id: "nope" })),
    )
    expect(new URL(badClient.headers.get("location") as string).searchParams.get("error")).toBe(
      "invalid_client",
    )

    // With a valid client and callback, malformed requests return to the app.
    const plain = await runtime.fetch(
      new Request(authorizeUrl({ identity_provider: "Google", code_challenge_method: "plain" })),
    )
    const plainLocation = new URL(plain.headers.get("location") as string)
    expect(plainLocation.searchParams.get("error")).toBe("invalid_request")
    expect(plainLocation.searchParams.get("state")).toBe("state-123")

    const grant = await runtime.fetch(
      new Request(`${origin}/oauth2/token`, form({ grant_type: "password", client_id: clientId })),
    )
    expect(await grant.json()).toEqual({ error: "unsupported_grant_type" })
  })

  test("5: a client secret is required when the client has one", async () => {
    const runtime = setup({
      appClients: [{ clientId, clientSecret: "synthetic-secret", callbackUrls: [callback] }],
    })
    const missing = await exchange(
      runtime,
      (await signIn(runtime)).searchParams.get("code") as string,
    )
    expect(await missing.json()).toEqual({ error: "invalid_client" })
    const code = (await signIn(runtime)).searchParams.get("code") as string
    const basic = await runtime.fetch(
      new Request(`${origin}/oauth2/token`, {
        ...form({
          grant_type: "authorization_code",
          code,
          redirect_uri: callback,
          code_verifier: verifier,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(`${clientId}:synthetic-secret`)}`,
        },
      }),
    )
    expect(basic.status).toBe(200)
  })

  test("6: the token endpoint answers a browser fetch with CORS", async () => {
    const runtime = setup()
    const preflight = await runtime.fetch(
      new Request(`${origin}/oauth2/token`, {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:8081",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type")
    const code = (await signIn(runtime)).searchParams.get("code") as string
    const response = await exchange(runtime, code)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })

  test("admin next-account completes the redirect without rendering the picker", async () => {
    const runtime = setup()
    const missing = await runtime.fetch(
      new Request(`${origin}/__admin/hosted-ui/next-account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "nobody" }),
      }),
    )
    expect(missing.status).toBe(404)
    const set = await runtime.fetch(
      new Request(`${origin}/__admin/hosted-ui/next-account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "ada" }),
      }),
    )
    expect(set.status).toBe(200)
    const redirect = await runtime.fetch(
      new Request(authorizeUrl({ identity_provider: "SignInWithApple" })),
    )
    expect(redirect.status).toBe(302)
    const location = new URL(redirect.headers.get("location") as string)
    const tokens = await (
      await exchange(runtime, location.searchParams.get("code") as string)
    ).json()
    const id = await verify(runtime, tokens.id_token)
    expect(String(id["cognito:username"])).toStartWith("SignInWithApple_")
    // The pick is consumed: the next authorize renders the picker again.
    const again = await runtime.fetch(new Request(authorizeUrl({ identity_provider: "Google" })))
    expect(again.status).toBe(200)
  })

  test("COGNITO (no identity_provider) signs in as the picked native user", async () => {
    const runtime = setup()
    const location = await signIn(runtime, "COGNITO")
    const tokens = await (
      await exchange(runtime, location.searchParams.get("code") as string)
    ).json()
    expect((await verify(runtime, tokens.id_token))["cognito:username"]).toBe("ada")
  })

  test("app clients restrict identity providers and register through admin and fixtures", async () => {
    const runtime = createRuntime({
      poolId,
      fixtures: {
        users: [ada],
        appClients: [{ clientId, callbackUrls: [callback], identityProviders: ["Google"] }],
      },
    })
    const apple = await runtime.fetch(
      new Request(authorizeUrl({ identity_provider: "SignInWithApple" })),
    )
    expect(new URL(apple.headers.get("location") as string).searchParams.get("error")).toBe(
      "invalid_request",
    )
    expect(() =>
      createRuntime({
        fixtures: { users: [], appClients: [{ clientId: "x", callbackUrls: ["nope"] }] },
      }),
    ).toThrow("fixtures.appClients[0].callbackUrls[0]")
    const registered = await runtime.fetch(
      new Request(`${origin}/__admin/app-clients`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "web",
          clientSecret: "synthetic",
          callbackUrls: ["myapp://callback"],
        }),
      }),
    )
    expect(registered.status).toBe(201)
    expect(await registered.json()).toEqual({
      clientId: "web",
      callbackUrls: ["myapp://callback"],
      hasSecret: true,
    })
    const picker = await runtime.fetch(
      new Request(
        authorizeUrl({
          client_id: "web",
          redirect_uri: "myapp://callback",
          identity_provider: "COGNITO",
        }),
      ),
    )
    expect(picker.status).toBe(200)
  })

  test("discovery advertises the hosted-UI endpoints", async () => {
    const runtime = setup()
    const discovery = await (
      await runtime.fetch(new Request(`${origin}/${poolId}/.well-known/openid-configuration`))
    ).json()
    expect(discovery.authorization_endpoint).toBe(`${origin}/oauth2/authorize`)
    expect(discovery.token_endpoint).toBe(`${origin}/oauth2/token`)
    expect(discovery.code_challenge_methods_supported).toEqual(["S256"])
  })
})
