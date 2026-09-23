/**
 * The Node entries: `createServer()` over `node:http`, and the `mockingbird-medplum serve`
 * CLI from the built `dist/cli.js`, driven over real sockets.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { MedplumClient } from "@medplum/core"
import type { Patient } from "@medplum/fhirtypes"
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from "./src/index.js"
import { createServer, type MedplumServer } from "./src/server.js"

describe("createServer", () => {
  let server: MedplumServer
  beforeAll(async () => {
    server = await createServer()
  })
  afterAll(async () => {
    await server.close()
  })

  test("serves the Medplum API at its listening address, as its own base URL", async () => {
    const health = await fetch(`${server.url}/healthcheck`)
    expect((await health.json()).ok).toBe(true)
    const medplum = new MedplumClient({ baseUrl: `${server.url}/` })
    await medplum.startClientLogin(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET)
    const patient = await medplum.createResource<Patient>({
      resourceType: "Patient",
      name: [{ family: "Served" }],
    })
    const response = await fetch(`${server.url}/fhir/R4/Patient/${patient.id}`, {
      headers: { authorization: `Bearer ${medplum.getAccessToken()}` },
    })
    expect(response.status).toBe(200)
    expect((await medplum.search("Patient", "name=served")).entry?.[0]?.fullUrl).toBe(
      `${server.url}/fhir/R4/Patient/${patient.id}`,
    )
  })

  test("the control plane is served alongside", async () => {
    const health = await fetch(`${server.url}/health`)
    expect(health.status).toBe(200)
    const reset = await fetch(`${server.url}/__admin/reset`, { method: "POST" })
    expect(reset.status).toBe(200)
  })
})

const cli = join(import.meta.dir, "dist", "cli.js")

describe.skipIf(!existsSync(cli))("mockingbird-medplum serve", () => {
  let child: ChildProcess
  let output = ""
  const port = 18000 + Math.floor(Math.random() * 1000)

  beforeAll(async () => {
    child = spawn(
      process.execPath,
      [
        cli,
        "serve",
        "--port",
        String(port),
        "--client-id",
        "0b9e4a5c-0000-4000-8000-00000000c1d1",
        "--client-secret",
        "cli-secret",
        "--log",
        "off",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    child.stdout?.on("data", (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      output += String(chunk)
    })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return
      } catch {
        // not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`cli did not start:\n${output}`)
  }, 40_000)

  afterAll(() => {
    child?.kill("SIGTERM")
  })

  test("announces the credentials it seeded", () => {
    expect(output).toContain(`medplum mock listening on http://127.0.0.1:${port}`)
    expect(output).toContain(
      "client credentials: 0b9e4a5c-0000-4000-8000-00000000c1d1 / cli-secret",
    )
  })

  test("accepts the configured client and answers FHIR", async () => {
    const token = await fetch(`http://127.0.0.1:${port}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id=0b9e4a5c-0000-4000-8000-00000000c1d1&client_secret=cli-secret",
    })
    const { access_token } = (await token.json()) as { access_token: string }
    const created = await fetch(`http://127.0.0.1:${port}/fhir/R4/Patient`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/fhir+json" },
      body: JSON.stringify({ resourceType: "Patient" }),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get("location")).toStartWith(`http://127.0.0.1:${port}/fhir/R4/Patient/`)
  })
})
