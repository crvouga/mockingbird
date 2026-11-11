import { html } from "htm/preact"
import { type FunctionComponent, render } from "preact"
import { useEffect, useState } from "preact/hooks"
import { can } from "../app/model.js"
import { api, onUnauthorized, type User } from "./api.js"
import { IconGrid, IconList, IconOrders, IconPlus, IconSettings } from "./components/Icons.js"
import { Logo } from "./components/Logo.js"
import { ErrorState, Loading, message } from "./components/States.js"
import { type InboxTarget, openInbox } from "./inbox.js"
import { Account } from "./pages/Account.js"
import { Admin } from "./pages/Admin.js"
import { Checkout } from "./pages/Checkout.js"
import { Dashboard } from "./pages/Dashboard.js"
import { Landing, signInLinkToken } from "./pages/Landing.js"
import { Orders } from "./pages/Orders.js"
import { Shop } from "./pages/Shop.js"
import { configureRouter, navigate, type Route, useRoute } from "./router.js"

const LINKS: { route: Route; label: string; icon: FunctionComponent }[] = [
  { route: "dashboard", label: "Overview", icon: IconGrid },
  { route: "shop", label: "Test catalog", icon: IconPlus },
  { route: "orders", label: "Orders", icon: IconOrders },
  { route: "results", label: "Results", icon: IconList },
]
type Notice = { text: string; inbox?: InboxTarget }

/**
 * The emailed sign-in link lands on the standalone server as `/?sign-in=…`.
 * Redeem it once, then drop it from the address so a reload does not retry a
 * used link. Embedded, the app has no address of its own and never looks.
 */
const redeemSignInLink = async (): Promise<User | null> => {
  const token = signInLinkToken(window.location.search)
  if (!token) return null
  window.history.replaceState(null, "", window.location.pathname + window.location.hash)
  return (await api.emailLink(token)).user
}

const App = ({ embedded }: { embedded: boolean }) => {
  const route = useRoute()
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [checkoutId, setCheckoutId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const load = async () => {
    setError(null)
    try {
      const viaLink = embedded ? null : await redeemSignInLink()
      setUser(viaLink ?? (await api.me()).user)
    } catch (error) {
      setError(message(error))
    }
  }
  useEffect(() => {
    void load()
  }, [])
  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null)
        setCheckoutId(null)
        setNotice(null)
      }),
    [],
  )
  if (error && user === undefined)
    return html`<main class="cove-main"><${ErrorState} error=${error} retry=${load}/></main>`
  if (user === undefined) return html`<${Loading}/>`
  if (!user)
    return html`<main class="cove-main"><${Landing} onSignedIn=${(user: User) => {
      setUser(user)
      setNotice(null)
      navigate("dashboard")
    }}/></main>`
  const signOut = async () => {
    setSigningOut(true)
    setError(null)
    try {
      await api.signOut()
      setUser(null)
      setCheckoutId(null)
      setNotice(null)
      navigate("dashboard")
    } catch (error) {
      setError(message(error))
    } finally {
      setSigningOut(false)
    }
  }
  const startCheckout = (id: string) => {
    setCheckoutId(id)
    setNotice(null)
    navigate("checkout")
  }
  return html`
    <div class="cove-shell">
      <aside class="cove-sidebar">
        <button class="cove-wordmark" onClick=${() => navigate("dashboard")}><${Logo}/></button>
        <div class="cove-workspace-label">${can(user.role, "orders.read") ? "Care workspace" : "Personal workspace"}</div>
        <nav class="cove-nav-links" aria-label="Main navigation">
          ${LINKS.map((link) => html`<button key=${link.route} class="cove-nav-link ${route === link.route ? "is-active" : ""}" aria-current=${route === link.route ? "page" : undefined} onClick=${() => navigate(link.route)}><span aria-hidden="true"><${link.icon}/></span>${link.label}</button>`)}
          ${can(user.role, "users.manage") && html`<button class="cove-nav-link ${route === "admin" ? "is-active" : ""}" aria-current=${route === "admin" ? "page" : undefined} onClick=${() => navigate("admin")}><span aria-hidden="true"><${IconSettings}/></span>Administration</button>`}
        </nav>
        <div class="cove-sidebar-bottom"><p class="cove-muted">Your orders, reports, and care history in one place.</p><button class="cove-nav-user" onClick=${() => navigate("account")}><span class="cove-avatar">${(user.name?.[0] ?? "?").toUpperCase()}</span><span><strong>${user.name ?? "Account"}</strong><small>${user.role}</small></span><span aria-hidden="true">›</span></button></div>
      </aside>
      <div class="cove-workspace">
        <header class="cove-topbar"><span>${route === "account" ? "Account settings" : route === "checkout" ? "Secure checkout" : route === "admin" ? "Administration" : LINKS.find((link) => link.route === route)?.label}</span><span class="cove-topbar-right"><span class="cove-role">${user.role}</span><button class="cove-btn cove-btn-ghost cove-btn-sm" onClick=${() => navigate("account")}>Account</button></span></header>
        <main class="cove-main" id="cove-content"><div class="cove-container">
          ${notice && html`<div class="cove-alert cove-alert-success cove-notice" role="status"><span>${notice.text}</span><span class="cove-notice-actions">${notice.inbox && html`<button class="cove-btn cove-btn-ghost cove-btn-sm" data-testid="open-inbox" onClick=${() => openInbox(notice.inbox)}>Open Notifications</button>`}<button class="cove-btn cove-btn-ghost cove-btn-sm" aria-label="Dismiss notification" onClick=${() => setNotice(null)}>Dismiss</button></span></div>`}
          ${error && html`<${ErrorState} error=${error} retry=${() => setError(null)}/>`}
          ${route === "dashboard" && html`<${Dashboard} user=${user}/>`}
          ${route === "shop" && html`<${Shop} onCheckout=${startCheckout}/>`}
          ${
            route === "checkout" &&
            html`<${Checkout} checkoutSessionId=${checkoutId} onPaid=${() => {
              setCheckoutId(null)
              setNotice({
                text: user.email
                  ? `Payment successful. We emailed your receipt to ${user.email}.`
                  : "Payment successful. Your order is being prepared.",
                ...(user.email ? { inbox: { channel: "email", to: user.email } } : {}),
              })
              navigate("orders")
            }}/>`
          }
          ${(route === "orders" || route === "results") && html`<${Orders} key=${route} user=${user} resultsOnly=${route === "results"} onCheckout=${startCheckout}/>`}
          ${route === "account" && html`<${Account} user=${user} onUpdated=${setUser} onSignOut=${signOut} signingOut=${signingOut}/>`}
          ${route === "admin" && (can(user.role, "users.manage") ? html`<${Admin} user=${user}/>` : html`<div class="cove-card"><h1>Access restricted</h1><p>Administration requires an administrator role.</p><button class="cove-btn cove-btn-primary" onClick=${() => navigate("dashboard")}>Back to overview</button></div>`)}
        </div></main>
        <footer class="cove-footer">Demonstration workspace · Fictional data · No real charges or medical advice</footer>
      </div>
    </div>`
}
export const mountApp = (root: HTMLElement, embedded = false): (() => void) => {
  configureRouter(embedded)
  root.classList.add("cove-app")
  render(html`<${App} embedded=${embedded}/>`, root)
  return () => render(null, root)
}
if (typeof document !== "undefined") {
  const root = document.getElementById("app")
  if (root) mountApp(root)
}
