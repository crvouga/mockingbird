import { createHmac, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@crvouga/mockingbird-adapter-node"
import { JunctionAPI, type JunctionWebhookEvent, parseSealedCorpus } from "../src/index.js"

const scriptDir = dirname(fileURLToPath(import.meta.url))

const port = Number.parseInt(process.env.PORT ?? "8787", 10)
const hostname = process.env.HOST ?? "127.0.0.1"
const webhookUrl = process.env.MOCKINGBIRD_JUNCTION_WEBHOOK_URL?.replace(/\/$/, "")
const webhookSecret = process.env.MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET
const webhookScope = process.env.MOCKINGBIRD_JUNCTION_WEBHOOK_SCOPE ?? "junction-local"
const defaultCorpusPath = join(scriptDir, "../corpus/sandbox-sealed.json")

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

const corpusEnv = process.env.MOCKINGBIRD_JUNCTION_CORPUS
const corpusPath =
  corpusEnv ??
  (await readFile(defaultCorpusPath, "utf8").then(
    () => defaultCorpusPath,
    () => undefined,
  ))
if (corpusPath !== undefined) {
  const raw = await readFile(corpusPath, "utf8").catch(() => undefined)
  if (raw === undefined) {
    console.error(`junction mock corpus not found: ${corpusPath}`)
    process.exit(1)
  }
  const corpus = parseSealedCorpus(JSON.parse(raw))
  api.installCorpus(corpus)
  console.log(
    `junction mock corpus: ${String(Object.keys(corpus.observations).length)} observations, ${String(corpus.catalog.labTests.length)} lab tests`,
  )
}

const server = await serve(
  {
    fetch: async (request) => {
      const { pathname } = new URL(request.url)
      if (pathname === "/health") return Response.json({ status: "ok" })
      if (pathname === "/__admin/reset") {
        await api.reset()
        return Response.json({ status: "ok" })
      }
      return api.fetch(request)
    },
  },
  { port, host: hostname },
)

const address = server.address()
const boundPort = typeof address === "object" && address !== null ? address.port : port
console.log(`junction mock listening on http://${hostname}:${boundPort}`)
console.log("junction mock auth: x-vital-api-key (use any test value, e.g. sk_us_mockingbird)")
if (webhookUrl && !webhookSecret)
  console.warn("junction webhook delivery disabled: missing MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET")
