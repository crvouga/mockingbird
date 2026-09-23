import { html } from "htm/preact"
import { useEffect, useRef, useState } from "preact/hooks"
import { api, type Order } from "../api.js"

const formatPrice = (cents: number): string => `$${(cents / 100).toFixed(2)}`

const STEPS = ["Ordered", "Sample requested", "Processing", "Results ready"]

const stepIndex = (status: string): number => {
  if (status === "results_ready") return 3
  if (status === "fulfilled") return 2
  return 1
}

const isSettled = (order: Order): boolean => order.status === "results_ready"

const Timeline = ({ status }: { status: string }) => {
  const current = stepIndex(status)
  return html`
    <div class="cove-timeline">
      ${STEPS.map((label, index) => {
        const state = index < current ? "is-done" : index === current ? "is-current" : ""
        return html`
          <div class="cove-timeline-step ${state}" key=${label}>
            <span class="cove-timeline-dot">${index < current ? "✓" : ""}</span>
            <span class="cove-timeline-label">${label}</span>
          </div>
        `
      })}
    </div>
  `
}

const statusLabel = (status: string): string =>
  status === "results_ready" ? "Results ready" : status.replace(/_/g, " ")

const POLL_INTERVAL_MS = 2_000

export const Orders = () => {
  const [orders, setOrders] = useState<Order[]>([])
  const [error, setError] = useState<string | null>(null)
  const ordersRef = useRef<Order[]>([])
  ordersRef.current = orders

  const load = () => api.orders().then((res) => setOrders(res.orders))

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  // A freshly paid order's status arrives asynchronously (via a webhook),
  // and so does its eventual results — poll gently while anything is
  // still in flight, the normal pattern for any hosted-checkout-backed flow.
  useEffect(() => {
    const interval = setInterval(() => {
      if (ordersRef.current.some((order) => !isSettled(order))) void load()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  return html`
    <div>
      <h1>Your orders</h1>
      ${error && html`<p class="cove-alert cove-alert-error">${error}</p>`}
      ${orders.length === 0 && html`<div class="cove-empty">No orders yet — head to the shop to order your first test.</div>`}
      <div class="cove-order-list">
        ${orders.map(
          (order) => html`
            <div class="cove-order-card" key=${order.id}>
              <div class="cove-order-header">
                <span class="cove-badge cove-badge-${order.status}">${statusLabel(order.status)}</span>
                <span class="cove-muted" style="font-size:0.82rem">${new Date(order.createdAt).toLocaleString()}</span>
              </div>
              <ul class="cove-order-items">
                ${order.items.map((item) => html`<li>${item.testName} — ${formatPrice(item.priceCents)}</li>`)}
              </ul>

              <${Timeline} status=${order.status} />

              ${
                !isSettled(order) &&
                html`<p class="cove-muted" style="font-size:0.82rem">Typically ready within a few minutes.</p>`
              }

              ${
                order.interpretation &&
                html`<table class="cove-results-table">
                <thead>
                  <tr><th>Panel</th><th>Interpretation</th></tr>
                </thead>
                <tbody>
                  ${order.items.map(
                    (item) =>
                      html`<tr key=${item.testName}><td>${item.testName}</td><td>${order.interpretation}</td></tr>`,
                  )}
                </tbody>
              </table>`
              }
            </div>
          `,
        )}
      </div>
    </div>
  `
}
