import { createAdmin } from "@crvouga/mockingbird-service-sqlite/admin"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { served } from "./admin.js"
import { control, ORIGIN, shop } from "./store.js"

/**
 * `GET /__admin/ui` exactly as an emulator serves it: the document
 * `packages/service/core/src/admin-ui.ts` renders, with the prebuilt client
 * (`@crvouga/mockingbird-admin-ui/document`, built from `packages/admin-ui`) inlined. The other
 * admin stories mount the client from source; these show what ships.
 */
export default {
  title: "Admin/Admin UI/Served page",
  parameters: {
    layout: "fullscreen",
    sources: [
      "packages/service/core/src/admin-ui.ts",
      "packages/service/core/src/admin-client.ts",
      "packages/admin-ui/src/document.ts",
      "packages/admin-ui/src/index.ts",
      "packages/admin-ui/src/browser.tsx",
    ],
  },
} satisfies Meta

/** Stripe's admin, on the store the other stories use. */
export const Stripe: StoryObj = served(async () => {
  const { s } = await shop()
  return { emulator: s.emulator, url: `${ORIGIN}/__admin/ui` }
}, "PostSubscriptions")

/** The served page opened on a screen by its `#hash`. */
export const StripeJournal: StoryObj = served(async () => {
  const { s } = await shop()
  return { emulator: s.emulator, url: `${ORIGIN}/__admin/ui#journal` }
}, "Request attempts")

/** A database engine's admin (`createEngineAdmin`), with its SQL view. */
export const SqliteEngine: StoryObj = served(async () => {
  const emulator = createAdmin()
  const admin = control(emulator, "https://sqlite.mock")
  await admin("POST", "/sql/query", {
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
  })
  await admin("POST", "/sql/query", {
    sql: "INSERT INTO notes (body) VALUES ('Remember the milk')",
  })
  return { emulator, url: "https://sqlite.mock/__admin/ui#sql" }
}, "Remember the milk")
