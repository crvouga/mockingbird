import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

// A refresh token belongs to the app client that received it. Cognito answers a refresh from
// any other client with NotAuthorizedException "Invalid Refresh Token":
// https://repost.aws/knowledge-center/cognito-invalid-refresh-token-error
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const user = { username: "fixture@example.test", password: "Synthetic1", confirmed: true }
const initiateAuth = (runtime: ReturnType<typeof createRuntime>, body: unknown) =>
  runtime.fetch(
    new Request("http://cognito.test/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify(body),
    }),
  )

describe("Cognito REFRESH_TOKEN_AUTH client binding", () => {
  test("a refresh token works only for the app client it was issued to", async () => {
    const runtime = createRuntime({ users: [user], poolId, clientId })
    const signIn = await initiateAuth(runtime, {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: user.username, PASSWORD: user.password },
    })
    const refreshToken = (await signIn.json()).AuthenticationResult.RefreshToken as string
    const refresh = (ClientId: string) =>
      initiateAuth(runtime, {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      })

    const other = await refresh("other-client")
    expect(other.status).toBe(400)
    expect(await other.json()).toEqual({
      __type: "NotAuthorizedException",
      message: "Invalid Refresh Token",
    })

    const same = await refresh(clientId)
    expect(same.status).toBe(200)
    expect((await same.json()).AuthenticationResult.AccessToken).toBeString()
  })
})
