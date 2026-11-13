import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

// Operations that used to answer UnknownOperationException (#749). Shapes follow the Cognito API
// reference for each operation; best guesses, not oracle-verified.
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const ada = {
  username: "ada@example.test",
  password: "Synthetic1",
  confirmed: true,
  attributes: [
    { Name: "email", Value: "ada@example.test" },
    { Name: "name", Value: "Ada" },
  ],
}
type Runtime = ReturnType<typeof createRuntime>
const setup = () => createRuntime({ poolId, clientId, users: [ada] })
const rpc = async (
  runtime: Runtime,
  target: string,
  body: Record<string, unknown>,
  signed = true,
) => {
  const response = await runtime.fetch(
    new Request("http://cognito.test/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
        ...(signed ? { authorization: "AWS4-HMAC-SHA256 Credential=fixture/x" } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}
const signIn = async (runtime: Runtime, password = ada.password) =>
  (
    await rpc(runtime, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: ada.username, PASSWORD: password },
    })
  ).body.AuthenticationResult as { AccessToken: string; RefreshToken: string }
const getUser = (runtime: Runtime, AccessToken: string) => rpc(runtime, "GetUser", { AccessToken })
const refresh = (runtime: Runtime, REFRESH_TOKEN: string) =>
  rpc(runtime, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: clientId,
    AuthParameters: { REFRESH_TOKEN },
  })
const user = { UserPoolId: poolId, Username: ada.username }

