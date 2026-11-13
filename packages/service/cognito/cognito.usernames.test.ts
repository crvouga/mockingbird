import { describe, expect, test } from "bun:test"
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider"
import { type CognitoRuntimeOptions, createRuntime } from "./src/runtime.js"
import { createServer } from "./src/server.js"

// Usernames, aliases and attribute rules (#744, #745, #747). Best guesses from the Cognito API
// reference and developer guide (user-pool-settings-attributes, UsernameConfiguration), not
// oracle-verified.
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const ada = {
  username: "ada@example.test",
  password: "Synthetic1",
  sub: "00000000-0000-4000-8000-00000000000a",
  confirmed: true,
  attributes: [{ Name: "email", Value: "ada@example.test" }],
}
const grace = {
  username: "grace",
  password: "Synthetic1",
  confirmed: true,
  attributes: [{ Name: "email", Value: "grace@example.test" }],
}
type Runtime = ReturnType<typeof createRuntime>
const setup = (options: CognitoRuntimeOptions = {}) =>
  createRuntime({ poolId, clientId, users: [ada, grace], ...options })
const rpc = async (runtime: Runtime, target: string, body: Record<string, unknown>) => {
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
const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString())
const signIn = (runtime: Runtime, username: string, password = "Synthetic1") =>
  rpc(runtime, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: clientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  })

describe("AdminGetUser response shape (#744)", () => {
  test("AdminGetUser returns UserAttributes, which the AWS SDK reads", async () => {
    const raw = await rpc(setup(), "AdminGetUser", { UserPoolId: poolId, Username: ada.username })
    expect(raw.body.Attributes).toBeUndefined()
    expect(raw.body.UserAttributes).toEqual([
      { Name: "sub", Value: ada.sub },
      { Name: "email", Value: "ada@example.test" },
    ])
    const server = await createServer({ poolId, clientId, users: [ada] })
    const client = new CognitoIdentityProviderClient({
      endpoint: server.url,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    try {
      const user = await client.send(
        new AdminGetUserCommand({ UserPoolId: poolId, Username: ada.username }),
      )
      expect(user.UserAttributes?.find((a) => a.Name === "sub")?.Value).toBe(ada.sub)
    } finally {
      client.destroy()
      await server.close()
    }
  })
})

describe("the sub as Username, and email as the sign-in attribute (#745)", () => {
  test("admin operations accept the sub as Username", async () => {
    const runtime = setup()
    const byUsername = { UserPoolId: poolId, Username: ada.sub }
    expect((await rpc(runtime, "AdminGetUser", byUsername)).body.Username).toBe(ada.username)
    expect(
      (
        await rpc(runtime, "AdminUpdateUserAttributes", {
          ...byUsername,
          UserAttributes: [{ Name: "name", Value: "Ada" }],
        })
      ).status,
    ).toBe(200)
    expect(
      (await rpc(runtime, "AdminSetUserPassword", { ...byUsername, Password: "Changed1x" })).status,
    ).toBe(200)
    expect((await rpc(runtime, "AdminUserGlobalSignOut", byUsername)).status).toBe(200)
    await rpc(runtime, "SignUp", {
      ClientId: clientId,
      Username: "new@example.test",
      Password: "Synthetic1",
      UserAttributes: [{ Name: "email", Value: "new@example.test" }],
    })
    const created = await rpc(runtime, "AdminGetUser", {
      UserPoolId: poolId,
      Username: "new@example.test",
    })
    const sub = created.body.UserAttributes.find((a: { Name: string }) => a.Name === "sub").Value
    expect(
      (await rpc(runtime, "AdminConfirmSignUp", { UserPoolId: poolId, Username: sub })).status,
    ).toBe(200)
  })

  test("with usernameAttributes ['email'], Cognito generates the username: the sub", async () => {
    const runtime = setup({ users: [], usernameAttributes: ["email"] })
    const signUp = await rpc(runtime, "SignUp", {
      ClientId: clientId,
      Username: "lin@example.test",
      Password: "Synthetic1",
    })
    expect(signUp.status).toBe(200)
    const sub = signUp.body.UserSub as string
    const user = await rpc(runtime, "AdminGetUser", {
      UserPoolId: poolId,
      Username: "lin@example.test",
    })
    expect(user.body.Username).toBe(sub)
    expect(user.body.UserAttributes).toContainEqual({ Name: "email", Value: "lin@example.test" })
    await rpc(runtime, "AdminConfirmSignUp", { UserPoolId: poolId, Username: sub })
    const tokens = (await signIn(runtime, "lin@example.test")).body.AuthenticationResult
    expect(claims(tokens.IdToken)["cognito:username"]).toBe(sub)
    expect(claims(tokens.AccessToken).username).toBe(sub)

    const created = await rpc(runtime, "AdminCreateUser", {
      UserPoolId: poolId,
      Username: "kay@example.test",
      MessageAction: "SUPPRESS",
    })
    const createdSub = created.body.User.Attributes.find((a: { Name: string }) => a.Name === "sub")
    expect(created.body.User.Username).toBe(createdSub.Value)
  })
})

describe("email uniqueness, case-insensitivity and format (#747)", () => {
  test("setting an email another user holds is AliasExistsException", async () => {
    const runtime = setup()
    const result = await rpc(runtime, "AdminUpdateUserAttributes", {
      UserPoolId: poolId,
      Username: "grace",
      UserAttributes: [{ Name: "email", Value: "ADA@example.test" }],
    })
    expect(result.status).toBe(400)
    expect(result.body.__type).toBe("AliasExistsException")
    const access = (await signIn(runtime, "grace")).body.AuthenticationResult.AccessToken
    const own = await rpc(runtime, "UpdateUserAttributes", {
      AccessToken: access,
      UserAttributes: [{ Name: "email", Value: "ada@example.test" }],
    })
    expect(own.body.__type).toBe("AliasExistsException")
  })

  test("usernames and email aliases are case-insensitive by default", async () => {
    const runtime = setup()
    const duplicate = await rpc(runtime, "AdminCreateUser", {
      UserPoolId: poolId,
      Username: "ADA@example.test",
      MessageAction: "SUPPRESS",
    })
    expect(duplicate.status).toBe(400)
    expect(duplicate.body.__type).toBe("UsernameExistsException")
    expect((await signIn(runtime, "ADA@Example.Test")).status).toBe(200)
    expect((await signIn(runtime, "GRACE")).status).toBe(200)
  })

  test("usernameCaseSensitive: true keeps differently cased usernames distinct", async () => {
    const runtime = setup({ usernameCaseSensitive: true })
    expect((await signIn(runtime, "GRACE")).status).toBe(400)
    const created = await rpc(runtime, "AdminCreateUser", {
      UserPoolId: poolId,
      Username: "GRACE",
      MessageAction: "SUPPRESS",
    })
    expect(created.status).toBe(200)
  })

  test("a malformed email is InvalidParameterException", async () => {
    const runtime = setup({ usernameAttributes: ["email"] })
    const username = await rpc(runtime, "SignUp", {
      ClientId: clientId,
      Username: "not-an-email",
      Password: "Synthetic1",
    })
    expect(username.status).toBe(400)
    expect(username.body).toEqual({
      __type: "InvalidParameterException",
      message: "Username should be an email.",
    })
    const attribute = await rpc(setup(), "SignUp", {
      ClientId: clientId,
      Username: "lin",
      Password: "Synthetic1",
      UserAttributes: [{ Name: "email", Value: "not-an-email" }],
    })
    expect(attribute.body).toEqual({
      __type: "InvalidParameterException",
      message: "Invalid email address format.",
    })
  })
})
