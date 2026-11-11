import type { Limits } from "./config.js"
import { LIMIT_KEYS } from "./config.js"
import type { Database } from "./store/schema.js"

/** An organization's effective quotas: the defaults, with the operator's overrides on top. */
export function effectiveLimits(defaults: Limits, overrides: unknown): Limits {
  const out = { ...defaults }
  if (typeof overrides === "object" && overrides !== null)
    for (const key of LIMIT_KEYS) {
      const value = (overrides as Record<string, unknown>)[key]
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = value
    }
  return out
}

export type RateDecision = {
  allowed: boolean
  limit: number
  remaining: number
  retryAfter: number
}

/**
 * Token buckets held in this process. A limit of `0` means unlimited. Buckets are per replica:
 * with N replicas behind a balancer the effective ceiling is up to N times the configured rate,
 * which is the accepted price of keeping the container stateless and the hot path off the database.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Whether `key` has no tokens left right now, without spending one. */
  exhausted(key: string, perMinute: number): boolean {
    if (perMinute <= 0) return false
    const bucket = this.buckets.get(key)
    if (!bucket) return false
    return bucket.tokens + ((this.now() - bucket.at) / 60_000) * perMinute < 1
  }

  /** Spend one token from `key`'s bucket, which refills to `perMinute` over a minute. */
  take(key: string, perMinute: number): RateDecision {
    if (perMinute <= 0) return { allowed: true, limit: 0, remaining: 0, retryAfter: 0 }
    const time = this.now()
    let bucket = this.buckets.get(key)
    if (!bucket) {
      // Bound memory under a flood of distinct keys: drop the oldest tenth, which have refilled.
      if (this.buckets.size >= this.maxKeys) {
        let drop = Math.ceil(this.maxKeys / 10)
        for (const stale of this.buckets.keys()) {
          this.buckets.delete(stale)
          if (--drop <= 0) break
        }
      }
      bucket = { tokens: perMinute, at: time }
      this.buckets.set(key, bucket)
    } else {
      bucket.tokens = Math.min(perMinute, bucket.tokens + ((time - bucket.at) / 60_000) * perMinute)
      bucket.at = time
      // Re-insert so iteration order stays oldest-first for the eviction above.
      this.buckets.delete(key)
      this.buckets.set(key, bucket)
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return {
        allowed: true,
        limit: perMinute,
        remaining: Math.floor(bucket.tokens),
        retryAfter: 0,
      }
    }
    return {
      allowed: false,
      limit: perMinute,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil(((1 - bucket.tokens) / perMinute) * 60)),
    }
  }
}

export const rateHeaders = (decision: RateDecision): Record<string, string> =>
  decision.limit === 0
    ? {}
    : {
        "ratelimit-limit": String(decision.limit),
        "ratelimit-remaining": String(decision.remaining),
        ...(decision.allowed ? {} : { "retry-after": String(decision.retryAfter) }),
      }

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Counts emulator requests per organization. Counts are added to PostgreSQL in batches (one
 * row per organization per UTC day), so serving a request never waits on the database. The
 * month's total is this replica's unsent count plus the stored total, refreshed at each flush:
 * a quota can be overshot by what other replicas served since the last refresh.
 */
export class UsageMeter {
  private readonly pending = new Map<string, number>()
  private readonly stored = new Map<string, { month: string; requests: number; at: number }>()
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    intervalMs = 10_000,
  ) {
    this.timer = setInterval(() => void this.flush().catch(() => {}), intervalMs)
    this.timer.unref?.()
  }

  /** Requests the organization has served this UTC month, as far as this replica knows. */
  async month(orgId: string): Promise<number> {
    const month = dayOf(this.now()).slice(0, 7)
    let known = this.stored.get(orgId)
    if (!known || known.month !== month || this.now() - known.at > 60_000) {
      const rows = await this.db.find("usage", { org_id: orgId })
      known = {
        month,
        requests: rows
          .filter((row) => row.day.startsWith(month))
          .reduce((sum, row) => sum + row.requests, 0),
        at: this.now(),
      }
      this.stored.set(orgId, known)
    }
    return known.requests + (this.pending.get(orgId) ?? 0)
  }

  record(orgId: string): void {
    this.pending.set(orgId, (this.pending.get(orgId) ?? 0) + 1)
  }

  /** Requests per UTC day for the last `days` days, oldest first. */
  async daily(orgId: string, days = 31): Promise<{ day: string; requests: number }[]> {
    await this.flush()
    const since = dayOf(this.now() - (days - 1) * 86_400_000)
    return (await this.db.find("usage", { org_id: orgId }))
      .filter((row) => row.day >= since)
      .map((row) => ({ day: row.day, requests: row.requests }))
      .sort((a, b) => a.day.localeCompare(b.day))
  }

  async flush(): Promise<void> {
    const batch = [...this.pending]
    this.pending.clear()
    const day = dayOf(this.now())
    for (const [orgId, count] of batch) {
      try {
        await this.db.increment(
          "usage",
          {
            id: `${orgId}:${day}`,
            org_id: orgId,
            day,
            requests: 0,
            created_at: new Date(this.now()).toISOString(),
          },
          "requests",
          count,
        )
        const known = this.stored.get(orgId)
        if (known) known.requests += count
      } catch {
        // Keep the count for the next flush; usage is never dropped because the database blinked.
        this.pending.set(orgId, (this.pending.get(orgId) ?? 0) + count)
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
    await this.flush()
  }
}
