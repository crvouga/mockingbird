import { describe, expect, test } from "bun:test"
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  GetUserCommand,
  InitiateAuthCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider"
import {
  AuthenticationDetails,
  type CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js"
import { createServer } from "./src/server.js"

const poolId = "us-east-1_mockingbird"
const clientId = "mockingbird-client"

describe("official Cognito clients", () => {
  test("AWS SDK admin lifecycle, groups, pagination, JWT auth and revocation", async () => {
    const server = await createServer({ poolId, clientId })
    const client = new CognitoIdentityProviderClient({
      endpoint: server.url,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    try {
      const created = await client.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: "ada@example.test",
          TemporaryPassword: "Temporary1",
          UserAttributes: [{ Name: "email", Value: "ada@example.test" }],
        }),
      )
      expect(created.User?.UserStatus).toBe("FORCE_CHANGE_PASSWORD")
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: poolId,
          Username: "ada@example.test",
          Password: "Permanent1",
          Permanent: true,
        }),
      )
      await client.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: poolId,
          Username: "ada@example.test",
          GroupName: "clinicians",
        }),
      )
      expect(
        (
          await client.send(
            new AdminGetUserCommand({ UserPoolId: poolId, Username: "ada@example.test" }),
          )
        ).Enabled,
      ).toBe(true)
      const authenticated = await client.send(
        new InitiateAuthCommand({
          ClientId: clientId,
          AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: "ada@example.test", PASSWORD: "Permanent1" },
        }),
      )
      expect(authenticated.AuthenticationResult?.IdToken?.split(".")).toHaveLength(3)
      expect(
        (
          await client.send(
            new GetUserCommand({ AccessToken: authenticated.AuthenticationResult?.AccessToken }),
          )
        ).Username,
      ).toBe("ada@example.test")
      expect(
        (await client.send(new ListUsersCommand({ UserPoolId: poolId, Limit: 1 }))).Users,
      ).toHaveLength(1)
      await client.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: poolId, Username: "ada@example.test" }),
      )
      await expect(
        client.send(
          new GetUserCommand({ AccessToken: authenticated.AuthenticationResult?.AccessToken }),
        ),
      ).rejects.toMatchObject({ name: "NotAuthorizedException" })
    } finally {
      client.destroy()
      await server.close()
    }
  })

  test("amazon-cognito-identity-js signs up, confirms and authenticates unchanged", async () => {
    const server = await createServer({ poolId, clientId })
    try {
      const pool = new CognitoUserPool({
        UserPoolId: poolId,
        ClientId: clientId,
        endpoint: server.url,
      })
      const user = await new Promise<CognitoUser>((resolve, reject) =>
        pool.signUp("grace@example.test", "Password1", [], [], (error, result) =>
          error || !result
            ? reject(error ?? new Error("missing signup result"))
            : resolve(result.user),
        ),
      )
      await new Promise<void>((resolve, reject) =>
        user.confirmRegistration("123456", true, (error) => (error ? reject(error) : resolve())),
      )
      user.setAuthenticationFlowType("USER_PASSWORD_AUTH")
      const session = await new Promise<import("amazon-cognito-identity-js").CognitoUserSession>(
        (resolve, reject) =>
          user.authenticateUser(
            new AuthenticationDetails({ Username: "grace@example.test", Password: "Password1" }),
            { onSuccess: resolve, onFailure: reject },
          ),
      )
      expect(session.getIdToken().getJwtToken().split(".")).toHaveLength(3)
      expect(session.getRefreshToken().getToken()).toStartWith("refresh-")
      const refreshed = await new Promise<import("amazon-cognito-identity-js").CognitoUserSession>(
        (resolve, reject) =>
          user.refreshSession(session.getRefreshToken(), (error, result) =>
            error ? reject(error) : resolve(result),
          ),
      )
      expect(refreshed.getAccessToken().getJwtToken().split(".")).toHaveLength(3)
    } finally {
      await server.close()
    }
  })
})
