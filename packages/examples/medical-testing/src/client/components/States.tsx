import { type Status, StatusChip } from "@crvouga/mockingbird-ui/react"
import { Card } from "@heroui/react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { message, statusLabel } from "../format.js"

export { date, message, price, statusLabel } from "../format.js"

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

const ORDER_STATUS: Record<string, Status> = {
  pending_payment: "warning",
  payment_failed: "error",
  results_ready: "ok",
  reviewed: "ok",
  cancelled: "neutral",
}

/** An order's (or a timeline step's) status, in the design system's one status palette. */
export const OrderStatus = ({ status }: { status: string }) => (
  <StatusChip status={ORDER_STATUS[status] ?? "info"}>{statusLabel(status)}</StatusChip>
)

/**
 * Where the app's overlays (modals, select menus) are drawn: inside the app's own root, not
 * `document.body`. Embedded, the app lives in the docs site's modal `<dialog>`, and anything
 * outside that top-layer element is inert and hidden behind it.
 */
export const PortalContainer = createContext<Element | undefined>(undefined)
export const usePortalContainer = (): { UNSTABLE_portalContainer?: Element } => {
  const container = useContext(PortalContainer)
  return container ? { UNSTABLE_portalContainer: container } : {}
}

/** A figure and what it counts, in the same card as every other surface's. */
export const Stat = ({ label, value }: { label: string; value: string | number }) => (
  <Card className="gap-1" data-testid="stat">
    <span className="text-sm text-muted">{label}</span>
    <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
  </Card>
)
