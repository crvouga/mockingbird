import type { Provider } from "./state.js"

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  )
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:1rem/1.6 system-ui;margin:0;padding:2rem;background:#f5f5f5;color:#18181b}main{max-width:36rem;margin:auto;background:white;padding:2rem;border-radius:1rem}a,button{font:inherit}li{margin:.8rem 0}button{padding:.6rem 1rem;margin:.3rem}small{color:#555}</style><main><small>Mockingbird · Open Wearables preview</small><h1>${escapeHtml(title)}</h1>${body}</main></html>`
export const pairingPage = (
  providers: readonly Provider[],
  userId: string,
  redirectUrl = "",
  prefix = "",
) =>
  page(
    "Connect a wearable",
    `<p>Choose a provider to simulate a connection. No real account is accessed.</p><ul>${providers.map((provider) => `<li><a href="${escapeHtml(`${prefix}/users/${encodeURIComponent(userId)}/pair/${encodeURIComponent(provider.provider)}${redirectUrl ? `?redirect_url=${encodeURIComponent(redirectUrl)}` : ""}`)}">${escapeHtml(provider.name)}</a></li>`).join("")}</ul>${providers.length ? "" : "<p>No cloud providers are enabled.</p>"}`,
  )
export const consentPage = (provider: string, action: string) =>
  page(
    `Connect ${provider}`,
    `<p>Allow this preview to create a simulated wearable connection?</p><form method="post" action="${escapeHtml(action)}"><button name="decision" value="allow">Allow connection</button><button name="decision" value="deny">Cancel</button></form>`,
  )
export const completionPage = (allowed: boolean) =>
  page(
    allowed ? "Connected" : "Connection cancelled",
    `<p>${allowed ? "The simulated connection is ready. You can return to the app." : "No connection was created."}</p>`,
  )
export const html = (body: string) =>
  new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    },
  })
