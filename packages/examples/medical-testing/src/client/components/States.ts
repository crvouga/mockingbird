import { html } from "htm/preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong. Please try again."
export const Loading = ({ label = "Loading your workspace…" }: { label?: string }) =>
  html`<div class="cove-loading" role="status"><span class="cove-spinner" aria-hidden="true"></span>${label}</div>`
export const ErrorState = ({ error, retry }: { error: string; retry: () => void }) =>
  html`<div class="cove-alert cove-alert-error" role="alert"><strong>We couldn’t complete this request.</strong><p>${error}</p><button class="cove-btn cove-btn-ghost" onClick=${retry}>Try again</button></div>`
export const Empty = ({
  title,
  detail,
  action,
  label,
}: {
  title: string
  detail: string
  action?: () => void
  label?: string
}) =>
  html`<div class="cove-empty cove-card"><span class="cove-empty-icon" aria-hidden="true">□</span><h2>${title}</h2><p>${detail}</p>${action && html`<button class="cove-btn cove-btn-primary" onClick=${action}>${label}</button>`}</div>`

/** Ignores stale responses and keeps successful data on background refresh failure. */
export function useResource<T>(loader: () => Promise<T>, key = "") {
  const latest = useRef(loader)
  latest.current = loader
  const ticket = useRef(0)
  const activeKey = useRef(key)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const refresh = useCallback(async () => {
    const generation = ++ticket.current
    setBusy(true)
    setError(null)
    try {
      const value = await latest.current()
      if (ticket.current === generation) setData(value)
    } catch (error) {
      if (ticket.current === generation) setError(message(error))
    } finally {
      if (ticket.current === generation) setBusy(false)
    }
  }, [])
  useEffect(() => {
    activeKey.current = key
    setData(null)
    void refresh()
    return () => {
      ticket.current++
    }
  }, [key, refresh])
  const current = activeKey.current === key
  return {
    data: current ? data : null,
    error: current ? error : null,
    busy: !current || busy,
    refresh,
  }
}
export const price = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
export const date = (value: string): string =>
  new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
export const statusLabel = (value: string): string =>
  ({
    pending_payment: "Awaiting payment",
    fulfilled: "Kit requested",
    shipped: "Kit shipped",
    payment_failed: "Payment declined",
    processing: "Processing",
    results_ready: "Results ready",
    reviewed: "Reviewed",
  })[value] ?? value.replaceAll("_", " ")
export const Badge = ({ status }: { status: string }) =>
  html`<span class="cove-badge cove-badge-${status}">${statusLabel(status)}</span>`
