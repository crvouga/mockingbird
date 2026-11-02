import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { Collection } from "./collection.js"

/**
 * Vendor idempotency keys: the same key with the same parameters replays the stored
 * response byte for byte; the same key with different parameters gets the vendor's
 * mismatch error; a key whose first request is still running gets the vendor's conflict.
 *
 * Stored responses live in SQLite (so reset and snapshots cover them); in-flight keys live
 * in memory, since "in flight" only means something inside one process.
 */
type StoredResponse = {
  fingerprint: string
  status: number
  headers: [string, string][]
  body: string
  /** When the key was first used (the store's clock, ms). Absent on records saved before expiry existed. */
  savedAt?: number
}

export type IdempotencyStoreOptions = {
  /** The clock key ages are measured on; pass the runtime's so a test can advance it. */
  now?: () => number
  /**
   * How long a key is kept, in ms. A reuse at or after this age runs as a new request, as
   * Stripe does once it prunes a key ("at least 24 hours old"). Default: keys never expire.
   */
  ttlMs?: number
}

export type IdempotencyErrors = {
  /** Same key, different parameters. */
  mismatch: () => Response
  /** Same key while the first request is still being handled. */
  conflict: () => Response
}

const inFlight = new Map<string, Promise<void>>()

export class IdempotencyStore {
  private readonly responses: Collection<StoredResponse>

  constructor(
    sqlite: SqliteClient,
    private readonly namespace: string,
    name = "idempotency",
    private readonly options: IdempotencyStoreOptions = {},
  ) {
    this.responses = new Collection<StoredResponse>(sqlite, namespace, name)
  }

  /**
   * Run `handler` once per `key`. `fingerprint` identifies the request's parameters (e.g.
   * the method, path and canonical body). Only `replayable` responses are stored (default:
   * every status below 500), so a transient failure can be retried. `replayable` also sees the
   * response, for vendors that decide from more than the status.
   * Stripe also saves endpoint-produced 500 responses.
   */
  async run(
    key: string,
    fingerprint: string,
    errors: IdempotencyErrors,
    handler: () => Promise<Response> | Response,
    replayable: (status: number, response: Response) => boolean = (status) => status < 500,
  ): Promise<Response> {
    const slot = `${this.namespace}\u0000${key}`
    const now = (this.options.now ?? Date.now)()
    const stored = this.responses.get(key)
    if (stored && !this.expired(stored, now)) {
      if (stored.fingerprint !== fingerprint) return errors.mismatch()
      return new Response(stored.body, {
        status: stored.status,
        headers: [...stored.headers, ["idempotent-replayed", "true"]],
      })
    }
    if (inFlight.has(slot)) return errors.conflict()
    let release = () => {}
    inFlight.set(
      slot,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    try {
      const response = await handler()
      if (!replayable(response.status, response)) return response
      const body = await response.clone().text()
      this.responses.insert(key, {
        fingerprint,
        status: response.status,
        headers: [...response.headers],
        body,
        savedAt: now,
      })
      return response
    } finally {
      inFlight.delete(slot)
      release()
    }
  }

  private expired(stored: StoredResponse, now: number): boolean {
    const { ttlMs } = this.options
    return ttlMs !== undefined && stored.savedAt !== undefined && now - stored.savedAt >= ttlMs
  }
}

/** A stable fingerprint of a request's method, path and parsed body. */
export const requestFingerprint = (method: string, path: string, body: unknown): string =>
  `${method.toUpperCase()} ${path} ${stableStringify(body)}`

export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}
