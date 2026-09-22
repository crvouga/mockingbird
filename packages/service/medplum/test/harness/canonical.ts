/**
 * Canonical form of an HTTP exchange, so the oracle's and the mock's answers to the same
 * request compare equal exactly when they agree on everything but volatile values.
 *
 * Volatile values are replaced by symbols numbered in order of first appearance, per side:
 * UUIDs (`uuid#3`), instants (`time#2`), hex secrets and codes (`hex#1`), JWTs (`<jwt>`),
 * and the side's base URL (`BASE/`). Numbering by appearance keeps relationships — the id a
 * create returned is the id a later read must return — while dropping the values themselves.
 * The tracing extension (fresh request and trace ids on every outcome) is dropped.
 */

export type CanonicalExchange = {
  status: number
  headers: Record<string, string>
  body: unknown
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const JWT = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/
const HEX_SECRET = /^[0-9a-f]{32}$|^[0-9a-f]{64}$/
const DELETED_ON = /^Deleted on (.+)$/
const CURSOR = /_cursor=(\d)-(\d{10,})/g
const SIGNATURE = /([?&])Signature=[^&"]*/g
const EXPIRES = /([?&])Expires=(\d{9,})/g

/** How the answer's `entry` order may be compared. */
export type EntryOrder =
  | { kind: "ordered" }
  /**
   * No `_sort`: the server returns heap order, which depends on Postgres's free-space reuse
   * across every project's rows. A complete answer compares as a set; a partial page (full, or
   * offset) holds an arbitrary subset, so only its size is comparable.
   */
  | { kind: "unordered"; partial?: boolean }
  /**
   * Sorted: entries with equal sort values are ties Postgres may return in any order (its sort
   * is not stable). `pageFull` marks a page cut by `_count`, whose last tie group may continue
   * on the next page — only its size and values are comparable.
   */
  | { kind: "sorted"; keyOf: (resource: unknown) => string; pageFull: boolean; offset: boolean }

/** The response headers that take part in the comparison. */
export const COMPARED_HEADERS = [
  "content-type",
  "location",
  "etag",
  "last-modified",
  "www-authenticate",
  "content-location",
  "cache-control",
  "pragma",
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "x-xss-protection",
] as const

export class Canonicalizer {
  private readonly uuids = new Map<string, string>()
  private readonly times = new Map<number, string>()
  private readonly hexes = new Map<string, string>()

  constructor(private readonly baseUrl: string) {}

  /** Give a known value a fixed name (the provisioned project, its client…). */
  name(uuid: string, symbol: string): void {
    this.uuids.set(uuid.toLowerCase(), `uuid:${symbol}`)
  }

  private uuid(value: string): string {
    const key = value.toLowerCase()
    let symbol = this.uuids.get(key)
    if (!symbol) {
      symbol = `uuid#${this.uuids.size + 1}`
      this.uuids.set(key, symbol)
    }
    return symbol
  }

  private time(ms: number): string {
    let symbol = this.times.get(ms)
    if (!symbol) {
      symbol = `time#${this.times.size + 1}`
      this.times.set(ms, symbol)
    }
    return symbol
  }

  private hex(value: string): string {
    let symbol = this.hexes.get(value)
    if (!symbol) {
      symbol = `hex#${this.hexes.size + 1}`
      this.hexes.set(value, symbol)
    }
    return symbol
  }

  string(value: string): string {
    if (JWT.test(value)) return "<jwt>"
    if (HEX_SECRET.test(value)) return this.hex(value)
    if (ISO_INSTANT.test(value)) {
      const ms = Date.parse(value)
      if (!Number.isNaN(ms)) return this.time(ms)
    }
    const deleted = DELETED_ON.exec(value)
    if (deleted) {
      const ms = Date.parse(deleted[1] as string)
      if (!Number.isNaN(ms)) return `Deleted on ${this.time(ms)}`
    }
    let out = value.split(this.baseUrl).join("BASE/")
    out = out.replace(
      CURSOR,
      (_m, version: string, ms: string) => `_cursor=${version}-${this.time(Number(ms))}`,
    )
    out = out.replace(SIGNATURE, (_m, sep: string) => `${sep}Signature=<signature>`)
    out = out.replace(
      EXPIRES,
      (_m, sep: string, seconds: string) => `${sep}Expires=${this.time(Number(seconds) * 1000)}`,
    )
    return out.replace(UUID, (match) => this.uuid(match))
  }

  /** Canonical JSON: sorted keys, volatile strings symbolized, tracing extensions dropped. */
  value(input: unknown, unorderedEntries: boolean | EntryOrder = false): unknown {
    const order: EntryOrder =
      typeof unorderedEntries === "object"
        ? unorderedEntries
        : { kind: unorderedEntries ? "unordered" : "ordered" }
    if (typeof input === "string") return this.string(input)
    if (Array.isArray(input)) return input.map((item) => this.value(item))
    if (input === null || typeof input !== "object") return input
    const record = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      let item = record[key]
      if (key === "extension" && Array.isArray(item)) {
        item = item.filter(
          (e) =>
            !(
              e &&
              typeof e === "object" &&
              (e as { url?: string }).url === "https://medplum.com/fhir/StructureDefinition/tracing"
            ),
        )
        if ((item as unknown[]).length === 0) continue
      }
      if (order.kind === "unordered" && key === "entry" && Array.isArray(item)) {
        out[key] = order.partial
          ? { partialPageOfUnsortedResults: item.length }
          : this.unordered(item)
        continue
      }
      if (order.kind === "sorted" && key === "entry" && Array.isArray(item)) {
        out[key] = this.sorted(item, order)
        continue
      }
      // Search links sort their parameters by raw value (`formatSearchQuery`), so params that
      // embed ids order differently on each side: compare them as a sorted list.
      if (key === "link" && Array.isArray(item)) {
        out[key] = item.map((link) => {
          const canonical = this.value(link) as { url?: string }
          if (typeof canonical?.url !== "string" || !canonical.url.includes("?")) return canonical
          const [head, query] = canonical.url.split("?") as [string, string]
          return { ...canonical, url: `${head}?${query.split("&").sort().join("&")}` }
        })
        continue
      }
      // Client addresses depend on the network path, not on the server.
      if (key === "remoteAddress" && typeof item === "string") {
        out[key] = "<ip>"
        continue
      }
      out[this.string(key)] = this.value(item)
    }
    return out
  }

  /**
   * Symbolize a list whose order the server does not define (a search without `_sort`):
   * entries are ordered by their content with unseen ids masked, then symbolized in that order.
   */
  private unordered(items: unknown[]): unknown[] {
    const masked = (item: unknown) =>
      JSON.stringify(item, (_k, v) => (typeof v === "string" ? this.maskUnknown(v) : v))
    const known = (item: unknown) => JSON.stringify(this.peek(item))
    const sorted = [...items].sort((a, b) => {
      const x = `${known(a)}\u0000${masked(a)}`
      const y = `${known(b)}\u0000${masked(b)}`
      return x < y ? -1 : x > y ? 1 : 0
    })
    return sorted
      .map((item) => this.value(item))
      .sort((a, b) => {
        const x = JSON.stringify(a)
        const y = JSON.stringify(b)
        return x < y ? -1 : x > y ? 1 : 0
      })
  }

  /** Tie groups (runs of equal sort values) compared as sets, in order. */
  private sorted(items: unknown[], order: Extract<EntryOrder, { kind: "sorted" }>): unknown[] {
    const matches = items.filter(
      (item) => (item as { search?: { mode?: string } })?.search?.mode !== "include",
    )
    const rest = items.filter(
      (item) => (item as { search?: { mode?: string } })?.search?.mode === "include",
    )
    const groups: unknown[][] = []
    let lastKey: string | undefined
    for (const item of matches) {
      const key = order.keyOf((item as { resource?: unknown }).resource)
      if (groups.length === 0 || key !== lastKey) groups.push([])
      ;(groups[groups.length - 1] as unknown[]).push(item)
      lastKey = key
    }
    const out: unknown[] = []
    groups.forEach((group, index) => {
      const cut = (order.pageFull && index === groups.length - 1) || (order.offset && index === 0)
      if (cut) {
        out.push({ tieGroupCutByPage: group.length })
      } else {
        out.push({ tieGroup: this.unordered(group) })
      }
    })
    if (rest.length > 0) out.push({ included: this.unordered(rest) })
    return out
  }

  private maskUnknown(value: string): string {
    return value.replace(UUID, (match) => this.uuids.get(match.toLowerCase()) ?? "uuid?")
  }

  /** Canonical form without assigning new symbols (unknown ids stay masked). */
  private peek(input: unknown): unknown {
    if (typeof input === "string") {
      if (ISO_INSTANT.test(input) || JWT.test(input)) return "<volatile>"
      return this.maskUnknown(input.split(this.baseUrl).join("BASE/"))
    }
    if (Array.isArray(input)) return input.map((item) => this.peek(item))
    if (input === null || typeof input !== "object") return input
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(input as object).sort()) {
      out[key] = this.peek((input as Record<string, unknown>)[key])
    }
    return out
  }

  async exchange(
    response: Response,
    options: { unorderedEntries?: boolean | EntryOrder } = {},
  ): Promise<CanonicalExchange> {
    const headers: Record<string, string> = {}
    for (const name of COMPARED_HEADERS) {
      const value = response.headers.get(name)
      if (value === null) continue
      if (name === "last-modified") headers[name] = "<http-date>"
      else if (name === "etag") headers[name] = this.string(value)
      else headers[name] = this.string(value)
    }
    const text = await response.text()
    let body: unknown = text
    const type = response.headers.get("content-type") ?? ""
    if (type.includes("json") && text.length > 0) {
      try {
        body = this.value(JSON.parse(text), options.unorderedEntries ?? false)
      } catch {
        body = this.string(text)
      }
    } else {
      body = this.string(text)
    }
    return { status: response.status, headers, body }
  }
}

