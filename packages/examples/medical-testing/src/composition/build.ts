import type { Hono } from "hono"
import { createPostgresMockDb } from "../adapters/db/postgresMockDb.js"
import { createOAuthMockIdentity } from "../adapters/identity/oauthMockIdentity.js"
import { createJunctionMockLabTesting } from "../adapters/labTesting/junctionMockLabTesting.js"
import { createStripeMockPayments } from "../adapters/payments/stripeMockPayments.js"
import { seedCatalog } from "../app/catalog/seed.js"
import { APP_ORIGIN } from "../app/checkout/createCheckout.js"
import { migrate } from "../app/db/schema.js"
import { type ClientAssets, createApp } from "../app/http/app.js"
import type { AppEnv } from "../app/http/appEnv.js"

/**
 * Wires a fresh instance of the whole app together: builds every adapter
 * (each one backed by an in-process Mockingbird mock), builds the `Db` and
 * seeds the catalog through it, and constructs the Hono app from nothing
 * but ports. This is the ONLY place that imports from both `app/` and
 * `adapters/` — see `server.ts` and `browser.ts` for the two ways it gets
 * mounted/served.
 *
 * Payments and lab-testing webhooks need to call back into this same app
 * (a real HTTP-shaped round trip, in-process) — `appRef` breaks the
 * otherwise-circular "adapters need the app, the app needs the adapters"
 * dependency: the adapters close over a `dispatch` function that forwards
 * into whatever `appRef.current` is once construction finishes below.
 */
export const buildApp = async (assets: ClientAssets): Promise<Hono<AppEnv>> => {
  const appRef: { current?: Hono<AppEnv> } = {}
  const dispatch = async (request: Request): Promise<Response> => {
    if (!appRef.current) throw new Error("App not ready yet")
    return appRef.current.fetch(request)
  }

  const db = createPostgresMockDb()
  const identity = createOAuthMockIdentity()
  const labTesting = createJunctionMockLabTesting({
    dispatch,
    webhookUrl: `${APP_ORIGIN}/api/webhooks/lab-testing`,
  })
  const payments = createStripeMockPayments({
    dispatch,
    webhookUrl: `${APP_ORIGIN}/api/webhooks/payments`,
  })

  await migrate(db)
  await seedCatalog(db, labTesting)

  const app = createApp({ db, payments, labTesting, identity }, assets)
  appRef.current = app
  return app
}
