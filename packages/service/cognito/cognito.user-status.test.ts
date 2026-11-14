import { describe, expect, test } from "bun:test"
import { CognitoAPI } from "./src/index.js"
import { type CognitoRuntimeOptions, createRuntime } from "./src/runtime.js"

// User-status and validation answers (#748). Best guesses from the Cognito API reference
// (each operation's Errors section) and the PreventUserExistenceErrors guide
// (cognito-user-pool-managing-errors), not oracle-verified.
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const ada = {
  username: "ada@example.test",
  password: "Synthetic1",
  confirmed: true,
  attributes: [{ Name: "email", Value: "ada@example.test" }],
}
type Fetcher = { fetch(request: Request): Promise<Response> }
const setup = (options: CognitoRuntimeOptions = {}) =>
  createRuntime({ poolId, clientId, users: [ada], ...options })
const rpc = async (runtime: Fetcher, target: string, body: Record<string, unknown>) => {
  const response = await runtime.fetch(
    new Request("http://cognito.test/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
        authorization: "AWS4-HMAC-SHA256 Credential=fixture/x",
      },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}

describe("user-status and validation answers (#748)", () => {
  test("a FORCE_CHANGE_PASSWORD user signing in gets NEW_PASSWORD_REQUIRED", async () => {
    const runtime = setup()
    await rpc(runtime, "AdminCreateUser", {
      UserPoolId: poolId,
      Username: "new@example.test",
      TemporaryPassword: "Temporary1",
      MessageAction: "SUPPRESS",
    })
    const result = await rpc(runtime, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: "new@example.test", PASSWORD: "Temporary1" },
    })
    expect(result.status).toBe(200)
    expect(result.body.ChallengeName).toBe("NEW_PASSWORD_REQUIRED")
    const done = await rpc(runtime, "RespondToAuthChallenge", {
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: clientId,
      Session: result.body.Session,
      ChallengeResponses: { USERNAME: "new@example.test", NEW_PASSWORD: "Permanent1" },
    })
    expect(done.body.AuthenticationResult.AccessToken).toBeString()
  })

  test("confirming or resending a code for a confirmed user is an error", async () => {
    const runtime = setup()
    expect(
      await rpc(runtime, "ResendConfirmationCode", { ClientId: clientId, Username: ada.username }),
    ).toEqual({
      status: 400,
      body: { __type: "InvalidParameterException", message: "User is already confirmed." },
    })
    const notAuthorized = {
      status: 400,
      body: {
        __type: "NotAuthorizedException",
        message: "User cannot be confirmed. Current status is CONFIRMED",
      },
    }
    expect(
      await rpc(runtime, "AdminConfirmSignUp", { UserPoolId: poolId, Username: ada.username }),
    ).toEqual(notAuthorized)
    expect(
      await rpc(runtime, "ConfirmSignUp", {
        ClientId: clientId,
        Username: ada.username,
        ConfirmationCode: "123456",
      }),
    ).toEqual(notAuthorized)
  })

  test("an unknown ClientId or UserPoolId is ResourceNotFoundException", async () => {
    const runtime = setup()
    expect(
      await rpc(runtime, "InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: "unknown-client",
        AuthParameters: { USERNAME: ada.username, PASSWORD: ada.password },
      }),
    ).toEqual({
      status: 400,
      body: {
        __type: "ResourceNotFoundException",
        message: "User pool client unknown-client does not exist.",
      },
    })
    expect(
      await rpc(runtime, "AdminGetUser", {
        UserPoolId: "us-east-1_other",
        Username: ada.username,
      }),
    ).toEqual({
      status: 400,
      body: {
        __type: "ResourceNotFoundException",
        message: "User pool us-east-1_other does not exist.",
      },
    })
  })

  test("PreventUserExistenceErrors on the app client simulates ForgotPassword success", async () => {
    const legacy = await rpc(setup(), "ForgotPassword", {
      ClientId: clientId,
      Username: "nobody@example.test",
    })
    expect(legacy.body.__type).toBe("UserNotFoundException")
    const runtime = setup({
      appClients: [{ clientId, callbackUrls: [], preventUserExistenceErrors: true }],
    })
    const simulated = await rpc(runtime, "ForgotPassword", {
      ClientId: clientId,
      Username: "nobody@example.test",
    })
    expect(simulated.status).toBe(200)
    expect(simulated.body.CodeDeliveryDetails).toMatchObject({
      DeliveryMedium: "EMAIL",
      AttributeName: "email",
    })
    const outbox = await runtime.fetch(new Request("http://cognito.test/__admin/outbox"))
    expect((await outbox.json()).messages).toEqual([])
  })

  test("AdminSetUserPassword moves UserLastModifiedDate", async () => {
    let now = Date.parse("2030-01-01T00:00:00Z")
    const api = new CognitoAPI({
      poolId,
      clientId,
      users: [{ ...ada, createdAt: now }],
      now: () => now,
    })
    const before = await rpc(api, "AdminGetUser", { UserPoolId: poolId, Username: ada.username })
    now += 60_000
    await rpc(api, "AdminSetUserPassword", {
      UserPoolId: poolId,
      Username: ada.username,
      Password: "Changed12",
      Permanent: true,
    })
    const after = await rpc(api, "AdminGetUser", { UserPoolId: poolId, Username: ada.username })
    expect(before.body.UserLastModifiedDate).toBe(now / 1000 - 60)
    expect(after.body.UserLastModifiedDate).toBe(now / 1000)
  })
})
