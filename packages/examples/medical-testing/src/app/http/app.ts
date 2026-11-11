import { Hono } from "hono"
import { getCookie } from "hono/cookie"
import { HTTPException } from "hono/http-exception"
import { SESSION_COOKIE, SESSION_HEADER, userForToken } from "../auth/session.js"
import type { AppDeps, AppEnv } from "./appEnv.js"
import { accountRoutes } from "./routes/account.js"
import { adminRoutes } from "./routes/admin.js"
import { authRoutes } from "./routes/auth.js"
import { catalogRoutes } from "./routes/catalog.js"
import { checkoutRoutes } from "./routes/checkout.js"
import { emailAuthRoutes } from "./routes/emailAuth.js"
import { ordersRoutes } from "./routes/orders.js"
import { webhookRoutes } from "./routes/webhooks.js"

export type ClientAssets = { html: string; js: string }

/**
 * The whole app, built purely from its ports — nothing here knows what's
 * actually backing `deps.db`/`deps.payments`/`deps.labTesting`/`deps.identity`/`deps.notifier`/`deps.phoneVerifier`.
 * See src/composition/*.ts for what wires those up.
 */
export const createApp = (deps: AppDeps, assets: ClientAssets): Hono<AppEnv> => {
  const app = new Hono<AppEnv>()

  app.use("*", async (c, next) => {
    c.set("db", deps.db)
    c.set("payments", deps.payments)
    c.set("labTesting", deps.labTesting)
    c.set("identity", deps.identity)
    c.set("notifier", deps.notifier)
    c.set("phoneVerifier", deps.phoneVerifier)
    // Real browsers block JS from *reading* the Set-Cookie/Cookie headers on
    // any Response/Headers object — not just ones from a real network fetch,
    // any object in a browser JS realm — so a real `Cookie` request header
    // never makes it back to us in the fully in-process (browser-mounted)
    // run mode. `SESSION_HEADER` is a parallel, unrestricted carrier for
    // that exact case; see src/composition/browser.ts's in-process fetcher.
    // The standalone server keeps using real cookies (the browser's own
    // network stack handles those natively, no JS needs to read them).
    const token = getCookie(c, SESSION_COOKIE) ?? c.req.header(SESSION_HEADER)
    c.set("user", await userForToken(deps.db, token))
    await next()
  })

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request body." }, 400)
    return c.json({ error: "Something went wrong. Please try again." }, 500)
  })
  app.use("/api/*", async (c, next) => {
    c.header("cache-control", "no-store")
    await next()
  })
  app.route("/api/admin", adminRoutes)
  app.route("/api/account", accountRoutes)
  // Before the OAuth routes: `/api/auth/:provider/start` would otherwise claim `/email/start`.
  app.route("/api/auth/email", emailAuthRoutes)
  app.route("/api/auth", authRoutes)
  app.route("/api", catalogRoutes)
  app.route("/api/checkout", checkoutRoutes)
  app.route("/api/orders", ordersRoutes)
  app.route("/api/webhooks", webhookRoutes)

  app.get("/client.js", (c) =>
    c.text(assets.js, 200, { "content-type": "text/javascript; charset=utf-8" }),
  )
  app.get("*", (c) => c.html(assets.html))

  return app
}
