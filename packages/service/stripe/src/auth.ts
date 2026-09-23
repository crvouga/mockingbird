export type ApiKey = { raw: string; publishable: boolean }

const decodeBasic = (value: string) => {
  try {
    return atob(value).split(":")[0] ?? ""
  } catch {
    return ""
  }
}

/** Bearer, HTTP Basic (`sk_test_:`), or the `key` query Stripe.js appends. */
export const readApiKey = (
  request: Request,
  query: Record<string, unknown>,
): ApiKey | undefined => {
  const header = request.headers.get("authorization")
  let raw: string | undefined
  if (header) {
    const bearer = /^Bearer\s+(\S+)/i.exec(header)
    const basic = /^Basic\s+(\S+)/i.exec(header)
    if (bearer?.[1]) raw = bearer[1]
    else if (basic?.[1]) raw = decodeBasic(basic[1])
  }
  if ((raw === undefined || raw === "") && typeof query.key === "string" && query.key !== "")
    raw = query.key
  if (raw === undefined || raw === "") return undefined
  return { raw, publishable: raw.startsWith("pk_") }
}

const PUBLISHABLE: Array<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/v1\/tokens$/ },
  { method: "GET", path: /^\/v1\/tokens\/[^/]+$/ },
  { method: "POST", path: /^\/v1\/sources$/ },
  { method: "POST", path: /^\/v1\/payment_methods$/ },
  { method: "GET", path: /^\/v1\/elements\/sessions$/ },
  { method: "POST", path: /^\/v1\/elements\/sessions$/ },
  { method: "POST", path: /^\/v1\/confirmation_tokens$/ },
  { method: "GET", path: /^\/v1\/confirmation_tokens\/[^/]+$/ },
  { method: "GET", path: /^\/v1\/payment_intents\/[^/]+$/ },
  { method: "POST", path: /^\/v1\/payment_intents\/[^/]+\/confirm$/ },
  { method: "GET", path: /^\/v1\/setup_intents\/[^/]+$/ },
  { method: "POST", path: /^\/v1\/setup_intents\/[^/]+\/confirm$/ },
]

/** Publishable keys may only call the client surfaces Stripe.js and mobile SDKs use. */
export const publishableAllowed = (request: Request) => {
  const path = new URL(request.url).pathname
  return PUBLISHABLE.some((rule) => rule.method === request.method && rule.path.test(path))
}

export const PUBLISHABLE_KEY_MESSAGE =
  "This API call cannot be made with a publishable API key. Please use a secret API key. You can find a list of your API keys at https://dashboard.stripe.com/account/apikeys."

/** Drop transport params Stripe.js adds so they are not rejected as unknown. */
export const stripTransportParams = (query: Record<string, unknown>) => {
  delete query.key
  delete query._stripe_version
  delete query._stripe_account
}
