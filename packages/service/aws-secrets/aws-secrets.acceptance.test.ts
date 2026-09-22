import { describe, expect, test } from "bun:test"
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { createServer } from "./src/server.js"

describe("AWS secrets controls and confidentiality", () => {
  test("denials, decryption failures, stale reads and throttling use SDK exceptions", async () => {
    const server = await createServer({
      secrets: [
        { name: "rotating", value: "old" },
        { name: "denied", value: "hidden" },
      ],
      parameters: [{ name: "/denied", value: "hidden", type: "SecureString" }],
      deniedNames: ["denied", "/denied"],
    })
    const common = {
      endpoint: server.url,
      region: "us-east-1",
      maxAttempts: 1,
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    }
    const secrets = new SecretsManagerClient(common)
    const ssm = new SSMClient(common)
    try {
      await expect(
        secrets.send(new GetSecretValueCommand({ SecretId: "denied" })),
      ).rejects.toMatchObject({ name: "AccessDeniedException" })
      await expect(
        ssm.send(new GetParameterCommand({ Name: "/denied", WithDecryption: true })),
      ).rejects.toMatchObject({ name: "AccessDeniedException" })
      const api = server.runtime.instance("default")
      const old = api.state.versions.list({
        where: (version) => version.secretName === "rotating",
      })[0]?.value
      api.rotate("rotating", "new")
      await fetch(`${server.url}/__admin/controls/rotating`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staleVersionId: old?.id }),
      })
      expect(
        (await secrets.send(new GetSecretValueCommand({ SecretId: "rotating" }))).SecretString,
      ).toBe("old")
      await fetch(`${server.url}/__admin/controls/rotating`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decryptionFailure: true }),
      })
      await expect(
        secrets.send(new GetSecretValueCommand({ SecretId: "rotating" })),
      ).rejects.toMatchObject({ name: "DecryptionFailure" })
      await fetch(`${server.url}/__admin/controls/rotating`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      await fetch(`${server.url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset: "throttled", count: 1 }),
      })
      await expect(
        secrets.send(new GetSecretValueCommand({ SecretId: "rotating" })),
      ).rejects.toMatchObject({ name: "ThrottlingException" })
    } finally {
      secrets.destroy()
      ssm.destroy()
      await server.close()
    }
  })

  test("admin state, request journal and snapshots never contain plaintext", async () => {
    const marker = "NEVER-LOG-THIS-PLAINTEXT"
    const server = await createServer({
      secrets: [{ name: "private", value: marker }],
      parameters: [{ name: "/private", value: marker, type: "SecureString" }],
    })
    const client = new SecretsManagerClient({
      endpoint: server.url,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    })
    try {
      expect(
        (await client.send(new GetSecretValueCommand({ SecretId: "private" }))).SecretString,
      ).toBe(marker)
      const admin = await Promise.all(
        ["secrets", "parameters", "requests"].map(async (path) =>
          (await fetch(`${server.url}/__admin/${path}`)).text(),
        ),
      )
      expect(admin.join("\n")).not.toContain(marker)
      const state = server.runtime.instance("default").state
      expect(
        JSON.stringify({
          secrets: state.secrets.list(),
          versions: state.versions.list(),
          parameters: state.parameters.list(),
          controls: state.controls.list(),
        }),
      ).not.toContain(marker)
      const snapshot = await (
        await fetch(`${server.url}/__admin/snapshots`, { method: "POST" })
      ).text()
      expect(snapshot).not.toContain(marker)
    } finally {
      client.destroy()
      await server.close()
    }
  })
})
