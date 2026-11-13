import { describe, expect, test } from "bun:test"
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js"
import { createRuntime } from "./src/runtime.js"
import { createServer } from "./src/server.js"

// USER_SRP_AUTH (#746): InitiateAuth answers PASSWORD_VERIFIER and RespondToAuthChallenge checks
// the SRP-6a password claim, as amazon-cognito-identity-js's default authenticateUser computes it.
// Flows the emulator does not model answer an explicit InvalidParameterException.
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const ada = {
  username: "ada@example.test",
  password: "Synthetic1",
  confirmed: true,
  attributes: [{ Name: "email", Value: "ada@example.test" }],
}
const temporary = {
  username: "temp@example.test",
  password: "Temporary1",
  status: "FORCE_CHANGE_PASSWORD",
}
const authenticate = (user: CognitoUser, password: string) =>
  new Promise<CognitoUserSession | "newPasswordRequired">((resolve, reject) =>
    user.authenticateUser(
      new AuthenticationDetails({ Username: user.getUsername(), Password: password }),
      {
        onSuccess: resolve,
        onFailure: reject,
        newPasswordRequired: () => resolve("newPasswordRequired"),
      },
    ),
  )
const withPool = async (run: (pool: CognitoUserPool) => Promise<void>) => {
  const server = await createServer({ poolId, clientId, users: [ada, temporary] })
  try {
    await run(new CognitoUserPool({ UserPoolId: poolId, ClientId: clientId, endpoint: server.url }))
  } finally {
    await server.close()
  }
}
const initiateAuth = async (AuthFlow: string, AuthParameters: Record<string, string> = {}) => {
  const runtime = createRuntime({ poolId, clientId, users: [ada] })
  const response = await runtime.fetch(
    new Request("http://cognito.test/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({ AuthFlow, ClientId: clientId, AuthParameters }),
    }),
  )
  return { status: response.status, body: await response.json() }
}

describe("USER_SRP_AUTH (#746)", () => {
  test("amazon-cognito-identity-js signs in with its default SRP flow", async () => {
    await withPool(async (pool) => {
      const user = new CognitoUser({ Username: ada.username, Pool: pool })
      const session = await authenticate(user, ada.password)
      if (session === "newPasswordRequired") throw new Error("unexpected challenge")
      expect(session.getIdToken().decodePayload().email).toBe(ada.username)
      expect(session.getRefreshToken().getToken()).toStartWith("refresh-")
    })
  })

  test("a wrong password fails the password verifier with NotAuthorizedException", async () => {
    await withPool(async (pool) => {
      const user = new CognitoUser({ Username: ada.username, Pool: pool })
      await expect(authenticate(user, "Wrong1234")).rejects.toMatchObject({
        code: "NotAuthorizedException",
        message: "Incorrect username or password.",
      })
    })
  })

  test("a FORCE_CHANGE_PASSWORD user gets NEW_PASSWORD_REQUIRED after the verifier", async () => {
    await withPool(async (pool) => {
      const user = new CognitoUser({ Username: temporary.username, Pool: pool })
      expect(await authenticate(user, temporary.password)).toBe("newPasswordRequired")
    })
  })

  test("CUSTOM_AUTH and other unmodelled flows answer an explicit unsupported error", async () => {
    for (const flow of ["CUSTOM_AUTH", "USER_AUTH"]) {
      const result = await initiateAuth(flow, { USERNAME: ada.username })
      expect(result.status).toBe(400)
      expect(result.body).toEqual({
        __type: "InvalidParameterException",
        message: `AuthFlow ${flow} is not supported by the Mockingbird Cognito emulator.`,
      })
    }
    const admin = await initiateAuth("ADMIN_USER_PASSWORD_AUTH", { USERNAME: ada.username })
    expect(admin.body).toEqual({
      __type: "InvalidParameterException",
      message: "Initiate Auth method not supported.",
    })
    const unknown = await initiateAuth("NOT_A_FLOW")
    expect(unknown.body.__type).toBe("InvalidParameterException")
  })
})
