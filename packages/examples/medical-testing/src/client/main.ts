import { html } from "htm/preact"
import { render } from "preact"
import { useEffect, useState } from "preact/hooks"
import { api, onUnauthorized, type User } from "./api.js"
import { Logo } from "./components/Logo.js"
import { Account } from "./pages/Account.js"
import { Checkout } from "./pages/Checkout.js"
import { Dashboard } from "./pages/Dashboard.js"
import { Landing } from "./pages/Landing.js"
import { Orders } from "./pages/Orders.js"
import { Shop } from "./pages/Shop.js"
import { navigate, type Route, useRoute } from "./router.js"

const NAV_LINKS: { route: Route; label: string }[] = [
  { route: "dashboard", label: "Dashboard" },
  { route: "shop", label: "Shop" },
  { route: "orders", label: "Orders" },
]

const initial = (name: string | null): string => (name?.trim()?.[0] ?? "?").toUpperCase()

const Nav = ({
  route,
  user,
  onNavigateAccount,
}: {
  route: Route
  user: User
  onNavigateAccount: () => void
}) => html`
  <nav class="cove-nav">
    <a
      href="#/dashboard"
      class="cove-logo"
      onClick=${(e: Event) => {
        e.preventDefault()
        navigate("dashboard")
      }}
    >
      <${Logo} />
    </a>
    <div class="cove-nav-links">
      ${NAV_LINKS.map(
        (link) => html`
          <a
            key=${link.route}
            href="#/${link.route}"
            class="cove-nav-link ${route === link.route ? "is-active" : ""}"
          >
            ${link.label}
          </a>
        `,
      )}
    </div>
    <span class="cove-spacer" />
    <button class="cove-nav-user" onClick=${onNavigateAccount}>
      <span class="cove-avatar">
        ${user.picture ? html`<img src=${user.picture} alt="" />` : initial(user.name)}
      </span>
      <span class="cove-muted" style="font-size:0.85rem">${user.name ?? user.email ?? "Account"}</span>
    </button>
  </nav>
`

const App = () => {
  const route = useRoute()
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [pendingCheckoutSessionId, setPendingCheckoutSessionId] = useState<string | null>(null)

  useEffect(() => {
    void api.me().then((res) => setUser(res.user))
  }, [])

  // Any 401 from anywhere in the app (an expired session, or a stale
  // request that outlived a sign-out) bounces back to sign-in instead of
  // leaving a signed-in-looking screen stuck behind a "Sign in required"
  // error banner.
  useEffect(() => onUnauthorized(() => setUser(null)), [])

  if (user === undefined) return html`<div class="cove-loading">Loading Cove…</div>`

  if (!user) {
    return html`<div class="cove-main"><div class="cove-container"><${Landing} onSignedIn=${setUser} /></div></div>`
  }

  const signOut = async () => {
    await api.signOut()
    setUser(null)
  }

  return html`
    <div class="cove-shell">
      <${Nav} route=${route} user=${user} onNavigateAccount=${() => navigate("account")} />
      <main class="cove-main">
        <div class="cove-container">
          ${route === "dashboard" && html`<${Dashboard} user=${user} />`}
          ${route === "shop" && html`<${Shop} onCheckout=${setPendingCheckoutSessionId} />`}
          ${route === "checkout" && html`<${Checkout} checkoutSessionId=${pendingCheckoutSessionId} />`}
          ${route === "orders" && html`<${Orders} />`}
          ${route === "account" && html`<${Account} user=${user} onSignOut=${signOut} />`}
        </div>
      </main>
    </div>
  `
}

export const mountApp = (root: HTMLElement): void => {
  root.classList.add("cove-app")
  render(html`<${App} />`, root)
}

// Guarded: this module is also imported by src/browser.ts, which calls
// mountApp() itself against its own container element — and by Bun tests,
// which have no `document` at all.
if (typeof document !== "undefined") {
  const root = document.getElementById("app")
  if (root) mountApp(root)
}
