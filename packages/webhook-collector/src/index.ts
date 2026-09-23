import { Hono } from "hono"

export type WebhookRow = {
  id?: number
  service: string
  run_id: string | null
  received_at: string
  headers: Record<string, string>
  payload: unknown
}

export type WebhookStore = {
  insert(row: WebhookRow): Promise<void>
  list(filter: { service?: string; runId?: string }): Promise<readonly WebhookRow[]>
}

export type WebhookCollectorEnv = { Variables: { store: WebhookStore } }

const SERVICE_SLUG = /^[a-z][a-z0-9-]{0,63}$/
const MAX_BODY_BYTES = 1_048_576

export const createWebhookCollector = (store: WebhookStore, readToken?: string) => {
  const app = new Hono<WebhookCollectorEnv>()
  app.use("*", async (c, next) => {
    c.set("store", store)
    return next()
  })
  app.get("/health", (c) => c.json({ status: "ok" }))
  app.use("/events/*", async (c, next) => {
    if (!readToken) return c.json({ error: "collector_read_token_not_configured" }, 503)
    if (c.req.header("authorization") !== `Bearer ${readToken}`)
      return c.json({ error: "unauthorized" }, 401)
    return next()
  })
  app.use("/events", async (c, next) => {
    if (!readToken) return c.json({ error: "collector_read_token_not_configured" }, 503)
    if (c.req.header("authorization") !== `Bearer ${readToken}`)
      return c.json({ error: "unauthorized" }, 401)
    return next()
  })
  app.post("/:service", async (c) => {
    const service = c.req.param("service")
    if (!SERVICE_SLUG.test(service)) return c.json({ error: "invalid_service" }, 400)
    const declaredLength = Number(c.req.header("content-length"))
    if (declaredLength > MAX_BODY_BYTES) return c.json({ error: "payload_too_large" }, 413)
    const raw = await c.req.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
      return c.json({ error: "payload_too_large" }, 413)
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: "invalid_json" }, 400)
    }
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value
    })
    await c.var.store.insert({
      service,
      run_id: c.req.header("x-mockingbird-scope") ?? new URL(c.req.url).searchParams.get("run_id"),
      received_at: new Date().toISOString(),
      headers,
      payload,
    })
    return c.json({ received: true }, 202)
  })
  app.get("/events", async (c) => {
    const service = c.req.query("service")
    const runId = c.req.query("run_id")
    return c.json(
      await c.var.store.list({ ...(service ? { service } : {}), ...(runId ? { runId } : {}) }),
    )
  })
  app.get("/events/:runId", async (c) => {
    const service = c.req.query("service")
    const rows = await c.var.store.list({
      runId: c.req.param("runId"),
      ...(service ? { service } : {}),
    })
    return c.json(rows.map((row) => row.payload))
  })
  return app
}

export type { Hono }
