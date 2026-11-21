import { useEffect, useState } from "react"

export type Route = "dashboard" | "shop" | "checkout" | "orders" | "results" | "account" | "admin"
const ROUTES: readonly Route[] = [
  "dashboard",
  "shop",
  "checkout",
  "orders",
  "results",
  "account",
  "admin",
]
const listeners = new Set<() => void>()
let embedded = false
let current: Route = "dashboard"
export const configureRouter = (inDocs: boolean): void => {
  embedded = inDocs
  current = "dashboard"
}
const routeOf = (hash: string): Route | null => {
  const name = hash.replace(/^#\/?/, "")
  return (ROUTES as readonly string[]).includes(name) ? (name as Route) : null
}
const parse = (): Route => (embedded ? current : (routeOf(window.location.hash) ?? "dashboard"))

/** The link for a route: `#/orders`. Embedded, links are followed by `navigateHref`, never the page. */
export const hrefFor = (route: Route): string => `#/${route}`

export const navigate = (route: Route): void => {
  current = route
  if (!embedded) window.location.hash = `/${route}`
  for (const listener of listeners) listener()
}

/** Client-side navigation for HeroUI links (`MockingbirdProvider navigate`). */
export const navigateHref = (href: string): void => {
  const route = routeOf(href.slice(href.indexOf("#")))
  if (route) navigate(route)
}

export const useRoute = (): Route => {
  const [route, setRoute] = useState<Route>(parse)
  useEffect(() => {
    const change = () => setRoute(parse())
    listeners.add(change)
    if (!embedded) window.addEventListener("hashchange", change)
    return () => {
      listeners.delete(change)
      window.removeEventListener("hashchange", change)
    }
  }, [])
  return route
}
