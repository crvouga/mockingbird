import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EndpointManifest } from "@crvouga/mockingbird-service-stripe/fleet"
import { Redis } from "ioredis"
import { Client } from "pg"

const host = process.argv.includes("--host"),
  image = process.argv.find((a) => a.startsWith("--image="))?.slice(8) ?? "mockingbird-fleet:smoke"
const directory = await mkdtemp(join(tmpdir(), "fleet-container-smoke-")),
  name = `mockingbird-smoke-${randomUUID()}`,
  volume = `${name}-state`,
  adminKey = "synthetic-reference-admin"
const command = async (args: string[]) => {
  const result = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }),
    output = await new Response(result.stdout).text(),
    errors = await new Response(result.stderr).text()
  if ((await result.exited) !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${errors}`)
  return output.trim()
}
let child: ReturnType<typeof spawn> | undefined
const start = async () => {
  if (host) {
    const config = join(directory, "config.json")
    await writeFile(
      config,
      JSON.stringify({
        services: {
          stripe: { port: 0 },
          postgres: { protocol: "postgres", port: 0 },
          redis: { protocol: "redis", port: 0 },
        },
      }),
    )
    child = spawn("bun", [join(import.meta.dir, "dist/fleet.js")], {
      env: {
        ...process.env,
        FLEET_STATE_DIR: directory,
        FLEET_CONFIG: config,
        MOCKINGBIRD_ADMIN_KEY: adminKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.on("error", (error) => {
      console.error(error.message)
    })
  } else {
    await command([
      "docker",
      "run",
      "-d",
      "--name",
      name,
      "--mount",
      `type=volume,source=${volume},target=/state`,
      "--env",
      `MOCKINGBIRD_ADMIN_KEY=${adminKey}`,
      "-p",
      "127.0.0.1::9000",
      "-p",
      "127.0.0.1::9001",
      "-p",
      "127.0.0.1::5432",
      "-p",
      "127.0.0.1::6379",
      image,
    ])
    assert.notEqual(await command(["docker", "exec", name, "id", "-u"]), "0")
  }
  const deadline = Date.now() + 30000
  let manifest: EndpointManifest | undefined
  while (Date.now() < deadline) {
    try {
      const text = host
        ? await readFile(join(directory, "ready.json"), "utf8")
        : await command(["docker", "exec", name, "cat", "/state/ready.json"])
      manifest = JSON.parse(text) as EndpointManifest
      if (manifest.state === "ready") break
    } catch {}
    if (host && child?.exitCode !== null) throw new Error("reference exited before readiness")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(manifest, "reference readiness deadline exceeded")
  assert.deepEqual(Object.keys(manifest.services).sort(), ["postgres", "redis", "stripe"])
  if (!host) {
    const ports = { stripe: 9001, postgres: 5432, redis: 6379 }
    for (const [service, port] of Object.entries(ports)) {
      const endpoint = manifest.services[service]
      assert.ok(endpoint)
      const url = new URL(endpoint.url),
        published = await command(["docker", "port", name, String(port)])
      url.hostname = "127.0.0.1"
      url.port = published.slice(published.lastIndexOf(":") + 1)
      endpoint.url = url.href
    }
    const control = await command(["docker", "port", name, "9000"])
    manifest.healthUrl = `http://${control}/__admin/health`
  }
  assert.equal((await fetch(manifest.healthUrl)).status, 200)
  return manifest
}
const stop = async () => {
  if (host) {
    const current = child
    assert.ok(current)
    const exited = new Promise<number | null>((resolve) => current.once("exit", resolve))
    current.kill("SIGTERM")
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("controlled shutdown timed out")), 30000)
        timer.unref()
      }),
    ])
    assert.equal(code, 0)
    child = undefined
  } else {
    await command(["docker", "stop", "--time", "35", name])
    assert.match(
      await command(["docker", "logs", name]),
      /"event":"shutdown-backup","status":"verified"/,
    )
    assert.equal(await command(["docker", "inspect", "--format", "{{.State.ExitCode}}", name]), "0")
    await command(["docker", "rm", name])
  }
}
const exercise = async (manifest: EndpointManifest, seed: boolean) => {
  const pg = new Client({ connectionString: manifest.services.postgres?.url }),
    redis = new Redis(manifest.services.redis?.url ?? "", { retryStrategy: () => null })
  try {
    await pg.connect()
    if (seed) {
      await pg.query("CREATE TABLE synthetic_reference (value text)")
      await pg.query("INSERT INTO synthetic_reference VALUES ('persistent')")
      await redis.set("synthetic-reference", "persistent")
      assert.equal(
        (
          await fetch(`${manifest.services.stripe?.url}/v1/customers`, {
            method: "POST",
            headers: {
              authorization: "Bearer sk_test_mockingbird",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: "email=synthetic%40example.test",
          })
        ).status,
        200,
      )
    }
    assert.equal(
      (await pg.query("SELECT value FROM synthetic_reference")).rows[0]?.value,
      "persistent",
    )
    assert.equal(await redis.get("synthetic-reference"), "persistent")
    const customers = (await (
      await fetch(`${manifest.services.stripe?.url}/v1/customers`, {
        headers: { authorization: "Bearer sk_test_mockingbird" },
      })
    ).json()) as { data: { email: string }[] }
    assert.equal(customers.data[0]?.email, "synthetic@example.test")
  } finally {
    await pg.end()
    await redis.quit()
  }
}
try {
  const first = await start()
  await exercise(first, true)
  await stop()
  const second = await start()
  assert.notEqual(second.id, first.id)
  await exercise(second, false)
  await stop()
  console.log(
    JSON.stringify({
      passed: true,
      mode: host ? "host-fresh-process" : "non-root-container",
      protocols: ["http", "postgres", "redis"],
      restored: true,
    }),
  )
} finally {
  child?.kill("SIGKILL")
  if (!host) {
    await command(["docker", "rm", "-f", name]).catch(() => {})
    await command(["docker", "volume", "rm", volume]).catch(() => {})
  }
  await rm(directory, { recursive: true, force: true })
}
