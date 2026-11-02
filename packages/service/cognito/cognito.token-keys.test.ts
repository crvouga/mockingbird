import { describe, expect, test } from "bun:test"
import { createPublicKey, type JsonWebKey, verify } from "node:crypto"
import { createRuntime } from "./src/runtime.js"

// "Amazon Cognito generates two pairs of RSA cryptographic keys for each user pool. One private
// key signs access tokens, and the other signs ID tokens."
// https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
// Both token types carry jti; origin_jti and event_id tie them to the sign-in and its refresh
// token: https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const user = { username: "fixture@example.test", password: "Synthetic1", confirmed: true }
const parts = (token: string) => {
  const [head, body, signature] = token.split(".") as [string, string, string]
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString())
  return { head, body, signature, header: decode(head), claims: decode(body) }
}
const call = (runtime: ReturnType<typeof createRuntime>, path: string, body?: unknown) =>
  runtime.fetch(
    new Request(`http://cognito.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const signIn = async (runtime: ReturnType<typeof createRuntime>) =>
  (
    await (
      await call(runtime, "/", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: user.username, PASSWORD: user.password },
      })
    ).json()
  ).AuthenticationResult
const refresh = async (runtime: ReturnType<typeof createRuntime>, token: string) =>
  (
    await (
      await call(runtime, "/", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: token },
      })
    ).json()
  ).AuthenticationResult
const jwks = async (runtime: ReturnType<typeof createRuntime>) =>
  (await (await call(runtime, `/${poolId}/.well-known/jwks.json`)).json()).keys as (JsonWebKey & {
    kid: string
  })[]
const verifies = (token: string, keys: (JsonWebKey & { kid: string })[]) => {
  const { head, body, signature, header } = parts(token)
  const key = keys.find((candidate) => candidate.kid === header.kid)
  return (
    key !== undefined &&
    verify(
      "RSA-SHA256",
      Buffer.from(`${head}.${body}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    )
  )
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("Cognito token signing keys and token identifiers", () => {
  test("the JWKS publishes two keys and ID and access tokens are signed with different ones", async () => {
    const runtime = createRuntime({ users: [user], poolId, clientId })
    const tokens = await signIn(runtime)
    const keys = await jwks(runtime)
    expect(keys).toHaveLength(2)
    const idKid = parts(tokens.IdToken).header.kid
    const accessKid = parts(tokens.AccessToken).header.kid
    expect(idKid).not.toBe(accessKid)
    expect(keys.map((key) => key.kid).sort()).toEqual([idKid, accessKid].sort())
    expect(verifies(tokens.IdToken, keys)).toBe(true)
    expect(verifies(tokens.AccessToken, keys)).toBe(true)
  })

  test("rotation replaces both keys and keeps prior pairs verifiable", async () => {
    const runtime = createRuntime({ users: [user], poolId, clientId })
    const before = await signIn(runtime)
    await call(runtime, "/__admin/keys/rotate", { retainPrevious: true })
    const after = await signIn(runtime)
    const keys = await jwks(runtime)
    expect(keys).toHaveLength(4)
    for (const token of [before.IdToken, before.AccessToken, after.IdToken, after.AccessToken])
      expect(verifies(token, keys)).toBe(true)
    expect(parts(after.IdToken).header.kid).not.toBe(parts(before.IdToken).header.kid)
    expect(parts(after.AccessToken).header.kid).not.toBe(parts(before.AccessToken).header.kid)
  })

  test("tokens carry jti, origin_jti and event_id; refreshes keep origin_jti and event_id", async () => {
    const runtime = createRuntime({ users: [user], poolId, clientId })
    const first = await signIn(runtime)
    const id = parts(first.IdToken).claims
    const access = parts(first.AccessToken).claims
    for (const claims of [id, access])
      for (const claim of ["jti", "origin_jti", "event_id"]) expect(claims[claim]).toMatch(uuid)
    expect(id.jti).not.toBe(access.jti)
    expect(id.origin_jti).toBe(access.origin_jti)
    expect(id.event_id).toBe(access.event_id)

    const refreshed = parts((await refresh(runtime, first.RefreshToken)).AccessToken).claims
    expect(refreshed.jti).not.toBe(access.jti)
    expect(refreshed.origin_jti).toBe(access.origin_jti)
    expect(refreshed.event_id).toBe(access.event_id)

    const second = parts((await signIn(runtime)).AccessToken).claims
    expect(second.origin_jti).not.toBe(access.origin_jti)
    expect(second.event_id).not.toBe(access.event_id)
  })
})
