import { describe, expect, test } from "bun:test"
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager"
import {
  GetParameterCommand,
  GetParametersCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm"
import { createServer } from "./src/server.js"

const clients = (endpoint: string) => {
  const common = {
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  }
  return { secrets: new SecretsManagerClient(common), ssm: new SSMClient(common) }
}

describe("official AWS secret clients against the mock", () => {
  test("Secrets Manager creates, rotates and reads deterministic stages by name or ARN", async () => {
    const server = await createServer()
    const { secrets } = clients(server.url)
    try {
      const created = await secrets.send(
        new CreateSecretCommand({
          Name: "database/password",
          SecretString: "first",
          Description: "fixture",
        }),
      )
      expect(created.ARN).toContain(":secret:database/password-")
      expect(
        (await secrets.send(new GetSecretValueCommand({ SecretId: created.ARN }))).SecretString,
      ).toBe("first")
      const rotated = await secrets.send(
        new PutSecretValueCommand({ SecretId: "database/password", SecretString: "second" }),
      )
      expect(
        (
          await secrets.send(
            new GetSecretValueCommand({
              SecretId: "database/password",
              VersionStage: "AWSCURRENT",
            }),
          )
        ).SecretString,
      ).toBe("second")
      expect(
        (
          await secrets.send(
            new GetSecretValueCommand({
              SecretId: "database/password",
              VersionStage: "AWSPREVIOUS",
            }),
          )
        ).SecretString,
      ).toBe("first")
      expect(
        (
          await secrets.send(
            new GetSecretValueCommand({
              SecretId: "database/password",
              VersionId: rotated.VersionId,
            }),
          )
        ).VersionStages,
      ).toEqual(["AWSCURRENT"])
      const described = await secrets.send(
        new DescribeSecretCommand({ SecretId: "database/password" }),
      )
      expect(Object.values(described.VersionIdsToStages ?? {})).toContainEqual(["AWSCURRENT"])
    } finally {
      secrets.destroy()
      await server.close()
    }
  })

  test("binary secrets and SSM SecureString values preserve SDK types", async () => {
    const server = await createServer()
    const { secrets, ssm } = clients(server.url)
    try {
      const bytes = Uint8Array.from([0, 1, 255, 42])
      await secrets.send(new CreateSecretCommand({ Name: "binary", SecretBinary: bytes }))
      expect(
        (await secrets.send(new GetSecretValueCommand({ SecretId: "binary" }))).SecretBinary,
      ).toEqual(bytes)
      await ssm.send(
        new PutParameterCommand({ Name: "/app/token", Value: "plain-value", Type: "SecureString" }),
      )
      const encrypted = await ssm.send(
        new GetParameterCommand({ Name: "/app/token", WithDecryption: false }),
      )
      expect(encrypted.Parameter?.Value).not.toBe("plain-value")
      const clear = await ssm.send(
        new GetParameterCommand({ Name: "/app/token", WithDecryption: true }),
      )
      expect(clear.Parameter).toMatchObject({
        Name: "/app/token",
        Type: "SecureString",
        Value: "plain-value",
        Version: 1,
        DataType: "text",
      })
      await ssm.send(
        new PutParameterCommand({
          Name: "/app/token",
          Value: "next",
          Type: "SecureString",
          Overwrite: true,
        }),
      )
      expect(
        (
          await ssm.send(
            new GetParametersCommand({ Names: ["/app/token", "/missing"], WithDecryption: true }),
          )
        ).InvalidParameters,
      ).toEqual(["/missing"])
    } finally {
      secrets.destroy()
      ssm.destroy()
      await server.close()
    }
  })
})
