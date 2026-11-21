/** `value` without trailing slashes, in linear time (a `/\/+$/` regex backtracks on long runs). */
const withoutTrailingSlashes = (value: string): string => {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}
/**
 * Sandbox proxy: a Fetch handler that relays an emulator's forwarded requests to a vendor's real
 * sandbox (test) account and attaches the credentials there, so secrets never reach the browser.
 *
 * Portable: Fetch API only. Runs in Cloudflare Workers, Bun, Node 18+ and Deno.
 */

/** Header carrying the per-viewer access key the proxy checks against `SANDBOX_PROXY_TOKEN`. */
export const SANDBOX_KEY_HEADER = "x-mockingbird-sandbox-key"

export type SandboxEnv = Record<string, string | undefined>

/** How one vendor is reached and which secrets it needs. */
export type SandboxProvider = {
  /** Path segment the proxy serves it under, e.g. "stripe". */
  id: string
  /** Display name, e.g. "Stripe". */
  label: string
  /** Env names that must all be set, e.g. ["STRIPE_SECRET_KEY"]. */
  secrets: readonly string[]
  /**
   * Env names among `secrets` that identify an account rather than authenticate it (a Twilio
   * Account SID, an FCM project id). They are never redacted from vendor responses, where they
   * legitimately appear; every other secret is.
   */
  identifiers?: readonly string[]
  /** Methods the proxy relays; any other is refused with 501. Default: every method. */
  methods?: readonly string[]
  /** Throw (message is shown to the user) when a present secret is not a sandbox credential. */
  check?(env: SandboxEnv): void
  /** Map the incoming path (after /<id>) to the real vendor URL, or undefined to refuse (501). */
  target(path: string, search: string): URL | undefined
  /** Attach credentials (and any id rewrites) to the outgoing request. */
  authorize(request: Request, env: SandboxEnv): Request | Promise<Request>
}

export type SandboxProxyOptions = {
  providers: readonly SandboxProvider[]
  /** Secrets source: a Worker's env, process.env, Bun.env. Read per request. */
  env: SandboxEnv | ((request: Request) => SandboxEnv)
  /** Env name of the access key callers must send in SANDBOX_KEY_HEADER. Default "SANDBOX_PROXY_TOKEN". */
  accessKey?: string
  /** Path prefix the handler is mounted under. Default "" ; the lab uses "/__sandbox". */
  basePath?: string
  /** Origins allowed for CORS (exact strings or RegExp). Default: none (same-origin only). */
  allowOrigins?: readonly (string | RegExp)[]
  /** Outgoing fetch. Default globalThis.fetch. Injected in tests. */
  fetch?: (request: Request) => Promise<Response>
}

export type SandboxAccess = "granted" | "denied" | "disabled"

export type SandboxManifest = {
  access: SandboxAccess
  providers: {
    id: string
    label: string
    configured: boolean
    missing: string[]
    error?: string
  }[]
}

// ---------------------------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------------------------

/** Build a URL on a fixed origin; the path can never move the request to another host. */
const on = (origin: string, path: string, search: string): URL => {
  const url = new URL(origin)
  url.pathname = path.startsWith("/") ? path : `/${path}`
  url.search = search
  return url
}

/** The same request at another URL, body still streamed. */
const withUrl = (request: Request, url: URL | string): Request =>
  new Request(url, {
    method: request.method,
    headers: request.headers,
    redirect: "manual",
    signal: request.signal,
    ...(request.body ? { body: request.body, duplex: "half" } : {}),
  } as RequestInit)

const missingSecrets = (provider: SandboxProvider, env: SandboxEnv) =>
  provider.secrets.filter((name) => !env[name])

const startsWithAny = (value: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => value.startsWith(prefix))

