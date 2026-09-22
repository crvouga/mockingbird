import type { RequestLog } from "./metrics.js"

/** One journal entry: a request log stamped with when (on the mock clock) it was handled. */
export type JournalEntry = RequestLog & { at: string }

export type JournalQuery = {
  /** Only this namespace. Omit for every namespace, oldest first across all of them. */
  namespace?: string
  operationId?: string
  status?: number
  /** Only entries at or after this instant (epoch ms). */
  since?: number
  /** At most this many, the most recent kept. */
  limit?: number
}

export type Journal = {
  readonly size: number
  record(entry: JournalEntry): void
  list(query?: JournalQuery): JournalEntry[]
  /** Forget one namespace's entries, or every namespace's. */
  clear(namespace?: string): void
}

/** Default number of entries each namespace keeps. */
export const DEFAULT_JOURNAL_SIZE = 1000

/**
 * The last `size` requests per namespace, in a ring buffer: what the mock actually saw,
 * so a test can prove a request arrived (or never did) without reading logs.
 */
export const createJournal = (size: number = DEFAULT_JOURNAL_SIZE): Journal => {
  const capacity = Math.max(0, Math.floor(size))
  const rings = new Map<string, { entries: JournalEntry[]; next: number }>()
  let sequence = 0
  const order = new WeakMap<JournalEntry, number>()
  const inOrder = (ring: { entries: JournalEntry[]; next: number }): JournalEntry[] =>
    ring.entries.length < capacity
      ? ring.entries
      : [...ring.entries.slice(ring.next), ...ring.entries.slice(0, ring.next)]
  return {
    size: capacity,
    record(entry) {
      if (capacity === 0) return
      order.set(entry, sequence++)
      let ring = rings.get(entry.namespace)
      if (!ring) {
        ring = { entries: [], next: 0 }
        rings.set(entry.namespace, ring)
      }
      if (ring.entries.length < capacity) ring.entries.push(entry)
      else {
        ring.entries[ring.next] = entry
        ring.next = (ring.next + 1) % capacity
      }
    },
    list(query = {}) {
      const source =
        query.namespace !== undefined
          ? inOrder(rings.get(query.namespace) ?? { entries: [], next: 0 })
          : [...rings.values()]
              .flatMap(inOrder)
              .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      const matched = source.filter(
        (entry) =>
          (query.operationId === undefined || entry.operationId === query.operationId) &&
          (query.status === undefined || entry.status === query.status) &&
          (query.since === undefined || Date.parse(entry.at) >= query.since),
      )
      return query.limit !== undefined ? matched.slice(-Math.max(0, query.limit)) : matched
    },
    clear(namespace) {
      if (namespace === undefined) rings.clear()
      else rings.delete(namespace)
    },
  }
}

/** What a service knows about a request that the runtime cannot see from outside. */
export type ResponseNotes = {
  /** Resource ids the handler touched, e.g. `{ userId, orderId }`. */
  ids?: Record<string, string>
  /** Set when the handler created a resource the request referred to but did not exist. */
  adopted?: boolean
}

const notes = new WeakMap<Response, ResponseNotes>()

/**
 * Attach notes to a response for the request journal and structured log. They travel
 * beside the response, never in it, so nothing the vendor would not send reaches a client.
 */
export const annotateResponse = (response: Response, extra: ResponseNotes): Response => {
  const existing = notes.get(response)
  notes.set(response, {
    ...existing,
    ...extra,
    ...(existing?.ids || extra.ids ? { ids: { ...existing?.ids, ...extra.ids } } : {}),
  })
  return response
}

export const responseNotes = (response: Response): ResponseNotes | undefined => notes.get(response)
