import { createHmac, randomUUID } from "node:crypto"
import { JunctionAPI, type JunctionWebhookEvent } from "../src/index.js"

const port = Number.parseInt(Bun.env.PORT ?? "8787", 10)
const hostname = Bun.env.HOST ?? "127.0.0.1"
const webhookUrl = Bun.env.MOCKINGBIRD_JUNCTION_WEBHOOK_URL?.replace(/\/$/, "")
const webhookSecret = Bun.env.MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET
const webhookScope = Bun.env.MOCKINGBIRD_JUNCTION_WEBHOOK_SCOPE ?? "junction-local"

const signWebhook = (event: JunctionWebhookEvent) => {
  if (!webhookSecret) return undefined
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const payload = JSON.stringify(event)
  const secret = webhookSecret.startsWith("whsec_") ? webhookSecret.slice(6) : webhookSecret
  const key = Buffer.from(secret, "base64")
  const signature = createHmac("sha256", key).update(`${timestamp}.${payload}`).digest("base64")
  return {
    body: payload,
    headers: {
      "content-type": "application/json",
      "svix-id": randomUUID(),
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
      "x-mockingbird-scope": webhookScope,
    },
  }
}

const api = new JunctionAPI({
  onWebhook: (event) => {
    if (!webhookUrl) return
    const signed = signWebhook(event)
    if (!signed) return
    void fetch(webhookUrl, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    }).catch((error: unknown) => {
      console.error(
        `junction webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  },
})

const server = Bun.serve({
  hostname,
  port,
  fetch: (request) => {
    if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" })
    return api.fetch(request)
  },
})

console.log(`junction mock listening on http://${server.hostname}:${server.port}`)
console.log("junction mock auth: x-vital-api-key (use any test value, e.g. sk_us_mockingbird)")
if (webhookUrl && !webhookSecret)
  console.warn("junction webhook delivery disabled: missing MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET")
