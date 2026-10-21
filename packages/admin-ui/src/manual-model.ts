import type { Journal } from "./model.js"

export type RequestTarget = { method?: string; path?: string; operationId?: string }
export type ManualFault = RequestTarget & { durationMs: number; count: number }
export type ManualEffect = "delay" | "timeout" | "error"

/** Keep quick actions bounded, and reject invalid inputs before arming a rule. */
export function manualFault(effect: ManualEffect, input: ManualFault): Record<string, unknown> {
  if (!Number.isSafeInteger(input.count) || input.count < 1)
    throw new Error("Enter a positive whole number of requests")
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0)
    throw new Error("Enter a non-negative whole number of milliseconds")
  const path = input.path?.trim()
  if (path && !path.startsWith("/")) throw new Error("Request path must start with /")
  return {
    ...(input.method ? { method: input.method } : {}),
    ...(path ? { path } : {}),
    ...(input.operationId?.trim() ? { operationId: input.operationId.trim() } : {}),
    count: input.count,
    ...(effect === "error" ? { status: 503 } : { [effect]: input.durationMs }),
  }
}

export function journalPath(target: RequestTarget): string {
  const query = new URLSearchParams({ limit: "1000" })
  for (const [key, value] of Object.entries(target)) {
    if (value?.trim()) query.set(key, value.trim())
  }
  return `/requests?${query}`
}

/** Counts are evidence of repeated requests, not a claim about the caller's intent. */
export function requestAttempts(requests: Journal["requests"]): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown> & { attempts: number }>()
  for (const request of requests) {
    const key = JSON.stringify([request.method, request.path, request.operationId])
    const previous = groups.get(key)
    groups.set(key, {
      method: request.method,
      path: request.path,
      operationId: request.operationId,
      attempts: (previous?.attempts ?? 0) + 1,
      failures:
        Number(previous?.failures ?? 0) +
        (request.status === 0 || Number(request.status) >= 400 ? 1 : 0),
      firstStatus: previous?.firstStatus ?? request.status,
      latestStatus: request.status,
      latestAt: request.at,
    })
  }
  return [...groups.values()]
}
