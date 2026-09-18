/**
 * Serve the Stripe mock over HTTP and deliver its webhook events to configured targets.
 *
 * Signing lives here rather than in `src/` so the package stays portable: Stripe signs
 * `"<t>.<body>"` with HMAC-SHA256 keyed by the `whsec_` secret **verbatim** (no prefix stripping,
 * no base64 decoding), and puts `t=<unix seconds>,v1=<hex digest>` in the `Stripe-Signature`
 * header. Verifiers accept it while the timestamp is within the SDK's default 300s tolerance.
 */
import { createHmac } from "node:crypto"
import { accountOfKey } from "../src/account.js"
import { StripeAPI, type StripeWebhookEvent } from "../src/index.js"

type Target = { apiKey: string; url: string; secret: string }

const HOST = Bun.env.HOST ?? "127.0.0.1"
const PORT = Number(Bun.env.PORT ?? 12111)
const DEFAULT_TIMEOUT_MS = 15_000

const parseTargets = (): Target[] => {
  const raw = Bun.env.MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS
  const targets: Target[] = []
  if (raw !== undefined && raw.trim() !== "") {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed))
      throw new Error(
        "MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS must be a JSON array of {apiKey,url,secret}",
      )
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue
      const candidate = entry as Record<string, unknown>
      const { apiKey, url, secret } = candidate
      if (typeof apiKey !== "string" || typeof url !== "string" || typeof secret !== "string")
        continue
      targets.push({ apiKey, url, secret })
    }
  }
  const fallbackUrl = Bun.env.MOCKINGBIRD_STRIPE_WEBHOOK_URL
  const fallbackSecret = Bun.env.MOCKINGBIRD_STRIPE_WEBHOOK_SECRET
  if (targets.length === 0 && fallbackUrl !== undefined && fallbackSecret !== undefined) {
    targets.push({ apiKey: "*", url: fallbackUrl, secret: fallbackSecret })
  }
  return targets
}

const targets = parseTargets()
const targetByAccount = new Map<string, Target>()
for (const target of targets) {
  if (target.apiKey !== "*") targetByAccount.set(accountOfKey(target.apiKey), target)
}
const wildcard = targets.find((target) => target.apiKey === "*")

const signatureFor = (secret: string, body: string, timestamp: number) =>
  `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`

const deliver = (event: StripeWebhookEvent) => {
  const target = targetByAccount.get(event.account) ?? wildcard
  if (target === undefined) {
    console.warn(`stripe webhook delivery skipped: no target for account ${event.account}`)
    return
  }
  const timestamp = Math.floor(Date.now() / 1000)
  void fetch(target.url, {
    body: event.body,
    headers: {
      "content-type": "application/json",
      "stripe-signature": signatureFor(target.secret, event.body, timestamp),
    },
    method: "POST",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  }).catch((error: unknown) => {
    console.error(
      `stripe webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

const api = new StripeAPI({ onWebhook: deliver })

const server = Bun.serve({
  fetch: (request) => {
    if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" })
    return api.fetch(request)
  },
  hostname: HOST,
  port: PORT,
})

console.log(`stripe mock listening on http://${server.hostname}:${server.port}`)
console.log(
  "stripe mock auth: Bearer sk_test_* (any test key; different keys are different accounts)",
)
if (targets.length === 0)
  console.warn(
    "stripe webhook delivery disabled: set MOCKINGBIRD_STRIPE_WEBHOOK_TARGETS or MOCKINGBIRD_STRIPE_WEBHOOK_URL + MOCKINGBIRD_STRIPE_WEBHOOK_SECRET",
  )
