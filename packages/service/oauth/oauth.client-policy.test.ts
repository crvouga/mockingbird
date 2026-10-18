import { describe, expect, test } from "bun:test"
import { hash } from "./src/crypto.js"
import { type Client, createRuntime, OAuthAPI, type Provider } from "./src/index.js"

const issuer = "https://identity.test"
const account = { id: "ada", name: "Ada Lovelace", email: "ada@example.test" }
const verifier = "a".repeat(43)
const callback = "https://app.test/callback"
const form = (path: string, body: Record<string, string>) =>
  new Request(issuer + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  })
const make = (client: Partial<Client>, provider: Provider = "oidc") =>
  new OAuthAPI({
    provider,
    accounts: [account],
    clients: [{ id: "app", name: "App", redirectUris: [callback], ...client }],
  })
const authorize = (api: OAuthAPI, params: Record<string, string>) =>
  api.fetch(
    new Request(
      `${issuer}/authorize?${new URLSearchParams({ client_id: "app", redirect_uri: callback, response_type: "code", scope: "email openid profile", state: "s", nonce: "n", ...params })}`,
    ),
  )
const tx = (html: string) => /name="transaction" value="([^"]+)"/.exec(html)?.[1] ?? ""
/** Runs the interactive flow and returns the final redirect to the application. */
async function signIn(api: OAuthAPI, params: Record<string, string>) {
  const first = await authorize(api, params)
  expect(first.status).toBe(200)
  const id = tx(await first.text())
  await api.fetch(form("/interaction", { transaction: id, action: "select", account: "ada" }))
  return api.fetch(form("/interaction", { transaction: id, action: "allow" }))
}
const codeOf = (r: Response) =>
  new URL(r.headers.get("location") ?? "https://invalid").searchParams.get("code") ?? ""
const redirectErrorOf = (r: Response) =>
  new URL(r.headers.get("location") ?? "https://invalid").searchParams.get("error")

