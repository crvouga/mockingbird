import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { WebhookRow, WebhookStore } from "@crvouga/mockingbird-webhook-collector"

type StoredRow = Omit<WebhookRow, "headers" | "payload"> & { headers: string; payload: string }

let cached: WebhookStore | undefined

/** One SQLite database per docs process; WEBHOOK_DB should point at a persistent volume. */
export const webhookStore = (): WebhookStore => {
  if (cached) return cached
  const path = resolve(process.env.WEBHOOK_DB ?? ".webhook-events/events.sqlite")
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.run("PRAGMA journal_mode = WAL")
  db.run(`CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    run_id TEXT,
    received_at TEXT NOT NULL,
    headers TEXT NOT NULL,
    payload TEXT NOT NULL
  )`)
  db.run("CREATE INDEX IF NOT EXISTS webhook_events_lookup ON webhook_events(service, run_id, id)")
  cached = {
    async insert(row) {
      db.query(
        "INSERT INTO webhook_events(service, run_id, received_at, headers, payload) VALUES (?, ?, ?, ?, ?)",
      ).run(
        row.service,
        row.run_id,
        row.received_at,
        JSON.stringify(row.headers),
        JSON.stringify(row.payload),
      )
    },
    async list(filter) {
      const rows = db
        .query(
          `SELECT id, service, run_id, received_at, headers, payload FROM webhook_events
           WHERE (? IS NULL OR service = ?) AND (? IS NULL OR run_id = ?) ORDER BY id`,
        )
        .all(
          filter.service ?? null,
          filter.service ?? null,
          filter.runId ?? null,
          filter.runId ?? null,
        )
      return (rows as StoredRow[]).map((row) => ({
        ...row,
        headers: JSON.parse(row.headers) as Record<string, string>,
        payload: JSON.parse(row.payload) as unknown,
      }))
    },
  }
  return cached
}
