/**
 * Routing Twilio's per-product hosts onto one mock origin.
 *
 * twilio-node builds absolute URLs on a host per product (`https://verify.twilio.com/v2/…`,
 * `https://lookups.twilio.com/v2/…`, `https://api.twilio.com/2010-04-01/…`). The mock serves
 * them all on one port and tells them apart by the product carried as the first path segment:
 * `{mock}/verify/v2/…`, `{mock}/lookups/v2/…`, `{mock}/api/2010-04-01/…`.
 */

/** The products the mock serves, by their host's first label. */
export const TWILIO_PRODUCTS = ["api", "verify", "lookups"] as const

/** `api.twilio.com`, `verify.twilio.com`, and edge/region forms like `api.sydney.au1.twilio.com`. */
const TWILIO_HOST = /^(api|verify|lookups)(?:\.[a-z0-9-]+)*\.twilio\.com$/i

/**
 * The mock URL for an upstream Twilio URL: `https://verify.twilio.com/v2/Services/VA…/Verifications`
 * with base `http://127.0.0.1:8798` becomes `http://127.0.0.1:8798/verify/v2/Services/VA…/Verifications`.
 * A base with a path (`http://127.0.0.1:8798/ns/worker-1`) keeps it. Non-Twilio URLs are
 * returned unchanged.
 */
export const twilioMockUrl = (uri: string, mockBaseUrl: string): string => {
  const upstream = new URL(uri)
  const product = TWILIO_HOST.exec(upstream.hostname)?.[1]?.toLowerCase()
  if (!product) return uri
  const base = new URL(mockBaseUrl)
  const prefix = base.pathname.replace(/\/+$/, "")
  return `${base.origin}${prefix}/${product}${upstream.pathname}${upstream.search}`
}

/**
 * A request that reached the mock with the real Twilio host in its `Host` header (DNS or a
 * proxy pointing `*.twilio.com` at it) is routed as if it carried the product prefix. The
 * control plane (`/health`, `/__admin`) and already-prefixed paths are left alone.
 */
export const routeByHost = async (request: Request): Promise<Request> => {
  const url = new URL(request.url)
  const product = TWILIO_HOST.exec(url.hostname)?.[1]?.toLowerCase()
  if (!product) return request
  const ns = /^(\/ns\/[^/]+)(\/.*)?$/.exec(url.pathname)
  const prefix = ns?.[1] ?? ""
  const rest = ns ? (ns[2] ?? "/") : url.pathname
  if (
    rest === "/health" ||
    rest === "/__admin" ||
    rest.startsWith("/__admin/") ||
    TWILIO_PRODUCTS.some((p) => rest === `/${p}` || rest.startsWith(`/${p}/`))
  ) {
    return request
  }
  url.pathname = `${prefix}/${product}${rest}`
  const hasBody = request.method !== "GET" && request.method !== "HEAD"
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
    signal: request.signal,
  })
}