/** Human-readable differences between two canonical values, empty when equal. */
export const diff = (real: unknown, mock: unknown, path = "$"): string[] => {
  if (JSON.stringify(real) === JSON.stringify(mock)) return []
  if (Array.isArray(real) && Array.isArray(mock)) {
    const out: string[] = []
    if (real.length !== mock.length)
      out.push(`${path}: length ${real.length} (oracle) vs ${mock.length} (mock)`)
    for (let i = 0; i < Math.min(real.length, mock.length); i++)
      out.push(...diff(real[i], mock[i], `${path}[${i}]`))
    return out
  }
  if (
    real &&
    mock &&
    typeof real === "object" &&
    typeof mock === "object" &&
    !Array.isArray(real) &&
    !Array.isArray(mock)
  ) {
    const out: string[] = []
    const keys = new Set([...Object.keys(real), ...Object.keys(mock)])
    for (const key of [...keys].sort()) {
      const a = (real as Record<string, unknown>)[key]
      const b = (mock as Record<string, unknown>)[key]
      if (a === undefined)
        out.push(`${path}.${key}: only in mock: ${JSON.stringify(b)?.slice(0, 200)}`)
      else if (b === undefined)
        out.push(`${path}.${key}: only in oracle: ${JSON.stringify(a)?.slice(0, 200)}`)
      else out.push(...diff(a, b, `${path}.${key}`))
    }
    return out
  }
  return [
    `${path}: ${JSON.stringify(real)?.slice(0, 300)} (oracle) vs ${JSON.stringify(mock)?.slice(0, 300)} (mock)`,
  ]
}
