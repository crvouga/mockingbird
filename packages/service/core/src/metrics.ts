/** One handled request, as the structured log sees it. */
export type RequestLog = {
  service: string
  namespace: string
  operationId: string | undefined
  method: string
  path: string
  status: number
  durationMs: number
  /** True when the path matched no operation in the contract. */
  unmatched: boolean
  /** Set when a fault rule produced the response. */
  faultId?: string
  /** Resource ids the handler touched (`userId`, `orderId`, …), when the service reports them. */
  ids?: Record<string, string>
  /** Set when the service created a resource the request referred to but that did not exist. */
  adopted?: boolean
}

export type MetricsReport = {
  requests: number
  /** Counts keyed `<operationId> <status>`. */
  byOperation: Record<string, number>
  /**
   * Paths that matched no operation, most frequent first.
   *
   * This is the early-warning signal: a consumer calling something the mock does
   * not implement shows up here as a count, before it fails a suite as a 404.
   */
  unmatched: { method: string; path: string; count: number }[]
  faults: number
  totalDurationMs: number
}

export type Metrics = {
  record(entry: RequestLog): void
  report(): MetricsReport
  reset(): void
}

export const createMetrics = (): Metrics => {
  let requests = 0
  let faults = 0
  let totalDurationMs = 0
  const byOperation = new Map<string, number>()
  const unmatched = new Map<string, number>()
  return {
    record(entry) {
      requests++
      totalDurationMs += entry.durationMs
      if (entry.faultId !== undefined) faults++
      const key = `${entry.operationId ?? "(unmatched)"} ${entry.status}`
      byOperation.set(key, (byOperation.get(key) ?? 0) + 1)
      if (entry.unmatched) {
        const route = `${entry.method} ${entry.path}`
        unmatched.set(route, (unmatched.get(route) ?? 0) + 1)
      }
    },
    report: () => ({
      requests,
      byOperation: Object.fromEntries([...byOperation].sort(([a], [b]) => a.localeCompare(b))),
      unmatched: [...unmatched]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([route, count]) => {
          const space = route.indexOf(" ")
          return { method: route.slice(0, space), path: route.slice(space + 1), count }
        }),
      faults,
      totalDurationMs,
    }),
    reset() {
      requests = 0
      faults = 0
      totalDurationMs = 0
      byOperation.clear()
      unmatched.clear()
    },
  }
}
