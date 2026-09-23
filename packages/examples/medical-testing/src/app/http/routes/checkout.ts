import { type Context, Hono } from "hono"
import { createCheckout, NoTestsSelectedError } from "../../checkout/createCheckout.js"
import type { HostedFlowStep } from "../../ports/hostedFlow.js"
import type { HostedCheckoutResult } from "../../ports/paymentsClient.js"
import type { AppEnv } from "../appEnv.js"

export const checkoutRoutes = new Hono<AppEnv>()

checkoutRoutes.use("*", async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Sign in required" }, 401)
  return next()
})

checkoutRoutes.post("/", async (c) => {
  const user = c.get("user")
  if (!user) return c.json({ error: "Sign in required" }, 401)

  const body = await c.req.json<{ testIds: string[] }>()
  try {
    const { orderId, checkoutSessionId, hostedPageUrl } = await createCheckout(
      c.get("db"),
      c.get("payments"),
      { userId: user.id, name: user.name, email: user.email },
      body.testIds ?? [],
    )
    return c.json({ orderId, checkoutSessionId, hostedPageUrl })
  } catch (err) {
    if (err instanceof NoTestsSelectedError) return c.json({ error: err.message }, 400)
    throw err
  }
})

/** Opens the checkout session's hosted payment page — see HostedFlowModal.ts on the client. */
checkoutRoutes.post("/hosted/start", async (c) => {
  const body = await c.req.json<{ checkoutSessionId: string }>()
  const result = await c.get("payments").openHostedCheckout(body.checkoutSessionId)
  return respondToStep(c, result)
})

checkoutRoutes.post("/hosted/step", async (c) => {
  const body = await c.req.json<{ flowId: string; action: string; method: string; body: string }>()
  const result = await c
    .get("payments")
    .continueHostedCheckout(body.flowId, body.action, body.method, body.body)
  return respondToStep(c, result)
})

const respondToStep = (c: Context<AppEnv>, result: HostedFlowStep<HostedCheckoutResult>) => {
  if (result.kind === "error") return c.json({ error: result.message }, 400)
  if (result.kind === "html") return c.json({ flowId: result.flowId, html: result.html })
  return c.json({ done: true })
}