describe("Cognito-style public app client (opt-in)", () => {
  test("defaults are unchanged: PKCE required and no refresh token without offline_access", async () => {
    const api = make({})
    expect(redirectErrorOf(await authorize(api, {}))).toBe("invalid_request")
    const finished = await signIn(api, {
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    })
    const tokens = await (
      await api.fetch(
        form("/token", {
          grant_type: "authorization_code",
          client_id: "app",
          code: codeOf(finished),
          redirect_uri: callback,
          code_verifier: verifier,
        }),
      )
    ).json()
    expect(tokens.access_token).toBeString()
    expect(tokens.refresh_token).toBeUndefined()
  })

  test("pkceOptional + alwaysIssueRefreshToken: no secret, no PKCE, refresh token without offline_access", async () => {
    const api = make({ pkceOptional: true, alwaysIssueRefreshToken: true })
    const finished = await signIn(api, { identity_provider: "Google" })
    const response = await api.fetch(
      form("/token", {
        grant_type: "authorization_code",
        client_id: "app",
        code: codeOf(finished),
        redirect_uri: callback,
      }),
    )
    expect(response.status).toBe(200)
    const tokens = await response.json()
    expect(tokens.id_token).toBeString()
    expect(tokens.refresh_token).toBeString()
    const refreshed = await api.fetch(
      form("/token", {
        grant_type: "refresh_token",
        client_id: "app",
        refresh_token: tokens.refresh_token,
      }),
    )
    expect(refreshed.status).toBe(200)
    expect((await refreshed.json()).access_token).toBeString()
  })

  test("pkceOptional alone still gates the refresh token on offline_access", async () => {
    const api = make({ pkceOptional: true })
    const finished = await signIn(api, {})
    const tokens = await (
      await api.fetch(
        form("/token", {
          grant_type: "authorization_code",
          client_id: "app",
          code: codeOf(finished),
          redirect_uri: callback,
        }),
      )
    ).json()
    expect(tokens.access_token).toBeString()
    expect(tokens.refresh_token).toBeUndefined()
  })

  test("alwaysIssueRefreshToken alone keeps PKCE required", async () => {
    const api = make({ alwaysIssueRefreshToken: true })
    expect(redirectErrorOf(await authorize(api, {}))).toBe("invalid_request")
  })

  test("a PKCE challenge that is sent is still verified", async () => {
    const api = make({ pkceOptional: true })
    const finished = await signIn(api, {
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    })
    const bad = await api.fetch(
      form("/token", {
        grant_type: "authorization_code",
        client_id: "app",
        code: codeOf(finished),
        redirect_uri: callback,
        code_verifier: "b".repeat(43),
      }),
    )
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe("invalid_grant")
  })

  test("a challenge without S256 is still refused", async () => {
    const api = make({ pkceOptional: true })
    const rejected = await authorize(api, {
      code_challenge: await hash(verifier),
      code_challenge_method: "plain",
    })
    expect(redirectErrorOf(rejected)).toBe("invalid_request")
  })

  test("a wrong client secret is still refused for a confidential client", async () => {
    const api = make({ secret: "fixture", alwaysIssueRefreshToken: true })
    const finished = await signIn(api, {
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    })
    const response = await api.fetch(
      form("/token", {
        grant_type: "authorization_code",
        client_id: "app",
        code: codeOf(finished),
        redirect_uri: callback,
        code_verifier: verifier,
      }),
    )
    expect(response.status).toBe(401)
  })

  test("invalid combinations are rejected at registration", () => {
    expect(() => make({ pkceOptional: true, requirePkce: true })).toThrow(/pkceOptional/)
    expect(() => make({ pkceOptional: true, secret: "x" })).toThrow(/pkceOptional/)
    expect(() => make({ pkceOptional: "yes" as unknown as boolean })).toThrow(/pkceOptional/)
    for (const provider of ["google", "apple", "github"] as const)
      expect(() => make({ alwaysIssueRefreshToken: true }, provider)).toThrow(
        /alwaysIssueRefreshToken/,
      )
    expect(() => make({ alwaysIssueRefreshToken: true }, "microsoft")).not.toThrow()
  })

  test("admin client listing reports PKCE as optional", async () => {
    const runtime = createRuntime({
      accounts: [account],
      clients: [
        { id: "app", name: "App", redirectUris: [callback], pkceOptional: true },
        { id: "strict", name: "Strict", redirectUris: [callback] },
      ],
    })
    const { clients } = await (await runtime.fetch(new Request(`${issuer}/__admin/clients`))).json()
    expect(clients.map((c: { id: string; requirePkce: boolean }) => [c.id, c.requirePkce])).toEqual(
      [
        ["app", false],
        ["strict", true],
      ],
    )
  })
})

