import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { pkce } from "./test/consumer.js"

// Apps registered as type "client" pass client_id in the body "instead of the Authorization
// header" on the token, refresh and revoke endpoints:
// https://dev.fitbit.com/build/reference/web-api/authorization/oauth2-token/
// https://dev.fitbit.com/build/reference/web-api/authorization/refresh-token/
// https://dev.fitbit.com/build/reference/web-api/authorization/revoke-token/
const base = "http://fitbit.test"
const redirectUri = "http://localhost:8000/callback"
const clients = [
  { id: "public_app", secret: "unused_secret", type: "client" as const },
  { id: "server_app", secret: "server_secret" },
]
const form = (path: string, body: Record<string, string>) =>
  new Request(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  })
const authorize = async (runtime: ReturnType<typeof createRuntime>, clientId: string) => {
  const { verifier, challenge } = await pkce()
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "profile activity",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const response = await runtime.fetch(
    new Request(`${base}/oauth2/authorize?${query}`, { redirect: "manual" }),
  )
  const code = new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? ""
  return { code, verifier }
}
const errorType = async (response: Response) =>
  ((await response.json()) as { errors: { errorType: string }[] }).errors[0]?.errorType

describe("Fitbit public (client type) apps", () => {
  test("exchange, refresh and revoke with client_id in the body and no Authorization header", async () => {
    const runtime = createRuntime({ clients })
    const { code, verifier } = await authorize(runtime, "public_app")
    const exchanged = await runtime.fetch(
      form("/oauth2/token", {
        client_id: "public_app",
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    )
    expect(exchanged.status).toBe(200)
    const first = (await exchanged.json()) as { access_token: string; refresh_token: string }

    const refreshed = await runtime.fetch(
      form("/oauth2/token", {
        client_id: "public_app",
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
      }),
    )
    expect(refreshed.status).toBe(200)
    const second = (await refreshed.json()) as { access_token: string }

    const revoked = await runtime.fetch(
      form("/oauth2/revoke", { client_id: "public_app", token: second.access_token }),
    )
    expect(revoked.status).toBe(200)
    const profile = await runtime.fetch(
      new Request(`${base}/1/user/-/profile.json`, {
        headers: { authorization: `Bearer ${second.access_token}` },
      }),
    )
    expect(profile.status).toBe(401)
  })

  test("a server app still needs HTTP Basic credentials", async () => {
    const runtime = createRuntime({ clients })
    const { code, verifier } = await authorize(runtime, "server_app")
    const bodyOnly = await runtime.fetch(
      form("/oauth2/token", {
        client_id: "server_app",
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    )
    expect(bodyOnly.status).toBe(401)
    expect(await errorType(bodyOnly)).toBe("invalid_client")
  })

  test("a public app cannot exchange another client's code or name no client", async () => {
    const runtime = createRuntime({ clients })
    const { code, verifier } = await authorize(runtime, "server_app")
    const stolen = await runtime.fetch(
      form("/oauth2/token", {
        client_id: "public_app",
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    )
    expect(stolen.status).toBe(400)
    expect(await errorType(stolen)).toBe("invalid_grant")
    const anonymous = await runtime.fetch(
      form("/oauth2/token", { grant_type: "refresh_token", refresh_token: "x" }),
    )
    expect(anonymous.status).toBe(401)
  })
})
