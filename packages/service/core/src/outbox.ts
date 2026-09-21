import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { Collection } from "./collection.js"
import type { AdminRoutes } from "./control.js"
import type { ServiceInstance, ServiceRuntime } from "./runtime.js"

/**
 * What a comms vendor "sent" (an SMS, an email, a Slack post), kept per namespace so a
 * suite can assert on it and read codes and links out of it. Stored in SQLite beside the
 * service's other records, so reset, snapshot and restore cover it.
 */
export type OutboxItem = {
  id: string
  /** Recipient(s): a phone number, email address, channel or webhook path. */
  to: string | string[]
  /** ISO-8601 on the mock clock. */
  createdAt: string
}

export type OutboxQuery = {
  /** Case-insensitive match on any recipient. */
  to?: string
  /** Only items at or after this instant (epoch ms). */
  since?: number
  /** Extra filter over the item. */
  where?: (item: Record<string, unknown>) => boolean
  limit?: number
}

export class OutboxStore<T extends OutboxItem = OutboxItem> {
  private readonly items: Collection<T>

  constructor(sqlite: SqliteClient, namespace: string, name = "outbox") {
    this.items = new Collection<T>(sqlite, namespace, name)
  }

  record(item: T): T {
    this.items.insert(item.id, item)
    return item
  }

  get(id: string): T | undefined {
    return this.items.get(id)
  }

  update(id: string, item: T): void {
    this.items.update(id, item)
  }

  /** Oldest first, so a suite reads messages in the order they were sent. */
  list(query: OutboxQuery = {}): T[] {
    const to = query.to?.toLowerCase()
    const matched = this.items
      .list({ order: "oldest" })
      .map((row) => row.value)
      .filter((item) => {
        if (to !== undefined) {
          const recipients = Array.isArray(item.to) ? item.to : [item.to]
          if (!recipients.some((r) => r.toLowerCase() === to)) return false
        }
        if (query.since !== undefined && Date.parse(item.createdAt) < query.since) return false
        if (query.where && !query.where(item as unknown as Record<string, unknown>)) return false
        return true
      })
    return query.limit !== undefined ? matched.slice(-Math.max(0, query.limit)) : matched
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Epoch ms from `since=` given as epoch ms or ISO-8601; `null` when malformed. */
export const parseSince = (value: string | null): number | undefined | null => {
  if (value === null) return undefined
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * `GET /__admin/outbox?to=&since=&limit=` (plus `GET /__admin/outbox/:id`) over the outbox
 * of the calling namespace. `filter` adds service-specific query parameters (e.g. Resend's
 * `tag=`, Slack's `channel=`).
 */
export const outboxAdminRoutes = <S extends ServiceInstance>(
  runtime: ServiceRuntime<S>,
  pick: (instance: S) => OutboxStore<OutboxItem>,
  filter?: (params: URLSearchParams) => ((item: Record<string, unknown>) => boolean) | undefined,
): AdminRoutes => ({
  "GET /outbox": ({ url, namespace }) => {
    const since = parseSince(url.searchParams.get("since"))
    if (since === null) {
      return json(400, {
        error: { type: "mockingbird_admin", message: "since: expected epoch ms or ISO-8601" },
      })
    }
    const limit = url.searchParams.get("limit")
    const where = filter?.(url.searchParams)
    const to = url.searchParams.get("to")
    return json(200, {
      messages: pick(runtime.instance(namespace)).list({
        ...(to !== null ? { to } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(where ? { where } : {}),
        ...(limit !== null && /^\d+$/.test(limit) ? { limit: Number(limit) } : {}),
      }),
    })
  },
  "GET /outbox/:id": ({ params, namespace }) => {
    const item = pick(runtime.instance(namespace)).get(params.id as string)
    return item
      ? json(200, item)
      : json(404, { error: { type: "mockingbird_admin", message: `no message ${params.id}` } })
  },
})

/** Every `href` in an HTML document, in order, entity-decoded, without duplicates. */
export const extractLinks = (html: string): string[] => {
  const links: string[] = []
  for (const match of html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? ""
    const decoded = raw
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
    if (decoded && !links.includes(decoded)) links.push(decoded)
  }
  return links
}

/** Numeric codes of `length` digits (default 4–8) in text, as Mailosaur's `codes[]` reports them. */
export const extractCodes = (text: string, length?: number): string[] => {
  const pattern = length === undefined ? /\b\d{4,8}\b/g : new RegExp(`\\b\\d{${length}}\\b`, "g")
  return [...new Set(text.match(pattern) ?? [])]
}
