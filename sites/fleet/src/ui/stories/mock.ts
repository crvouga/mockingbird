/**
 * A stand-in for the control API at the `fetch` level. A scenario lists the responses by request
 * (`"GET /orgs/org_acme"`); the dashboard under it is the real one and cannot tell the difference.
 */

export type MockResponse = {
  status: number
  body: unknown
  /** Responses that replace others once this one has been served: what the call changed. */
  then?: MockRoutes
}

/** The response never arrives. */
export const PENDING = "pending"

/**
 * Responses keyed by `METHOD path`. The path is relative to `/api/v1`, except for `/auth/*` and
 * `/api/openapi.json`, which are written in full.
 */
export type MockRoutes = Record<string, MockResponse | typeof PENDING>

export const ok = (body: unknown, then?: MockRoutes): MockResponse => ({
  status: 200,
  body,
  ...(then ? { then } : {}),
})
export const created = (body: unknown, then?: MockRoutes): MockResponse => ({
  status: 201,
  body,
  ...(then ? { then } : {}),
})
export const failure = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): MockResponse => ({
  status,
  body: { error: { code, message, ...(details !== undefined ? { details } : {}) } },
})

/** The mock's key for a request, or undefined when the request is not for the dashboard's API. */
export function routeKey(method: string, pathname: string): string | undefined {
  if (pathname.startsWith("/api/v1/")) return `${method} ${pathname.slice("/api/v1".length)}`
  if (pathname.startsWith("/auth/") || pathname === "/api/openapi.json")
    return `${method} ${pathname}`
  return undefined
}

export type Mock = {
  fetch: typeof fetch
  /** Every request the dashboard made, in order. */
  calls: string[]
  /** Requests no fixture answered. */
  missing: string[]
  /** Resolves once the dashboard has stopped making requests. */
  settled(): Promise<void>
}

export function createMock(initial: MockRoutes, passthrough?: typeof fetch): Mock {
  const routes = { ...initial }
  const calls: string[] = []
  const missing: string[] = []
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "https://fleet.example.test",
    )
    const key = routeKey((init?.method ?? "GET").toUpperCase(), url.pathname)
    if (!key) {
      if (passthrough) return passthrough(input, init)
      throw new TypeError(`Not a dashboard request: ${url.pathname}`)
    }
    calls.push(key)
    const route = routes[key]
    if (route === PENDING) return new Promise<Response>(() => {})
    if (!route) {
      missing.push(key)
      console.error(`No fixture for ${key}`)
      return Response.json(failure(501, "no_fixture", `No fixture for ${key}`).body, {
        status: 501,
      })
    }
    Object.assign(routes, route.then)
    return Response.json(route.body, { status: route.status })
  }) as typeof fetch
  return {
    fetch: mock,
    calls,
    missing,
    async settled() {
      // Fixtures answer at once, so two turns of the event loop without a request is rest.
      for (let quiet = 0, seen = -1; quiet < 2; ) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        quiet = calls.length === seen ? quiet + 1 : 0
        seen = calls.length
      }
    },
  }
}