describe("client redirectPolicy (opt-in)", () => {
  const challenge = async () => ({
    code_challenge: await hash(verifier),
    code_challenge_method: "S256",
  })
  const rejected = async (api: OAuthAPI, redirect_uri: string) => {
    const r = await authorize(api, { redirect_uri, ...(await challenge()) })
    expect(r.status).toBe(400)
    expect(r.headers.has("location")).toBe(false)
  }
  const redeem = async (api: OAuthAPI, redirect_uri: string) => {
    const finished = await signIn(api, { redirect_uri, ...(await challenge()) })
    const location = finished.headers.get("location") ?? ""
    expect(location).toStartWith(redirect_uri)
    return api.fetch(
      form("/token", {
        grant_type: "authorization_code",
        client_id: "app",
        code: codeOf(finished),
        redirect_uri,
        code_verifier: verifier,
      }),
    )
  }

  test("default: only exact registered URIs match", async () => {
    const api = make({ redirectUris: ["http://127.0.0.1:8080/cb", "exp://localhost:8081/--/cb"] })
    await rejected(api, "http://127.0.0.1:54321/cb")
    await rejected(api, "exp://192.168.1.20:8081/--/cb")
  })

  test("loopbackAnyPort: any port on the registered loopback host, same path and query", async () => {
    const api = make({
      redirectUris: ["http://127.0.0.1:8080/cb?x=1", "http://localhost/other"],
      redirectPolicy: { loopbackAnyPort: true },
    })
    expect((await redeem(api, "http://127.0.0.1:54321/cb?x=1")).status).toBe(200)
    expect((await redeem(api, "http://127.0.0.1/cb?x=1")).status).toBe(200)
    expect((await redeem(api, "http://localhost:3000/other")).status).toBe(200)
    await rejected(api, "http://127.0.0.1:54321/cb")
    await rejected(api, "http://127.0.0.1:54321/cb?x=2")
    await rejected(api, "http://127.0.0.1:54321/elsewhere?x=1")
    await rejected(api, "http://localhost:54321/cb?x=1")
    await rejected(api, "http://[::1]:54321/cb?x=1")
    await rejected(api, "https://127.0.0.1:54321/cb?x=1")
    await rejected(api, "http://127.0.0.1.evil.test:54321/cb?x=1")
    await rejected(api, "http://user@127.0.0.1:54321/cb?x=1")
  })

  test("loopbackAnyPort never widens a non-loopback web redirect", async () => {
    const api = make({
      redirectUris: ["http://app.test:8080/cb"],
      redirectPolicy: { loopbackAnyPort: true },
    })
    await rejected(api, "http://app.test:9090/cb")
  })

  test("the token exchange still requires the exact redirect_uri used to authorize", async () => {
    const api = make({
      redirectUris: ["http://127.0.0.1:8080/cb"],
      redirectPolicy: { loopbackAnyPort: true },
    })
    const finished = await signIn(api, {
      redirect_uri: "http://127.0.0.1:54321/cb",
      ...(await challenge()),
    })
    const response = await api.fetch(
      form("/token", {
        grant_type: "authorization_code",
        client_id: "app",
        code: codeOf(finished),
        redirect_uri: "http://127.0.0.1:8080/cb",
        code_verifier: verifier,
      }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
  })

  test("schemes: a dev-client scheme may vary host and port, but not path, query or scheme", async () => {
    const api = make({
      redirectUris: ["exp://localhost:8081/--/callback", "http://127.0.0.1:8080/cb"],
      redirectPolicy: { schemes: ["exp:"] },
    })
    expect((await redeem(api, "exp://192.168.1.20:8081/--/callback")).status).toBe(200)
    expect((await redeem(api, "exp://10.0.0.7:19000/--/callback")).status).toBe(200)
    await rejected(api, "exp://192.168.1.20:8081/--/other")
    await rejected(api, "exp://192.168.1.20:8081/--/callback?x=1")
    await rejected(api, "acme://192.168.1.20:8081/--/callback")
    await rejected(api, "exp://u:p@192.168.1.20:8081/--/callback")
    // loopbackAnyPort was not requested, so loopback ports stay exact
    await rejected(api, "http://127.0.0.1:54321/cb")
  })

  test("the policy is stored with the client and survives the admin API", async () => {
    const api = make({ redirectPolicy: { loopbackAnyPort: true, schemes: ["EXP:"] } })
    expect(api.clients.get("app")?.redirectPolicy).toEqual({
      loopbackAnyPort: true,
      schemes: ["EXP:"],
    })
  })

  test("invalid policies are rejected at registration", () => {
    for (const redirectPolicy of [
      { schemes: ["https:"] },
      { schemes: ["http:"] },
      { schemes: ["javascript:"] },
      { schemes: ["exp"] },
      { schemes: "exp:" },
      { loopbackAnyPort: "yes" },
      { wildcard: true },
      "loopback",
      null,
    ])
      expect(() => make({ redirectPolicy: redirectPolicy as never })).toThrow(/redirectPolicy/)
  })
})
