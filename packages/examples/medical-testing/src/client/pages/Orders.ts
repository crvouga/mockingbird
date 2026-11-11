import { html } from "htm/preact"
import { useEffect, useState } from "preact/hooks"
import { can } from "../../app/model.js"
import { api, type Order, type User } from "../api.js"
import {
  Badge,
  date,
  Empty,
  ErrorState,
  Loading,
  message,
  price,
  statusLabel,
  useResource,
} from "../components/States.js"
import { Tabs } from "../components/Tabs.js"
import { navigate } from "../router.js"

const total = (order: Order) => order.items.reduce((sum, item) => sum + item.priceCents, 0)
const flags = (order: Order) =>
  order.results.flatMap((panel) => panel.markers).filter((marker) => marker.flag !== "normal")
    .length
const isActive = (order: Order) => !["results_ready", "cancelled"].includes(order.status)

const OrderDetail = ({
  order,
  user,
  onBack,
  onRefresh,
  onCheckout,
}: {
  order: Order
  user: User
  onBack: () => void
  onRefresh: () => Promise<void>
  onCheckout: (id: string) => void
}) => {
  const [tab, setTab] = useState("report")
  const [download, setDownload] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [reviewing, setReviewing] = useState(false)
  const file = async (kind: "results" | "receipt" | "record") => {
    setDownload(kind)
    setError(null)
    setSuccess(null)
    try {
      const blob = await api.file(order.id, kind)
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `lab-${order.id}-${kind}.${kind === "results" ? "csv" : kind === "record" ? "json" : "txt"}`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setSuccess("Your file is ready. Check your downloads.")
    } catch (error) {
      setError(message(error))
    } finally {
      setDownload(null)
    }
  }
  const review = async (event: Event) => {
    event.preventDefault()
    setReviewing(true)
    setError(null)
    setSuccess(null)
    try {
      await api.review(order.id, note)
      setNote("")
      setSuccess("Review saved and added to the order timeline.")
      await onRefresh()
    } catch (error) {
      setError(message(error))
    } finally {
      setReviewing(false)
    }
  }
  const steps = ["pending_payment", "fulfilled", "shipped", "processing", "results_ready"]
  const current = steps.indexOf(order.status)
  return html`
    <div class="cove-page">
      <button class="cove-btn cove-btn-ghost cove-btn-sm" onClick=${onBack}>← Back to ${order.status === "results_ready" ? "reports" : "orders"}</button>
      <div class="cove-page-head"><div><p class="cove-eyebrow">Order ${order.id.slice(0, 8)}</p><h1>${order.items.map((item) => item.testName).join(" + ")}</h1><p class="cove-lede">${order.patientName} · Ordered ${date(order.createdAt)}</p></div><${Badge} status=${order.status}/></div>
      ${error && html`<div class="cove-alert cove-alert-error" role="alert">${error}</div>`}
      ${success && html`<div class="cove-alert cove-alert-success" role="status">${success}</div>`}
      <ol class="cove-progress" aria-label="Order progress">${steps.map((step, index) => html`<li key=${step} class=${index <= current ? "is-done" : ""} aria-current=${index === current ? "step" : undefined}><span>${index < current ? "✓" : index + 1}</span>${step === "pending_payment" && current > 0 ? "Payment confirmed" : statusLabel(step)}</li>`)}</ol>
      <${Tabs} tabs=${[{ value: "report", label: "Results & review" }, { value: "timeline", label: `Timeline (${order.timeline.length})` }, { value: "files", label: "Files & receipt" }]} value=${tab} onSelect=${setTab} prefix="order-tab" panel="order-detail-panel" label="Order detail"/>
      <section id="order-detail-panel" role="tabpanel" aria-labelledby=${`order-tab-${tab}`}>
      ${
        tab === "report" &&
        (order.status !== "results_ready"
          ? html`
        <${Empty} title=${order.status === "pending_payment" ? "Complete payment to start your order" : "Your report is in progress"} detail=${order.status === "pending_payment" ? "Your selected tests are saved. Resume checkout whenever you’re ready." : "We’ll update this page when the laboratory releases your results."}/>
        ${order.status === "pending_payment" && order.userId === user.id && html`<button class="cove-btn cove-btn-primary" onClick=${() => onCheckout(order.checkoutSessionId)}>Resume checkout · ${price(total(order))}</button>`}
      `
          : html`
        <div class="cove-stat-row cove-report-stats"><div class="cove-stat"><div class="cove-stat-value">${order.results.reduce((count, panel) => count + panel.markers.length, 0)}</div><span class="cove-stat-label">Biomarkers measured</span></div><div class="cove-stat"><div class="cove-stat-value">${flags(order)}</div><span class="cove-stat-label">Outside reference range</span></div><div class="cove-stat"><div class="cove-stat-value cove-text-sm">${order.reviewedAt ? "Reviewed" : "Awaiting review"}</div><span class="cove-stat-label">Clinical review</span></div></div>
        <p class="cove-muted cove-text-sm">Fictional values and reference ranges for demonstration. The prior sample is synthetic. These results are not for clinical use.</p>
        ${order.results.map((panel) => html`<div class="cove-card cove-card-gap" key=${panel.panel}><div class="cove-section-head"><h2>${panel.panel}</h2><span class="cove-muted cove-text-sm">${panel.markers.length} biomarkers</span></div><div class="cove-table-scroll"><table class="cove-results-table"><thead><tr><th>Biomarker</th><th>Result</th><th>Reference range</th><th>Prior sample</th><th>Status</th></tr></thead><tbody>${panel.markers.map((marker) => html`<tr key=${marker.name}><td><strong>${marker.name}</strong></td><td><strong>${marker.value}</strong> <span class="cove-muted">${marker.unit}</span></td><td><span>${marker.low}–${marker.high}</span><div class="cove-range" aria-hidden="true"><i style=${`left:${Math.max(2, Math.min(98, 10 + ((marker.value - marker.low) / (marker.high - marker.low)) * 80))}%`} class=${marker.flag !== "normal" ? "is-flagged" : ""}></i></div></td><td>${marker.previous} <span class="cove-muted">${marker.value === marker.previous ? "—" : marker.value > marker.previous ? "↑" : "↓"}</span></td><td><span class="cove-badge cove-badge-${marker.flag}">${marker.flag === "normal" ? "In range" : `${marker.flag} ↑`.replace("low ↑", "low ↓")}</span></td></tr>`)}</tbody></table></div></div>`)}
        <div class="cove-card"><h2>Clinical review</h2>${order.reviewedAt ? html`<p class="cove-alert cove-alert-success">Reviewed by ${order.reviewer} · ${date(order.reviewedAt)}</p><p class="cove-review-note">${order.reviewNote}</p>` : can(user.role, "results.review") ? html`<form onSubmit=${review}><label class="cove-field">Review note<textarea class="cove-input" rows="4" required minlength="5" maxlength="2000" value=${note} onInput=${(event: Event) => setNote((event.target as HTMLTextAreaElement).value)} placeholder="Record your review and follow-up notes…"></textarea></label><p class="cove-muted cove-text-sm">Saving records your name and timestamp and makes this note visible to the patient.</p><button class="cove-btn cove-btn-primary" disabled=${reviewing || note.trim().length < 5}>${reviewing ? "Saving review…" : "Complete review"}</button></form>` : html`<p class="cove-muted">Your care team has not reviewed this report yet. A review note will appear here when available.</p>`}</div>
      `)
      }
      ${tab === "timeline" && html`<div class="cove-card"><h2>Order activity</h2><ol class="cove-event-list">${order.timeline.map((event) => html`<li key=${event.id}><span class="cove-event-dot" aria-hidden="true"></span><div><strong>${statusLabel(event.status)}</strong><p>${event.detail}</p><small>${event.actor} · ${new Date(event.createdAt).toLocaleString()}</small></div></li>`)}</ol></div>`}
      ${
        tab === "files" &&
        html`<div class="cove-card"><h2>Documents</h2><p class="cove-muted">Export your report, payment receipt, or complete order record.</p>${(
          [
            [
              "results",
              "Results spreadsheet",
              "CSV · Every biomarker, value, range, and flag",
              order.status === "results_ready",
            ],
            [
              "receipt",
              "Payment receipt",
              "TXT · Itemized tests and order total",
              order.status !== "pending_payment",
            ],
            ["record", "Complete order record", "JSON · Results, review, and timeline", true],
          ] as const
        ).map(
          ([kind, title, detail, available]) =>
            html`<div class="cove-file-row" key=${kind}><span class="cove-file-icon" aria-hidden="true">↓</span><div><strong>${title}</strong><p class="cove-muted cove-text-sm">${available ? detail : "Available when this step is complete"}</p></div><button class="cove-btn cove-btn-ghost cove-btn-sm" disabled=${!available || download !== null} onClick=${() => void file(kind)}>${download === kind ? "Preparing…" : "Download"}</button></div>`,
        )}</div><div class="cove-card cove-card-gap"><h2>Order summary</h2>${order.items.map((item) => html`<div class="cove-summary-row" key=${item.testName}><span>${item.testName}</span><strong>${price(item.priceCents)}</strong></div>`)}<div class="cove-summary-row"><strong>Total</strong><strong>${price(total(order))}</strong></div><p class="cove-muted cove-text-sm">Order ID: ${order.id}</p>${order.labOrderId && html`<p class="cove-muted cove-text-sm">Laboratory reference: ${order.labOrderId}</p>`}</div>`
      }
      </section>
    </div>`
}

