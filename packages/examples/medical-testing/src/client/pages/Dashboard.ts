import { html } from "htm/preact"
import { useEffect, useState } from "preact/hooks"
import { api, type Order, type User } from "../api.js"
import { IconCheckCircle, IconClipboardCheck, IconHourglass } from "../components/Icons.js"
import { navigate } from "../router.js"

const initial = (name: string | null): string => (name?.trim()?.[0] ?? "?").toUpperCase()

export const Dashboard = ({ user }: { user: User }) => {
  const [orders, setOrders] = useState<Order[] | null>(null)

  useEffect(() => {
    void api
      .orders()
      .then((res) => setOrders(res.orders))
      .catch(() => setOrders([]))
  }, [])

  const active = orders?.filter((o) => o.status !== "results_ready").length ?? 0
  const mostRecent = orders?.[0]

  return html`
    <div>
      <div class="cove-greeting">
        <span class="cove-avatar">
          ${user.picture ? html`<img src=${user.picture} alt="" />` : initial(user.name)}
        </span>
        <div>
          <h1>Welcome back${user.name ? `, ${user.name.split(" ")[0]}` : ""}.</h1>
          <p class="cove-muted">Here's what's happening with your testing.</p>
        </div>
      </div>

      <div class="cove-stat-row">
        <div class="cove-stat">
          <span class="cove-stat-icon"><${IconClipboardCheck} /></span>
          <div class="cove-stat-value">${orders === null ? "—" : orders.length}</div>
          <div class="cove-stat-label">Total orders</div>
        </div>
        <div class="cove-stat">
          <span class="cove-stat-icon"><${IconHourglass} /></span>
          <div class="cove-stat-value">${orders === null ? "—" : active}</div>
          <div class="cove-stat-label">In progress</div>
        </div>
        <div class="cove-stat">
          <span class="cove-stat-icon"><${IconCheckCircle} /></span>
          <div class="cove-stat-value">${orders === null ? "—" : orders.filter((o) => o.interpretation).length}</div>
          <div class="cove-stat-label">Results ready</div>
        </div>
      </div>

      ${
        mostRecent &&
        html`<div class="cove-card" style="margin-bottom:1.5rem">
        <span class="cove-eyebrow">Most recent order</span>
        <h2>${mostRecent.items.map((i) => i.testName).join(", ")}</h2>
        <p class="cove-muted">Status: ${mostRecent.status.replace(/_/g, " ")}</p>
        <button class="cove-btn cove-btn-ghost" onClick=${() => navigate("orders")}>View orders</button>
      </div>`
      }

      <div class="cove-card">
        <h2>Ready for your next panel?</h2>
        <p class="cove-muted">Browse the catalog and check out in a couple of minutes.</p>
        <button class="cove-btn cove-btn-primary" onClick=${() => navigate("shop")}>Shop lab tests</button>
      </div>
    </div>
  `
}
