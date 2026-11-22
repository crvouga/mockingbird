import {
  AppShell,
  type AppShellNavItem,
  CenteredCard,
  EmptyState,
  ErrorState,
  LoadingState,
  ThemeSwitch,
} from "@crvouga/mockingbird-ui/react"
import { mount } from "@crvouga/mockingbird-ui/react/client"
import { Gear, House, ListUl, Person, ShoppingCart, SquareListUl } from "@gravity-ui/icons"
import { Alert, Button, Card } from "@heroui/react"
import { type ComponentType, useEffect, useState } from "react"
import { can } from "../app/model.js"
import { api, onUnauthorized, type User } from "./api.js"
import { PortalContainer } from "./components/States.js"
import { message, signInLinkToken } from "./format.js"
import { type InboxTarget, openInbox } from "./inbox.js"
import { Account } from "./pages/Account.js"
import { Admin } from "./pages/Admin.js"
import { Checkout } from "./pages/Checkout.js"
import { Dashboard } from "./pages/Dashboard.js"
import { Landing } from "./pages/Landing.js"
import { Orders } from "./pages/Orders.js"
import { Shop } from "./pages/Shop.js"
import { PRODUCT } from "./product.js"
import { configureRouter, hrefFor, navigate, navigateHref, type Route, useRoute } from "./router.js"

const LINKS: { route: Route; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { route: "dashboard", label: "Overview", icon: House },
  { route: "shop", label: "Test catalog", icon: ShoppingCart },
  { route: "orders", label: "Orders", icon: SquareListUl },
  { route: "results", label: "Results", icon: ListUl },
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
    return (
      <CenteredCard product={PRODUCT} title="The workspace is unavailable">
        <ErrorState
          title="We couldn’t complete this request."
          error={error}
          onRetry={() => void load()}
          retryLabel="Try again"
        />
      </CenteredCard>
    )
  if (user === undefined)
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Loading your workspace…" />
      </div>
    )
  if (!user)
    return (
      <Landing
        onSignedIn={(user) => {
          setUser(user)
          setNotice(null)
          navigate("dashboard")
        }}
      />
    )
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
  const nav: AppShellNavItem[] = [
    ...LINKS.map(({ route: to, label, icon: Icon }) => ({
      label,
      href: hrefFor(to),
      current: route === to,
      icon: <Icon className="size-4" />,
    })),
    ...(can(user.role, "users.manage")
      ? [
          {
            label: "Administration",
            href: hrefFor("admin"),
            current: route === "admin",
            icon: <Gear className="size-4" />,
          },
        ]
      : []),
  ]
  return (
    <AppShell
      product={PRODUCT}
      nav={nav}
      actions={
        <>
          <Button
            size="sm"
            variant={route === "account" ? "secondary" : "ghost"}
            {...(route === "account" ? { "aria-current": "page" as const } : {})}
            onPress={() => navigate("account")}
          >
            <Person className="size-4" />
            Account
          </Button>
          <ThemeSwitch />
        </>
      }
      footer="Demonstration workspace · Fictional data · No real charges or medical advice"
    >
      <div className="flex flex-col gap-4" id="cove-content">
        {notice ? (
          <Alert status="success" role="status" data-testid="app-notice">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{notice.text}</Alert.Description>
              <div className="mt-2 flex flex-wrap gap-2">
                {notice.inbox ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="open-inbox"
                    onPress={() => openInbox(notice.inbox)}
                  >
                    Open Notifications
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Dismiss notification"
                  onPress={() => setNotice(null)}
                >
                  Dismiss
                </Button>
              </div>
            </Alert.Content>
          </Alert>
        ) : null}
        {error ? (
          <ErrorState
            title="We couldn’t complete this request."
            error={error}
            onRetry={() => setError(null)}
            retryLabel="Dismiss"
          />
        ) : null}
        {route === "dashboard" ? <Dashboard user={user} /> : null}
        {route === "shop" ? <Shop onCheckout={startCheckout} /> : null}
        {route === "checkout" ? (
          <Checkout
            checkoutSessionId={checkoutId}
            onPaid={() => {
              setCheckoutId(null)
              setNotice({
                text: user.email
                  ? `Payment successful. We emailed your receipt to ${user.email}.`
                  : "Payment successful. Your order is being prepared.",
                ...(user.email ? { inbox: { channel: "email", to: user.email } } : {}),
              })
              navigate("orders")
            }}
          />
        ) : null}
        {route === "orders" || route === "results" ? (
          <Orders
            key={route}
            user={user}
            resultsOnly={route === "results"}
            onCheckout={startCheckout}
          />
        ) : null}
        {route === "account" ? (
          <Account user={user} onUpdated={setUser} onSignOut={signOut} signingOut={signingOut} />
        ) : null}
        {route === "admin" ? (
          can(user.role, "users.manage") ? (
            <Admin user={user} />
          ) : (
            <Card>
              <EmptyState
                icon={<Gear />}
                title="Access restricted"
                description="Administration requires an administrator role."
                action={<Button onPress={() => navigate("dashboard")}>Back to overview</Button>}
              />
            </Card>
          )
        ) : null}
      </div>
    </AppShell>
  )
}

/** The app, with the element its overlays are drawn into (see `PortalContainer`). */
const Root = ({ embedded }: { embedded: boolean }) => {
  const [overlays, setOverlays] = useState<HTMLDivElement | null>(null)
  return (
    <PortalContainer value={overlays ?? undefined}>
      <App embedded={embedded} />
      <div ref={setOverlays} data-testid="app-overlays" />
    </PortalContainer>
  )
}

export const mountApp = (root: HTMLElement, embedded = false): (() => void) => {
  configureRouter(embedded)
  // Embedded, the app fills the panel it is given and scrolls inside it.
  if (embedded) {
    if (!root.style.height) root.style.height = "100%"
    root.style.overflow = "auto"
  }
  const react = mount(root, <Root embedded={embedded} />, { navigate: navigateHref })
  return () => react.unmount()
}
if (typeof document !== "undefined") {
  const root = document.getElementById("app")
  if (root) mountApp(root)
}
