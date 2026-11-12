// Hosted UI pages and OAuth helpers for /oauth2/authorize and /oauth2/token.
// Endpoint shapes follow the Cognito developer guide:
// https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html
// https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html
import type { CognitoUser } from "./state.js"

/** System-reserved scopes; a client without AllowedOAuthScopes is given all of them. */
export const SYSTEM_SCOPES = [
  "openid",
  "email",
  "phone",
  "profile",
  "aws.cognito.signin.user.admin",
]
/** Social providers named by Cognito; any other name is an OIDC/SAML provider. */
export const SOCIAL_PROVIDERS = ["Google", "SignInWithApple", "Facebook", "LoginWithAmazon"]
export const providerType = (provider: string) =>
  SOCIAL_PROVIDERS.includes(provider) ? provider : "OIDC"

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  )
const style =
  ":root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;--line:#d4d4d8;--muted:#71717a}body{margin:0;min-height:100svh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{width:min(100% - 32px,420px)}h1{font-size:22px;margin:0 0 8px}p{color:var(--muted);font-size:14px;line-height:1.5}.account{display:block;width:100%;text-align:left;margin:8px 0;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}.account small{display:block;color:var(--muted)}.cancel{margin-top:16px;background:none;border:0;color:var(--muted);text-decoration:underline;cursor:pointer;font:inherit}"

const page = (title: string, body: string, status = 200): Response => {
  const nonce = crypto.randomUUID()
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Cognito hosted UI (emulator)</title><style nonce="${nonce}">${style}</style></head><body><main>${body}<p>Mockingbird Cognito emulator. Test accounts only.</p></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        // No form-action: the picker's POST answers with a redirect to the app's callback URL.
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  )
}

const email = (user: CognitoUser) => user.attributes.find((a) => a.Name === "email")?.Value

/** The account picker that stands in for the provider's (or Cognito's) sign-in page. */
export const pickerPage = (
  base: string,
  transaction: string,
  provider: string,
  users: CognitoUser[],
): Response => {
  const action = escapeHtml(`${base}/oauth2/idpresponse`)
  const hidden = `<input type="hidden" name="transaction" value="${escapeHtml(transaction)}">`
  const accounts = users
    .map(
      (user) =>
        `<form method="post" action="${action}">${hidden}<button class="account" name="username" value="${escapeHtml(user.username)}" data-testid="cognito-hosted-account" data-username="${escapeHtml(user.username)}"><strong>${escapeHtml(user.username)}</strong>${email(user) ? `<small>${escapeHtml(email(user) as string)}</small>` : ""}</button></form>`,
    )
    .join("")
  const heading =
    provider === "COGNITO" ? "Sign in" : `Continue with ${escapeHtml(provider)} (emulated)`
  return page(
    "Choose an account",
    `<h1>${heading}</h1><p>Choose a user-pool account to sign in as.</p>${accounts || "<p>No users in this pool. Seed one with POST /__admin/users.</p>"}<form method="post" action="${action}">${hidden}<button class="cancel" name="action" value="cancel" data-testid="cognito-hosted-cancel">Cancel</button></form>`,
  )
}

/** Cognito's hosted-UI error page (`/error?error=redirect_mismatch&client_id=…`). */
export const errorPage = (error: string, description = ""): Response =>
  page(
    "Error",
    `<h1>An error was encountered with the requested page.</h1><p data-testid="cognito-hosted-error">${escapeHtml(error)}${description ? `: ${escapeHtml(description)}` : ""}</p>`,
    400,
  )

/** `redirect_uri` with OAuth parameters appended to its query, keeping existing ones. */
export const redirectTo = (redirectUri: string, params: Record<string, string | undefined>) => {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value)
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), "cache-control": "no-store" },
  })
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
/** RFC 7636 S256: BASE64URL(SHA256(code_verifier)). Cognito supports only S256. */
export const s256 = async (verifier: string) =>
  base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  )

/** client_secret_basic credentials, or undefined when absent or malformed. */
export const basicCredentials = (header: string | null) => {
  if (!header?.toLowerCase().startsWith("basic ")) return undefined
  try {
    const decoded = atob(header.slice(6).trim())
    const split = decoded.indexOf(":")
    if (split < 0) return undefined
    return {
      id: decodeURIComponent(decoded.slice(0, split)),
      secret: decodeURIComponent(decoded.slice(split + 1)),
    }
  } catch {
    return undefined
  }
}

/** The token endpoint answers `Access-Control-Allow-Origin: *` (token-endpoint docs). */
export const TOKEN_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-max-age": "600",
}
export const tokenJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      ...TOKEN_CORS,
    },
  })
export const S256_ONLY = ["S256"]
