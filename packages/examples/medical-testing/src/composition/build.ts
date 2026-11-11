import {
  createNotificationHarness,
  type NotificationHarness,
} from "@crvouga/mockingbird-notifications"
import type { Hono } from "hono"
import { composeMockAdmins, type MockAdmin } from "../adapters/admin.js"
import { createPostgresMockDb } from "../adapters/db/postgresMockDb.js"
import { createOAuthMockIdentity } from "../adapters/identity/oauthMockIdentity.js"
import { createJunctionMockLabTesting } from "../adapters/labTesting/junctionMockLabTesting.js"
import { createMockNotifier } from "../adapters/notifications/mockNotifier.js"
import { createStripeMockPayments } from "../adapters/payments/stripeMockPayments.js"
import { seedCatalog } from "../app/catalog/seed.js"
import { APP_ORIGIN } from "../app/checkout/createCheckout.js"
import { migrate } from "../app/db/schema.js"
import { type ClientAssets, createApp } from "../app/http/app.js"
import type { AppEnv } from "../app/http/appEnv.js"
import type { Db } from "../app/ports/db.js"

import { seedWorkspace } from "./seedWorkspace.js"

export type { MockAdmin }

/** The running app plus the live admin fetch for every mock it is talking to. */
export type Demo = {
  app: Hono<AppEnv>
  db: Db
  admins: readonly MockAdmin[]
  admin: { fetch(request: Request): Promise<Response> }
  /**
   * Every email, SMS and push the app sent, read from the Resend, Twilio and
   * FCM emulators: a Fetch handler for the harness UI and JSON API, plus
   * `list`/`waitFor` for tests.
   */
  notifications: NotificationHarness
}

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
export const buildDemo = async (assets: ClientAssets): Promise<Demo> => {
  const appRef: { current?: Hono<AppEnv> } = {}
  const dispatch = async (request: Request): Promise<Response> => {
    if (!appRef.current) throw new Error("App not ready yet")
    return appRef.current.fetch(request)
  }

  const database = createPostgresMockDb()
  const db = database.client
  const identity = createOAuthMockIdentity()
  const labTesting = createJunctionMockLabTesting({
    dispatch,
    webhookUrl: `${APP_ORIGIN}/api/webhooks/lab-testing`,
  })
  const notifier = createMockNotifier()
  const payments = createStripeMockPayments({
    dispatch,
    webhookUrl: `${APP_ORIGIN}/api/webhooks/payments`,
  })

  await migrate(db)
  await seedCatalog(db, labTesting.client)
  await seedWorkspace(db)

  const app = createApp(
    {
      db,
      payments: payments.client,
      labTesting: labTesting.client,
      identity: identity.client,
      notifier: notifier.client,
    },
    assets,
  )
  appRef.current = app
  const admins = [
    ...identity.admins,
    payments.admin,
    labTesting.admin,
    ...notifier.admins,
    database.admin,
  ]
  const notifications = createNotificationHarness({
    services: notifier.runtimes,
    pollIntervalMs: 500,
    title: "Cove notifications",
  })
  return { app, db, admins, admin: composeMockAdmins(admins), notifications }
}

/** The Hono app alone, for tests that do not read the admins or the notification harness. */
export const buildApp = async (assets: ClientAssets): Promise<Hono<AppEnv>> => {
  const demo = await buildDemo(assets)
  demo.notifications.close()
  return demo.app
}