export const Orders = ({
  user,
  resultsOnly = false,
  onCheckout,
}: {
  user: User
  resultsOnly?: boolean
  onCheckout: (id: string) => void
}) => {
  const [workspace, setWorkspace] = useState(can(user.role, "orders.read"))
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [sort, setSort] = useState("newest")
  const [selected, setSelected] = useState<string | null>(null)
  const resource = useResource(() => api.orders(workspace), String(workspace))
  useEffect(() => {
    const interval = setInterval(() => {
      if (resource.data?.orders.some(isActive) && !resource.busy) void resource.refresh()
    }, 2000)
    return () => clearInterval(interval)
  }, [resource.data, resource.busy, resource.refresh])
  const orders = resource.data?.orders ?? []
  const order = orders.find((order) => order.id === selected)
  const visible = orders
    .filter(
      (order) =>
        (!resultsOnly || order.status === "results_ready") &&
        (filter === "all" ||
          (filter === "active"
            ? isActive(order)
            : filter === "unreviewed"
              ? order.status === "results_ready" && !order.reviewedAt
              : order.status === filter)) &&
        `${order.patientName} ${order.id} ${order.items.map((item) => item.testName).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "oldest"
        ? Date.parse(a.createdAt) - Date.parse(b.createdAt)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
  if (order)
    return html`<${OrderDetail} key=${order.id} order=${order} user=${user} onBack=${() => setSelected(null)} onRefresh=${resource.refresh} onCheckout=${onCheckout}/>`
  return html`<div class="cove-page"><div class="cove-page-head"><div><p class="cove-eyebrow">${workspace ? "Care workspace" : "Personal workspace"}</p><h1>${resultsOnly ? "Results" : "Orders"}</h1><p class="cove-lede">${resultsOnly ? "Explore your reports, compare measurements, and download your records." : "Track every order from checkout to clinical review."}</p></div><button class="cove-btn cove-btn-primary" onClick=${() => navigate("shop")}>+ Order tests</button></div>
    ${
      can(user.role, "orders.read") &&
      html`<div class="cove-segment" aria-label="Order scope"><button aria-pressed=${!workspace} onClick=${() => {
        setWorkspace(false)
        setSelected(null)
      }}>My orders</button><button aria-pressed=${workspace} onClick=${() => {
        setWorkspace(true)
        setSelected(null)
      }}>All patients</button></div>`
    }
    <div class="cove-toolbar"><label class="cove-search">Search<input class="cove-input" type="search" placeholder="Search tests, patients, or order ID…" value=${query} onInput=${(event: Event) => setQuery((event.target as HTMLInputElement).value)}/></label><label class="cove-field">Status<select class="cove-input" value=${filter} onChange=${(event: Event) => setFilter((event.target as HTMLSelectElement).value)}><option value="all">All statuses</option>${!resultsOnly && html`<option value="active">In progress</option><option value="pending_payment">Awaiting payment</option><option value="results_ready">Results ready</option>`}<option value="unreviewed">Awaiting review</option></select></label><label class="cove-field">Sort<select class="cove-input" value=${sort} onChange=${(event: Event) => setSort((event.target as HTMLSelectElement).value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><button class="cove-btn cove-btn-ghost cove-btn-sm" disabled=${resource.busy} onClick=${resource.refresh}>${resource.busy ? "Refreshing…" : "Refresh"}</button></div>
    ${resource.error && html`<${ErrorState} error=${resource.error} retry=${resource.refresh}/>`}
    ${
      !resource.data && resource.busy
        ? html`<${Loading} label="Loading orders…"/>`
        : !resource.error && visible.length === 0
          ? html`<${Empty} title=${query || filter !== "all" ? "No matching orders" : resultsOnly ? "No reports available yet" : "No orders yet"} detail=${query || filter !== "all" ? "Try another search or clear your filters." : "Choose a test from the catalog to start your first order."} action=${() => {
              if (query || filter !== "all") {
                setQuery("")
                setFilter("all")
              } else navigate("shop")
            }} label=${query || filter !== "all" ? "Clear filters" : "Browse tests"}/>`
          : html`<p class="cove-muted cove-text-sm">${visible.length} ${resultsOnly ? "reports" : "orders"}${orders.some(isActive) ? " · Active orders update automatically" : ""}</p><div class="cove-order-list">${visible.map((order) => html`<button class="cove-order-card cove-order-button" key=${order.id} onClick=${() => setSelected(order.id)}><div class="cove-order-header"><span class="cove-muted cove-text-sm">${date(order.createdAt)} · #${order.id.slice(0, 8)}${workspace ? ` · ${order.patientName}` : ""}</span><${Badge} status=${order.status}/></div><h2>${order.items.map((item) => item.testName).join(" + ")}</h2><div class="cove-summary-row"><span class="cove-muted cove-text-sm">${order.status === "results_ready" ? `${flags(order)} outside range · ${order.reviewedAt ? "Reviewed" : "Awaiting review"}` : "View progress and order details"}</span><strong>${price(total(order))} <span aria-hidden="true">↗</span></strong></div></button>`)}</div>`
    }
  </div>`
}
