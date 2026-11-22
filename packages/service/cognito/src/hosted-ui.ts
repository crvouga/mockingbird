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

/**
 * Every inline `<style>` and `<script>` carries `nonce`. Inline `style` attributes (the shared
 * components size the mark with one) and the `data:` favicon are the only other sources a page
 * uses. No form-action: the picker's POST answers with a redirect to the app's callback URL.
 */
const policy = (nonce: string) =>
  `default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; frame-ancestors 'none'`

/** The page's HTML (React, prebuilt in `#ui/server`, loaded only when a page is served). */
const page = async (
  render: (ui: typeof import("#ui/server"), nonce: string) => string,
  status = 200,
): Promise<Response> => {
  const nonce = crypto.randomUUID()
  const ui = await import("#ui/server")
  return new Response(render(ui, nonce), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": policy(nonce),
    },
  })
}

const email = (user: CognitoUser) => user.attributes.find((a) => a.Name === "email")?.Value

/** The account picker that stands in for the provider's (or Cognito's) sign-in page. */
export const pickerPage = (
  base: string,
  transaction: string,
  provider: string,
  users: CognitoUser[],
): Promise<Response> =>
  page((ui, nonce) =>
    ui.pickerPage({
      action: `${base}/oauth2/idpresponse`,
      transaction,
      provider,
      accounts: users.map((user) => ({ username: user.username, email: email(user) })),
      nonce,
    }),
  )

/** Cognito's hosted-UI error page (`/error?error=redirect_mismatch&client_id=…`). */
export const errorPage = (error: string, description = ""): Promise<Response> =>
  page((ui, nonce) => ui.errorPage(error, description, nonce), 400)

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