const basic = (user: string, password: string) => {
  const bytes = new TextEncoder().encode(`${user}:${password}`)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

const bearer = (request: Request, token: string) => {
  request.headers.set("authorization", `Bearer ${token}`)
  return request
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

const STRIPE_TEST_PREFIXES = ["sk_test_", "rk_test_"]
const JUNCTION_SANDBOX_PREFIXES = ["sk_us_", "sk_eu_"]

const twilioHost = (path: string): string | undefined => {
  if (/^\/2010-04-01(?:\/|$)/.test(path)) return "https://api.twilio.com"
  if (/^\/v2\/(?:Services|Attempts|Forms|SafeList)(?:\/|$)/.test(path))
    return "https://verify.twilio.com"
  if (/^\/v[12]\/PhoneNumbers(?:\/|$)/.test(path)) return "https://lookups.twilio.com"
  if (/^\/v1\/Services(?:\/|$)/.test(path)) return "https://messaging.twilio.com"
  return undefined
}

const FCM_SEND = /^\/v1\/projects\/[^/]+\/messages:send$/

/** The vendors the lab knows how to reach. Pass the ones you want to `createSandboxProxy`. */
export const sandboxProviders = {
  stripe: {
    id: "stripe",
    label: "Stripe",
    secrets: ["STRIPE_SECRET_KEY"],
    check: (env) => {
      const key = env.STRIPE_SECRET_KEY ?? ""
      if (!startsWithAny(key, STRIPE_TEST_PREFIXES))
        throw new Error(
          "STRIPE_SECRET_KEY is not a test-mode key (expected sk_test_ or rk_test_); sandbox mode refuses live keys",
        )
    },
    target: (path, search) =>
      /^\/v1\//.test(path) ? on("https://api.stripe.com", path, search) : undefined,
    authorize: (request, env) => bearer(request, env.STRIPE_SECRET_KEY ?? ""),
  },
  junction: {
    id: "junction",
    label: "Junction",
    secrets: ["JUNCTION_API_KEY"],
    check: (env) => {
      const key = env.JUNCTION_API_KEY ?? ""
      if (!startsWithAny(key, JUNCTION_SANDBOX_PREFIXES))
        throw new Error(
          "JUNCTION_API_KEY is not a sandbox key (expected sk_us_ or sk_eu_); sandbox mode refuses production keys",
        )
    },
    target: (path, search) =>
      /^\/v\d+\//.test(path) ? on("https://api.sandbox.tryvital.io", path, search) : undefined,
    authorize: (request, env) => {
      const key = env.JUNCTION_API_KEY ?? ""
      // EU sandbox keys live on the EU sandbox host.
      let out = request
      if (key.startsWith("sk_eu_")) {
        const url = new URL(request.url)
        url.hostname = "api.sandbox.eu.tryvital.io"
        out = withUrl(request, url)
      }
      out.headers.set("x-vital-api-key", key)
      return out
    },
  },
  resend: {
    id: "resend",
    label: "Resend",
    secrets: ["RESEND_API_KEY"],
    target: (path, search) => on("https://api.resend.com", path, search),
    authorize: (request, env) => bearer(request, env.RESEND_API_KEY ?? ""),
  },
  slack: {
    id: "slack",
    label: "Slack",
    secrets: ["SLACK_BOT_TOKEN"],
    target: (path, search) =>
      /^\/api\//.test(path) ? on("https://slack.com", path, search) : undefined,
    authorize: (request, env) => bearer(request, env.SLACK_BOT_TOKEN ?? ""),
  },
  twilio: {
    id: "twilio",
    label: "Twilio",
    secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    identifiers: ["TWILIO_ACCOUNT_SID"],
    target: (path, search) => {
      const host = twilioHost(path)
      return host ? on(host, path, search) : undefined
    },
    authorize: (request, env) => {
      const sid = env.TWILIO_ACCOUNT_SID ?? ""
      const url = new URL(request.url)
      const rewritten = url.pathname.replace(
        /\/Accounts\/[^/.]+(?=[/.]|$)/,
        `/Accounts/${encodeURIComponent(sid)}`,
      )
      let out = request
      if (rewritten !== url.pathname) {
        url.pathname = rewritten
        out = withUrl(request, url)
      }
      out.headers.set("authorization", basic(sid, env.TWILIO_AUTH_TOKEN ?? ""))
      return out
    },
  },
  fcm: {
    id: "fcm",
    label: "Firebase Cloud Messaging",
    secrets: ["FCM_ACCESS_TOKEN", "FCM_PROJECT_ID"],
    identifiers: ["FCM_PROJECT_ID"],
    methods: ["POST"],
    target: (path, search) =>
      FCM_SEND.test(path) ? on("https://fcm.googleapis.com", path, search) : undefined,
    authorize: (request, env) => {
      const url = new URL(request.url)
      url.pathname = url.pathname.replace(
        /^\/v1\/projects\/[^/]+\//,
        `/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID ?? "")}/`,
      )
      return bearer(withUrl(request, url), env.FCM_ACCESS_TOKEN ?? "")
    },
  },
} satisfies Record<string, SandboxProvider>

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

/** Request headers never sent on to a vendor. */
const DROP_REQUEST = new Set([
  "host",
  "cookie",
  "authorization",
  "forwarded",
  "origin",
  "referer",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "proxy-authorization",
  "x-real-ip",
  "true-client-ip",
])
const DROP_REQUEST_PREFIX = ["x-mockingbird-", "cf-", "x-forwarded-"]

/** Response headers never returned to the caller (the body is already decoded by fetch). */
const DROP_RESPONSE = new Set([
  "set-cookie",
  "set-cookie2",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "alt-svc",
])

const NULL_BODY = new Set([101, 204, 205, 304])
const TEXT_TYPE = /^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|xml|x-www-form-urlencoded))/i

