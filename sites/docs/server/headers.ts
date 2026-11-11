import type { ServerResponse } from "node:http"

/** Headers every docs response carries, next to its Content-Security-Policy. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
}

/** For a build without a 404 page. */
export const FALLBACK_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"

/** Directives every page's CSP adds to the `script-src` and `style-src` Astro hashes per page. */
export const PAGE_CSP_DIRECTIVES = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
] as const

/** `dist/_headers.json`, which `astro build` writes with the adapter's `staticHeaders`. */
export type StaticHeaders = { pathname: string; headers: { key: string; value: string }[] }[]

/**
 * Live examples (emulator UIs, the admin UI, the notifications harness, the example app) add
 * their own `<style>` elements at runtime, which no build-time hash can cover, and a hash in
 * `style-src` makes browsers ignore `'unsafe-inline'`. So `style-src` drops Astro's hashes and
 * allows inline styles; `script-src` keeps its hashes.
 */
export function allowRuntimeStyles(csp: string): string {
  return csp.replace(/(^|;)\s*style-src\s[^;]*/g, "$1 style-src 'self' 'unsafe-inline'")
}

/** Each prerendered page's own CSP, keyed by its pathname without a trailing slash. */
export function pagePolicies(headers: StaticHeaders): Map<string, string> {
  const policies = new Map<string, string>()
  for (const page of headers) {
    const csp = page.headers.find((h) => h.key.toLowerCase() === "content-security-policy")
    if (csp) policies.set(pageKey(page.pathname), allowRuntimeStyles(csp.value))
  }
  return policies
}

/** The page a request URL names: no query, no trailing slash or `/index.html`. */
export function pageKey(url: string): string {
  let path = url.split(/[?#]/, 1)[0] ?? "/"
  try {
    path = decodeURI(path)
  } catch {}
  path = path.replace(/\/index\.html$/, "/").replace(/\/+$/, "")
  return path || "/"
}

/**
 * Sets the security headers and the exact CSP for the requested page. @astrojs/node 11 would
 * pick a page's CSP by substring (`/services` got `/services/aha`'s hashes and blocked its own
 * scripts), so any CSP it sets afterwards is replaced with this one.
 */
export function setSecurityHeaders(
  url: string,
  res: Pick<ServerResponse, "setHeader">,
  policies: Map<string, string>,
): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  // Any other path is an asset, a markdown twin, the webhook receiver, or a miss Astro answers
  // with the 404 page, so it gets the 404 page's policy.
  const csp = policies.get(pageKey(url)) ?? policies.get("/404") ?? FALLBACK_CSP
  const setHeader = res.setHeader.bind(res)
  res.setHeader = ((name: string, value: number | string | readonly string[]) =>
    setHeader(
      name,
      name.toLowerCase() === "content-security-policy" ? csp : value,
    )) as typeof res.setHeader
  setHeader("Content-Security-Policy", csp)
}
