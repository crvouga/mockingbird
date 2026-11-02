import { describe, expect, test } from "bun:test"
import { CognitoAPI } from "./src/index.js"

// auth_time is "the authentication time ... when your user completed authentication":
// https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html
// A refresh is not an authentication, so refreshed tokens keep the original sign-in time.
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const user = { username: "fixture@example.test", password: "Synthetic1", confirmed: true }
const signedInAt = Date.parse("2030-01-01T00:00:00Z")
const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString())
const initiateAuth = async (api: CognitoAPI, body: unknown) =>
  (
    await (
      await api.fetch(
        new Request("http://cognito.test/", {
          method: "POST",
          headers: {
            "content-type": "application/x-amz-json-1.1",
            "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
          },
          body: JSON.stringify(body),
        }),
      )
    ).json()
  ).AuthenticationResult

describe("Cognito REFRESH_TOKEN_AUTH auth_time", () => {
  test("refreshed tokens keep the original sign-in time in auth_time", async () => {
    let now = signedInAt
    const api = new CognitoAPI({ users: [user], poolId, clientId, now: () => now })
    const signIn = await initiateAuth(api, {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: user.username, PASSWORD: user.password },
    })
    now += 2 * 3600 * 1000
    const refreshed = await initiateAuth(api, {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: clientId,
      AuthParameters: { REFRESH_TOKEN: signIn.RefreshToken },
    })
    for (const token of [refreshed.IdToken, refreshed.AccessToken]) {
      const claims = decode(token)
      expect(claims.auth_time).toBe(signedInAt / 1000)
      expect(claims.iat).toBe(now / 1000)
    }
  })
})
