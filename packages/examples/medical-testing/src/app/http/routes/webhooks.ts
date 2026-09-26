import { Hono } from "hono"
import { handleLabTestingWebhook } from "../../checkout/handleLabTestingWebhook.js"
import { handlePaymentsWebhook } from "../../checkout/handlePaymentsWebhook.js"
import type { AppEnv } from "../appEnv.js"

export const webhookRoutes = new Hono<AppEnv>()

/**
 * A real payments-provider webhook: signature-verified, arrives
 * independently of (and possibly before/after) the shopper's own redirect
 * back from the hosted checkout page.
 */
webhookRoutes.post("/payments", async (c) => {
  const payload = await c.req.text()
  const signature = c.req.header("stripe-signature") ?? null
  try {
    await handlePaymentsWebhook(
      c.get("db"),
      c.get("payments"),
      c.get("labTesting"),
      payload,
      signature,
    )
    return c.json({ received: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Webhook rejected" }, 400)
  }
})

/** A lab-testing provider webhook reporting an order moved forward. */
webhookRoutes.post("/lab-testing", async (c) => {
  const payload = await c.req.text()
  await handleLabTestingWebhook(c.get("db"), c.get("labTesting"), payload)
  return c.json({ received: true })
})