describe("operations beyond the original subset (#749)", () => {
  test("GlobalSignOut revokes the caller's access and refresh tokens", async () => {
    const runtime = setup()
    const tokens = await signIn(runtime)
    expect((await rpc(runtime, "GlobalSignOut", { AccessToken: tokens.AccessToken })).status).toBe(
      200,
    )
    expect((await getUser(runtime, tokens.AccessToken)).body.__type).toBe("NotAuthorizedException")
    expect((await refresh(runtime, tokens.RefreshToken)).body.__type).toBe("NotAuthorizedException")
  })

  test("RevokeToken revokes a refresh token and the access tokens issued with it", async () => {
    const runtime = setup()
    const revoked = await signIn(runtime)
    const kept = await signIn(runtime)
    expect(
      (await rpc(runtime, "RevokeToken", { Token: revoked.RefreshToken, ClientId: clientId }))
        .status,
    ).toBe(200)
    expect((await refresh(runtime, revoked.RefreshToken)).status).toBe(400)
    expect((await getUser(runtime, revoked.AccessToken)).status).toBe(400)
    expect((await getUser(runtime, kept.AccessToken)).status).toBe(200)
    const access = await rpc(runtime, "RevokeToken", {
      Token: kept.AccessToken,
      ClientId: clientId,
    })
    expect(access.body.__type).toBe("UnsupportedTokenTypeException")
  })

  test("UpdateUserAttributes changes the caller's attributes", async () => {
    const runtime = setup()
    const { AccessToken } = await signIn(runtime)
    const result = await rpc(runtime, "UpdateUserAttributes", {
      AccessToken,
      UserAttributes: [{ Name: "name", Value: "Countess" }],
    })
    expect(result.status).toBe(200)
    expect((await getUser(runtime, AccessToken)).body.UserAttributes).toContainEqual({
      Name: "name",
      Value: "Countess",
    })
  })

  test("AdminInitiateAuth ADMIN_USER_PASSWORD_AUTH returns tokens and needs credentials", async () => {
    const runtime = setup()
    const body = {
      ...user,
      ClientId: clientId,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: ada.username, PASSWORD: ada.password },
    }
    const result = await rpc(runtime, "AdminInitiateAuth", body)
    expect(result.status).toBe(200)
    expect(result.body.AuthenticationResult.IdToken).toBeString()
    expect((await rpc(runtime, "AdminInitiateAuth", body, false)).body.__type).toBe(
      "UnrecognizedClientException",
    )
  })

  test("AdminResetUserPassword requires a reset before the next sign-in", async () => {
    const runtime = setup()
    expect((await rpc(runtime, "AdminResetUserPassword", user)).status).toBe(200)
    expect((await rpc(runtime, "AdminGetUser", user)).body.UserStatus).toBe("RESET_REQUIRED")
    const blocked = await rpc(runtime, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: ada.username, PASSWORD: ada.password },
    })
    expect(blocked.body.__type).toBe("PasswordResetRequiredException")
    const { resetCode } = await (
      await runtime.fetch(new Request(`http://cognito.test/__admin/codes?username=${ada.username}`))
    ).json()
    await rpc(runtime, "ConfirmForgotPassword", {
      ClientId: clientId,
      Username: ada.username,
      ConfirmationCode: resetCode,
      Password: "Renewed12",
    })
    expect((await rpc(runtime, "AdminGetUser", user)).body.UserStatus).toBe("CONFIRMED")
    expect((await signIn(runtime, "Renewed12")).AccessToken).toBeString()
  })

  test("AdminDisableUser blocks sign-in and revokes tokens; AdminEnableUser restores it", async () => {
    const runtime = setup()
    const tokens = await signIn(runtime)
    expect((await rpc(runtime, "AdminDisableUser", user)).status).toBe(200)
    expect((await rpc(runtime, "AdminGetUser", user)).body.Enabled).toBe(false)
    expect((await getUser(runtime, tokens.AccessToken)).status).toBe(400)
    const disabled = await rpc(runtime, "InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: ada.username, PASSWORD: ada.password },
    })
    expect(disabled.body).toEqual({
      __type: "NotAuthorizedException",
      message: "User is disabled.",
    })
    expect((await rpc(runtime, "AdminEnableUser", user)).status).toBe(200)
    expect((await signIn(runtime)).AccessToken).toBeString()
  })

  test("groups: CreateGroup, membership, AdminListGroupsForUser and ListUsersInGroup", async () => {
    const runtime = setup()
    const created = await rpc(runtime, "CreateGroup", {
      UserPoolId: poolId,
      GroupName: "clinicians",
      Description: "Care team",
      Precedence: 1,
    })
    expect(created.body.Group).toMatchObject({
      GroupName: "clinicians",
      UserPoolId: poolId,
      Description: "Care team",
      Precedence: 1,
    })
    expect(
      (await rpc(runtime, "CreateGroup", { UserPoolId: poolId, GroupName: "clinicians" })).body
        .__type,
    ).toBe("GroupExistsException")
    expect(
      (await rpc(runtime, "AdminAddUserToGroup", { ...user, GroupName: "missing" })).body.__type,
    ).toBe("ResourceNotFoundException")
    await rpc(runtime, "AdminAddUserToGroup", { ...user, GroupName: "clinicians" })
    const groups = await rpc(runtime, "AdminListGroupsForUser", user)
    expect(groups.body.Groups.map((g: { GroupName: string }) => g.GroupName)).toEqual([
      "clinicians",
    ])
    const members = await rpc(runtime, "ListUsersInGroup", {
      UserPoolId: poolId,
      GroupName: "clinicians",
    })
    expect(members.body.Users.map((u: { Username: string }) => u.Username)).toEqual([ada.username])
  })

  test("DescribeUserPool and DescribeUserPoolClient describe the pool and client", async () => {
    const runtime = setup()
    const pool = await rpc(runtime, "DescribeUserPool", { UserPoolId: poolId })
    expect(pool.body.UserPool).toMatchObject({
      Id: poolId,
      UsernameConfiguration: { CaseSensitive: false },
      EstimatedNumberOfUsers: 1,
    })
    const client = await rpc(runtime, "DescribeUserPoolClient", {
      UserPoolId: poolId,
      ClientId: clientId,
    })
    expect(client.body.UserPoolClient).toMatchObject({
      UserPoolId: poolId,
      ClientId: clientId,
      PreventUserExistenceErrors: "LEGACY",
    })
    expect(
      (await rpc(runtime, "DescribeUserPoolClient", { UserPoolId: poolId, ClientId: "nope" })).body
        .__type,
    ).toBe("ResourceNotFoundException")
  })

  test("AdminDeleteUserAttributes removes the named attributes", async () => {
    const runtime = setup()
    await rpc(runtime, "AdminDeleteUserAttributes", { ...user, UserAttributeNames: ["name"] })
    const attributes = (await rpc(runtime, "AdminGetUser", user)).body.UserAttributes
    expect(attributes.map((a: { Name: string }) => a.Name)).toEqual(["sub", "email"])
  })

  test("GetTokensFromRefreshToken returns fresh access and ID tokens", async () => {
    const runtime = setup()
    const { RefreshToken } = await signIn(runtime)
    const result = await rpc(runtime, "GetTokensFromRefreshToken", {
      RefreshToken,
      ClientId: clientId,
    })
    expect(result.status).toBe(200)
    expect(result.body.AuthenticationResult).toMatchObject({ TokenType: "Bearer", ExpiresIn: 3600 })
    expect((await getUser(runtime, result.body.AuthenticationResult.AccessToken)).status).toBe(200)
  })
})