/** Constant-time string comparison (length is compared without an early exit). */
export const safeEqual = (a: string, b: string): boolean => {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  const length = Math.max(left.length, right.length)
  let diff = left.length ^ right.length
  for (let index = 0; index < length; index++) diff |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return diff === 0
}

const matchesOrigin = (origin: string, allow: readonly (string | RegExp)[]) =>
  allow.some((entry) => (typeof entry === "string" ? entry === origin : entry.test(origin)))

/**
 * The sandbox proxy's Fetch handler. `GET <basePath>/` is the manifest; `<basePath>/<id>/...`
 * relays to that provider's sandbox. Fails closed: without the access-key env var every relay
 * answers 503, and a caller without the right key gets 401.
 */
export const createSandboxProxy = (
  options: SandboxProxyOptions,
): ((request: Request) => Promise<Response>) => {
  const accessKeyName = options.accessKey ?? "SANDBOX_PROXY_TOKEN"
  const basePath = withoutTrailingSlashes(options.basePath ?? "")
  const allowOrigins = options.allowOrigins ?? []
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request))
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]))
  if (providers.size !== options.providers.length)
    throw new Error("sandbox providers must have distinct ids")

  return async (request) => {
    const env = typeof options.env === "function" ? options.env(request) : options.env
    const origin = request.headers.get("origin")
    const corsOrigin = origin && matchesOrigin(origin, allowOrigins) ? origin : undefined

    /** Every value a response must never contain. */
    const secretValues = (credentialsOnly: boolean) => {
      const values = new Set<string>()
      const accessValue = env[accessKeyName]
      if (accessValue) values.add(accessValue)
      for (const provider of options.providers)
        for (const name of provider.secrets) {
          if (credentialsOnly && provider.identifiers?.includes(name)) continue
          const value = env[name]
          if (value && value.length >= 4) values.add(value)
        }
      return [...values].sort((a, b) => b.length - a.length)
    }
    const redact = (text: string, credentialsOnly = false) => {
      let out = text
      for (const value of secretValues(credentialsOnly)) out = out.split(value).join("[redacted]")
      return out
    }

    const decorate = (response: Response): Response => {
      const headers = new Headers(response.headers)
      if (corsOrigin) {
        headers.set("access-control-allow-origin", corsOrigin)
        const exposed = [...headers.keys()].filter((name) => !name.startsWith("access-control-"))
        if (exposed.length > 0) headers.set("access-control-expose-headers", exposed.join(", "))
      }
      const vary = headers.get("vary")
      if (!vary) headers.set("vary", "Origin")
      else if (!/\borigin\b/i.test(vary)) headers.set("vary", `${vary}, Origin`)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }
    const fail = (status: number, code: string, message: string) =>
      decorate(
        Response.json(
          { error: { code, message: redact(message) } },
          { status, headers: { "cache-control": "no-store" } },
        ),
      )

    const url = new URL(request.url)
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
      return fail(404, "not_found", "Not a sandbox proxy path")
    const rest = url.pathname.slice(basePath.length)

    if (request.method === "OPTIONS") {
      const headers = new Headers({ vary: "Origin" })
      if (corsOrigin) {
        const requested = (request.headers.get("access-control-request-headers") ?? "")
          .split(",")
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name && !DROP_REQUEST.has(name))
        const allowed = new Set([SANDBOX_KEY_HEADER, "content-type", ...requested])
        headers.set("access-control-allow-origin", corsOrigin)
        headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE")
        headers.set("access-control-allow-headers", [...allowed].join(", "))
        headers.set("access-control-max-age", "600")
      }
      return new Response(null, { status: 204, headers })
    }

    const expected = env[accessKeyName]
    const presented = request.headers.get(SANDBOX_KEY_HEADER) ?? ""
    const access: SandboxAccess = !expected
      ? "disabled"
      : presented && safeEqual(presented, expected)
        ? "granted"
        : "denied"

    if (rest === "" || rest === "/") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return fail(405, "method_not_allowed", "The manifest only answers GET")
      const manifest: SandboxManifest = {
        access,
        providers: options.providers.map((provider) => {
          // Only a caller with the key learns which vendors are configured.
          if (access !== "granted")
            return { id: provider.id, label: provider.label, configured: false, missing: [] }
          const missing = missingSecrets(provider, env)
          let error: string | undefined
          if (missing.length === 0 && provider.check) {
            try {
              provider.check(env)
            } catch (caught) {
              error = redact(caught instanceof Error ? caught.message : String(caught))
            }
          }
          return {
            id: provider.id,
            label: provider.label,
            configured: missing.length === 0 && error === undefined,
            missing,
            ...(error !== undefined ? { error } : {}),
          }
        }),
      }
      return decorate(
        Response.json(manifest, { headers: { "cache-control": "no-store" } }) as Response,
      )
    }

    if (access === "disabled")
      return fail(
        503,
        "sandbox_disabled",
        `The proxy has no ${accessKeyName}, so sandbox mode is off`,
      )
    if (access === "denied")
      return fail(401, "access_denied", `Send a valid access key in ${SANDBOX_KEY_HEADER}`)

    const match = /^\/([^/]+)(\/.*)?$/.exec(rest)
    const provider = match ? providers.get(decodeURIComponent(match[1] ?? "")) : undefined
    if (!match || !provider) return fail(404, "unknown_provider", "No such sandbox provider")
    const path = match[2] ?? "/"

    const missing = missingSecrets(provider, env)
    if (missing.length > 0)
      return fail(503, "not_configured", `Missing ${missing.join(", ")} on the proxy`)
    try {
      provider.check?.(env)
    } catch (caught) {
      return fail(
        503,
        "refused_credential",
        caught instanceof Error ? caught.message : String(caught),
      )
    }

    const target =
      provider.methods?.includes(request.method.toUpperCase()) === false
        ? undefined
        : provider.target(path, url.search)
    if (!target)
      return fail(
        501,
        "unsupported_operation",
        `${provider.label} sandbox does not relay ${request.method} ${path}`,
      )

    const headers = new Headers()
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase()
      if (DROP_REQUEST.has(lower) || DROP_REQUEST_PREFIX.some((prefix) => lower.startsWith(prefix)))
        continue
      headers.append(name, value)
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null
    let outgoing = new Request(target, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: request.signal,
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
    } as RequestInit)

    let response: Response
    try {
      outgoing = await provider.authorize(outgoing, env)
      response = await send(outgoing)
    } catch (caught) {
      return fail(
        502,
        "upstream_unreachable",
        `${provider.label} sandbox could not be reached: ${caught instanceof Error ? caught.message : String(caught)}`,
      )
    }

    const responseHeaders = new Headers()
    for (const [name, value] of response.headers) {
      if (DROP_RESPONSE.has(name.toLowerCase())) continue
      responseHeaders.append(name, value)
    }
    let body: BodyInit | null = NULL_BODY.has(response.status) ? null : response.body
    if (body !== null && TEXT_TYPE.test(response.headers.get("content-type") ?? ""))
      body = redact(await response.text(), true)
    return decorate(
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      }),
    )
  }
}

/** A Cloudflare Worker: `export default sandboxProxyWorker({ providers, basePath })`. */
export const sandboxProxyWorker = (
  options: Omit<SandboxProxyOptions, "env">,
): { fetch(request: Request, env: SandboxEnv): Promise<Response> } => ({
  fetch: (request, env) => createSandboxProxy({ ...options, env })(request),
})
