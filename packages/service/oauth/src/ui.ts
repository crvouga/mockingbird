/**
 * The Responses around the emulator's browser pages: status, Content-Security-Policy and cache
 * headers here, the HTML from `#ui/server` (React, prebuilt), loaded only when a page is served.
 */
import type { Account } from "./types.js"

/**
 * Every inline `<style>` and `<script>` carries `nonce`. Inline `style` attributes (the shared
 * components size the mark with one) and the `data:` favicon are the only other sources a page
 * uses.
 */
const policy = (nonce: string, action: string | null) =>
  `default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; ${action === null ? "" : `form-action ${action}; `}base-uri 'none'; frame-ancestors 'none'`

export function page(
  html: string,
  status = 200,
  // null omits form-action: nothing else restricts a form, since it has no default-src fallback.
  action: string | null = "'self'",
  nonce: string = crypto.randomUUID(),
): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy": policy(nonce, action),
    },
  })
}

export async function loginPage(
  transaction: string,
  client: string,
  accounts: Account[],
  base: string,
  action: string,
  signup = false,
  error = "",
  nonce: string = crypto.randomUUID(),
): Promise<Response> {
  const ui = await import("#ui/server")
  return page(
    ui.loginPage({
      transaction,
      client,
      accounts,
      endpoint: `${base}/interaction`,
      signup,
      error,
      nonce,
    }),
    error ? 400 : 200,
    action,
    nonce,
  )
}

export async function consentPage(
  transaction: string,
  client: string,
  account: Account,
  scopes: string,
  base: string,
  action: string,
  privacy?: { hideEmail: boolean; choice: boolean },
  nonce: string = crypto.randomUUID(),
): Promise<Response> {
  const ui = await import("#ui/server")
  return page(
    ui.consentPage({
      transaction,
      client,
      account,
      scopes,
      endpoint: `${base}/interaction`,
      ...(privacy ? { privacy } : {}),
      nonce,
    }),
    200,
    action,
    nonce,
  )
}

/** `GET /`: the emulator's front page. */
export async function homePage(nonce: string): Promise<Response> {
  const ui = await import("#ui/server")
  return page(ui.homePage(nonce), 200, undefined, nonce)
}

/** An interaction whose transaction expired or was already used. */
export async function expiredPage(nonce: string): Promise<Response> {
  const ui = await import("#ui/server")
  return page(ui.expiredPage(nonce), 400, undefined, nonce)
}

export async function redirectPage(location: string, nonce: string): Promise<Response> {
  const ui = await import("#ui/server")
  const response = page(ui.redirectPage(location, nonce), 200, "'none'", nonce)
  response.headers.set("location", location)
  response.headers.set("referrer-policy", "no-referrer")
  return response
}

export async function formPostPage(
  redirectUri: string,
  values: Record<string, string>,
  nonce: string,
): Promise<Response> {
  const ui = await import("#ui/server")
  // The callback may answer this POST with a redirect to an origin only it knows (its web app),
  // and form-action would be applied to that hop too. No source list can allow it.
  return page(ui.formPostPage(redirectUri, values, nonce), 200, null, nonce)
}
