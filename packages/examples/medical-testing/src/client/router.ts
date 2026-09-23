import { useEffect, useState } from "preact/hooks"

export type Route = "dashboard" | "shop" | "checkout" | "orders" | "account"

const ROUTES: readonly Route[] = ["dashboard", "shop", "checkout", "orders", "account"]

const parse = (): Route => {
  const hash = window.location.hash.replace(/^#\/?/, "")
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : "dashboard"
}

export const navigate = (route: Route): void => {
  window.location.hash = `/${route}`
}

export const useRoute = (): Route => {
  const [route, setRoute] = useState<Route>(parse())
  useEffect(() => {
    const onHashChange = () => setRoute(parse())
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])
  return route
}
