import { expect, test } from "bun:test"
import { digest } from "./src/crypto.js"
import { createRuntime } from "./src/index.js"

// "code_verifier ... is required when the client secret is not present":
// https://workos.com/docs/reference/authkit/authentication/code
// WorkOS's browser SDK exchanges and refreshes with client_id alone (no client_secret):
// https://github.com/workos/authkit-js/blob/main/src/http-client.ts
const origin = "http://mock.workos.local"
const runtime = () => createRuntime()
const authorize = async (api: ReturnType<typeof createRuntime>, challenge?: string) => {
  const url = new URL(`${origin}/user_management/authorize`)
  url.search = new URLSearchParams({
    client_id: "client_mock",
    redirect_uri: "http://localhost:3000/callback",
    response_type: "code",
    provider: "authkit",
    ...(challenge ? { code_challenge: challenge, code_challenge_method: "S256" } : {}),
  }).toString()
  const location = (await api.fetch(new Request(url))).headers.get("location") ?? ""
  return new URL(location).searchParams.get("code") ?? ""
}
const authenticate = (api: ReturnType<typeof createRuntime>, body: Record<string, unknown>) =>
  api.fetch(
    new Request(`${origin}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "client_mock", ...body }),
    }),
  )
const verifier = "synthetic-pkce-verifier-for-a-public-client-exchange"

test("a PKCE client exchanges a code and refreshes without a client secret", async () => {
  const api = runtime()
  const code = await authorize(api, await digest(verifier))
  const exchanged = await authenticate(api, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  })
  expect(exchanged.status).toBe(200)
  const { refresh_token } = (await exchanged.json()) as { refresh_token: string }
  const refreshed = await authenticate(api, { grant_type: "refresh_token", refresh_token })
  expect(refreshed.status).toBe(200)
})

test("without a client secret the code must carry a challenge and the verifier must match", async () => {
  const api = runtime()
  const wrong = await authenticate(api, {
    grant_type: "authorization_code",
    code: await authorize(api, await digest(verifier)),
    code_verifier: "synthetic-pkce-verifier-that-does-not-match-the-code",
  })
  expect(wrong.status).toBe(400)
  const missing = await authenticate(api, {
    grant_type: "authorization_code",
    code: await authorize(api, await digest(verifier)),
  })
  expect(missing.status).toBe(401)
  const noChallenge = await authenticate(api, {
    grant_type: "authorization_code",
    code: await authorize(api),
    code_verifier: verifier,
  })
  expect(noChallenge.status).toBe(400)
})

test("a session from a secret exchange still needs the secret to refresh", async () => {
  const api = runtime()
  const exchanged = await authenticate(api, {
    grant_type: "authorization_code",
    client_secret: "mock_workos_key",
    code: await authorize(api),
  })
  const { refresh_token } = (await exchanged.json()) as { refresh_token: string }
  const refreshed = await authenticate(api, { grant_type: "refresh_token", refresh_token })
  expect(refreshed.status).toBe(401)
})
