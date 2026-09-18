import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHmac, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { parseSealedCorpus } from "./src/index.js"

const packageDir = dirname(fileURLToPath(import.meta.url))
const corpusPath = join(packageDir, "corpus/sandbox-sealed.json")
const corpus = parseSealedCorpus(JSON.parse(readFileSync(corpusPath, "utf8")))
const auth = { "x-vital-api-key": "sk_us_mockingbird" }

const AREA_ZIP = "85004"
const areaKey = `GET /v3/order/area/info?radius=100&zip_code=${AREA_ZIP}`
const expectedAreaBody = corpus.observations[areaKey]?.body as
  | { central_labs?: Record<string, unknown> }
  | undefined
const labTestId = corpus.catalog.labTests[0]?.id
if (labTestId === undefined) throw new Error("corpus has no lab tests")

const children: Array<{ kill: () => void }> = []

const spawnServer = async (extraEnv: Record<string, string>) => {
  const child = Bun.spawn(["bun", "scripts/server.ts"], {
    cwd: packageDir,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  const decoder = new TextDecoder()
  const reader = child.stdout.getReader()
  let buffer = ""
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not report a port: ${buffer}`)),
      20_000,
    )
    ;(async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const match = buffer.match(/listening on http:\/\/[^:]+:(\d+)/)
        if (match?.[1]) {
          clearTimeout(timer)
          resolve(Number(match[1]))
          return
        }
      }
      clearTimeout(timer)
      reject(new Error(`server exited before listening: ${buffer}`))
    })().catch(reject)
  })
  return { child, port }
}

let base = ""
beforeAll(async () => {
  const { port } = await spawnServer({
    PORT: "0",
    MOCKINGBIRD_JUNCTION_CORPUS: corpusPath,
  })
  base = `http://127.0.0.1:${port}`
})

afterAll(() => {
  for (const child of children) child.kill()
})

describe("junction mock server contract", () => {
  test("/health is reachable without auth", async () => {
    const response = await fetch(`${base}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })

  test("area info is gated by the api key and serves the corpus", async () => {
    const unauthorized = await fetch(`${base}/v3/order/area/info?zip_code=${AREA_ZIP}&radius=100`)
    expect(unauthorized.status).toBe(401)
    const response = await fetch(`${base}/v3/order/area/info?zip_code=${AREA_ZIP}&radius=100`, {
      headers: auth,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { central_labs?: unknown }
    expect(Object.keys((body.central_labs ?? {}) as Record<string, unknown>).sort()).toEqual(
      Object.keys(expectedAreaBody?.central_labs ?? {}).sort(),
    )
  })

  test("POST /__admin/reset returns ok", async () => {
    const response = await fetch(`${base}/__admin/reset`, { method: "POST" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })

  test("missing corpus path exits non-zero with a clear message", async () => {
    const missing = join(packageDir, "corpus/does-not-exist.json")
    const child = Bun.spawn(["bun", "scripts/server.ts"], {
      cwd: packageDir,
      env: { ...process.env, PORT: "0", MOCKINGBIRD_JUNCTION_CORPUS: missing },
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await child.exited
    const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`
    expect(exitCode).not.toBe(0)
    expect(output).toContain("junction mock corpus not found:")
  })

  test("delivers a signed labtest.order.created webhook", async () => {
    const { promise: delivered, resolve: resolveDelivery } = Promise.withResolvers<{
      headers: IncomingMessage["headers"]
      body: string
    }>()
    const receiver = createServer((request: IncomingMessage, response: ServerResponse) => {
      let data = ""
      request.on("data", (chunk) => {
        data += String(chunk)
      })
      request.on("end", () => {
        resolveDelivery({ headers: request.headers, body: data })
        response.writeHead(200)
        response.end("ok")
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()))
    const address = receiver.address()
    const receiverPort = typeof address === "object" && address !== null ? address.port : 0
    const keyB64 = randomBytes(32).toString("base64")
    const secret = `whsec_${keyB64}`

    const { port } = await spawnServer({
      PORT: "0",
      MOCKINGBIRD_JUNCTION_CORPUS: corpusPath,
      MOCKINGBIRD_JUNCTION_WEBHOOK_URL: `http://127.0.0.1:${receiverPort}`,
      MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET: secret,
    })
    const server = `http://127.0.0.1:${port}`

    const userResponse = await fetch(`${server}/v2/user`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ client_user_id: "webhook-user-1" }),
    })
    const user = (await userResponse.json()) as { user_id: string }
    const orderResponse = await fetch(`${server}/v3/order`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: user.user_id,
        patient_details: {
          first_name: "Ada",
          last_name: "Lovelace",
          dob: "1990-01-01",
          gender: "female",
          phone_number: "+14155551234",
          email: "ada@example.com",
        },
        patient_address: {
          first_line: "1 N Central Ave",
          city: "Phoenix",
          state: "AZ",
          zip: "85004",
          country: "US",
        },
        order_set: { lab_test_ids: [labTestId] },
      }),
    })
    expect(orderResponse.status).toBe(200)

    const delivery = await delivered
    receiver.close()
    const payload = JSON.parse(delivery.body) as { event_type?: string }
    expect(payload.event_type).toBe("labtest.order.created")
    const timestamp = delivery.headers["svix-timestamp"]
    const signature = delivery.headers["svix-signature"]
    expect(typeof timestamp).toBe("string")
    expect(typeof signature).toBe("string")
    const expected = createHmac("sha256", Buffer.from(keyB64, "base64"))
      .update(`${String(timestamp)}.${delivery.body}`)
      .digest("base64")
    expect(signature).toBe(`v1,${expected}`)
  })
})
