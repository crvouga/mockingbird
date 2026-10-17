import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

for (const mode of ["inline", "file"] as const) {
  test(`serve --config loads validated ${mode} Cognito fixtures without publishing passwords (#455)`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cognito-cli-"))
    const readyFile = join(directory, "ready.json")
    const fixtureFile = join(directory, "users.json")
    const configFile = join(directory, "config.json")
    const fixtures = {
      users: [
        {
          username: "cli@example.test",
          password: "Synthetic1",
          confirmed: true,
          sub: "fixture-sub",
        },
      ],
    }
    await writeFile(fixtureFile, JSON.stringify(fixtures))
    await writeFile(
      configFile,
      JSON.stringify({
        log: "off",
        services: {
          cognito: {
            port: 0,
            ...(mode === "inline" ? { fixtures } : { options: { fixtures: fixtureFile } }),
          },
        },
      }),
    )
    const packageDir = join(directory, "node_modules/@crvouga/mockingbird-service-cognito")
    await mkdir(packageDir, { recursive: true })
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ type: "module", exports: { "./server": "./server.ts" } }),
    )
    await writeFile(
      join(packageDir, "server.ts"),
      `export { serveTarget } from ${JSON.stringify(join(import.meta.dir, "src/server.ts"))}\n`,
    )
    const child = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "src/cli.ts"),
        "serve",
        "--config",
        configFile,
        "--ready-file",
        readyFile,
        "--ready-json",
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    )
    try {
      let manifest: { services: { cognito: { url: string } } } | undefined
      const deadline = Date.now() + 7000
      while (!manifest && Date.now() < deadline) {
        try {
          manifest = JSON.parse(await readFile(readyFile, "utf8"))
        } catch {}
        if (child.exitCode !== null)
          throw new Error(`CLI exited: ${await new Response(child.stderr).text()}`)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (!manifest) throw new Error("Cognito CLI readiness timed out")
      expect(JSON.stringify(manifest)).not.toContain(fixtures.users[0]?.password)
      const response = await fetch(`${manifest.services.cognito.url}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
        },
        body: JSON.stringify({
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: "fixture-client",
          AuthParameters: { USERNAME: "cli@example.test", PASSWORD: "Synthetic1" },
        }),
      })
      expect(response.status).toBe(200)
      const token = (await response.json()).AuthenticationResult.IdToken as string
      expect(
        JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()).sub,
      ).toBe("fixture-sub")
      child.kill("SIGTERM")
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stdout).text()).not.toContain("Synthetic1")
      expect(await new Response(child.stderr).text()).not.toContain("Synthetic1")
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await rm(directory, { recursive: true, force: true })
    }
  }, 10000)
}
