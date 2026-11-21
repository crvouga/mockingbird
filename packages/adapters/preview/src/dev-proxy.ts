/**
 * Dev proxy: a Fetch handler that relays an emulator's forwarded requests to a real
 * **non-production** resource (Stripe test mode, Junction's sandbox, a dev Resend account, a
 * self-hosted dev instance) and attaches the credentials there, so secrets never reach the browser.
 *
 * Default deny: a provider is reachable only when every env value it reads matches an anchored
 * allow-list pattern the consumer writes in code (`allow`), and none matches a known production
 * format the provider declares (`deny`).
 *
 * Trust: the proxy is mounted on the dev app's own origin and trusts that app. It answers only
 * same-origin browser requests (`Sec-Fetch-Site: same-origin`, and an `Origin`, when sent, equal to
 * its own or listed in `allowOrigins`). Credentials are attached here and never reach the client.
 *
 * Portable: Fetch API only. Runs in Cloudflare Workers, Bun, Node 18+ and Deno.
 */

export type DevEnv = Record<string, string | undefined>

/** How one vendor is reached and which secrets it needs. */
export type DevProvider = {
  /** Path segment the proxy serves it under, e.g. "stripe". */
  id: string
  /** Display name, e.g. "Stripe". */
  label: string
  /** Env names that must all be set, e.g. ["STRIPE_SECRET_KEY"]. Each needs an `allow` entry. */
  secrets: readonly string[]
  /**
   * Env names among `secrets` that identify an account rather than authenticate it (a Twilio
   * Account SID, an FCM project id). They are allow-checked like every secret, and never redacted
   * from vendor responses, where they legitimately appear; every other secret is.
   */
  identifiers?: readonly string[]
  /**
   * Known **production** formats per env name, refused even when `allow` matches
   * (Stripe: `^(sk|rk)_live_`).
   */
  deny?: Readonly<Record<string, RegExp>>
  /**
   * Default origin of the non-prod-capable vendor host, e.g. "https://api.stripe.com". An env value
   * `<ID>_BASE_URL` (see `devBaseUrlName`) replaces it, but only when `allow` has a matching entry
   * for that name.
   */
  baseUrl: string
  /** Methods the proxy relays; any other is refused with 501. Default: every method. */
  methods?: readonly string[]
  /**
   * Map the incoming path (after /<id>) to the real URL, or undefined to refuse (501). `base` is
   * `baseUrl` or the allow-listed override; build the URL with it.
   */
  target(path: string, search: string, base: string): URL | undefined
  /** Attach credentials (and any id rewrites) to the outgoing request. */
  authorize(request: Request, env: DevEnv): Request | Promise<Request>
}

export type DevProxyOptions = {
  providers: readonly DevProvider[]
  /** Secrets source: a Worker's env, process.env, Bun.env. Read per request. */
  env: DevEnv | ((request: Request) => DevEnv)
  /**
   * REQUIRED. For every env value a provider reads (its `secrets` and `identifiers`, and any
   * `<ID>_BASE_URL` override), the pattern it must match. Missing entry => that provider is
   * unavailable. A pattern that is not anchored (source must start with `^` and end with `$`)
   * throws at createDevProxy() time. Patterns live in code so they are reviewed, never in env.
   */
  allow: Readonly<Record<string, RegExp>>
  /** Path prefix the handler is mounted under. Default "" ; the lab uses "/__dev". */
  basePath?: string
  /**
   * Other origins trusted like the proxy's own, with CORS (exact strings or RegExp). Default: none
   * (same-origin only). Use it when the page is served from another origin, e.g. a dev server.
   */
  allowOrigins?: readonly (string | RegExp)[]
  /**
   * Also accept requests without `Sec-Fetch-Site` (non-browser clients: tests, server-side
   * callers). Default false: such requests are refused like cross-site ones.
   */
  trustNonBrowser?: boolean
  /** Outgoing fetch. Default globalThis.fetch. Injected in tests. */
  fetch?: (request: Request) => Promise<Response>
}

export type DevManifest = {
  providers: {
    id: string
    label: string
    configured: boolean
    missing: string[]
    /** Why the safety checks refuse this provider. Names env vars only, never their values. */
    blocked?: string
  }[]
}

/**
 * Vendor credential formats that by themselves prove a non-production resource. Spread them into
 * `allow`. Vendors whose formats cannot tell prod from dev (Resend, Slack, Twilio, FCM) have no
 * entry: pin an identifier instead (`TWILIO_ACCOUNT_SID: /^AC0123…$/`, `FCM_PROJECT_ID:
 * /^my-app-dev$/`) or write a pattern of your own.
 */
export const NON_PROD_PATTERNS = {
  STRIPE_SECRET_KEY: /^(sk|rk)_test_[A-Za-z0-9]+$/,
  JUNCTION_API_KEY: /^sk_(us|eu)_[A-Za-z0-9_-]+$/,
} as const satisfies Record<string, RegExp>

/** The env name that overrides a provider's base URL: `resend` -> `RESEND_BASE_URL`. */
export const devBaseUrlName = (id: string): string =>
  `${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`

// ---------------------------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------------------------

/**
 * Build a URL on a fixed base (origin plus optional path prefix); the path can never move the
 * request to another host.
 */
const on = (base: string, path: string, search: string): URL => {
  const url = new URL(base)
  const prefix = url.pathname.replace(/\/+$/, "")
  url.pathname = `${prefix}${path.startsWith("/") ? path : `/${path}`}`
  url.search = search
  url.hash = ""
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

/** `test` without carrying `lastIndex` over from an earlier call (g / y flags). */
const matches = (pattern: RegExp, value: string) => {
  pattern.lastIndex = 0
  return pattern.test(value)
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

const TWILIO_API = "https://api.twilio.com"

/**
 * Twilio spreads its API over several hosts. A `TWILIO_BASE_URL` override replaces only the
 * default API host (`/2010-04-01/*`); Verify, Lookups and Messaging keep their vendor hosts.
 */
const twilioHost = (path: string, base: string): string | undefined => {
  if (/^\/2010-04-01(?:\/|$)/.test(path)) return base
  if (/^\/v2\/(?:Services|Attempts|Forms|SafeList)(?:\/|$)/.test(path))
    return "https://verify.twilio.com"
  if (/^\/v[12]\/PhoneNumbers(?:\/|$)/.test(path)) return "https://lookups.twilio.com"
  if (/^\/v1\/Services(?:\/|$)/.test(path)) return "https://messaging.twilio.com"
  return undefined
}

const FCM_SEND = /^\/v1\/projects\/[^/]+\/messages:send$/
const JUNCTION_US = "https://api.sandbox.tryvital.io"
const JUNCTION_EU_HOST = "api.sandbox.eu.tryvital.io"

/** The vendors the lab knows how to reach. Pass the ones you want to `createDevProxy`. */
export const devProviders = {
  stripe: {
    id: "stripe",
    label: "Stripe",
    secrets: ["STRIPE_SECRET_KEY"],
    deny: { STRIPE_SECRET_KEY: /^(sk|rk)_live_/ },
    baseUrl: "https://api.stripe.com",
    target: (path, search, base) => (/^\/v1\//.test(path) ? on(base, path, search) : undefined),
    authorize: (request, env) => bearer(request, env.STRIPE_SECRET_KEY ?? ""),
  },
  junction: {
    id: "junction",
    label: "Junction",
    secrets: ["JUNCTION_API_KEY"],
    baseUrl: JUNCTION_US,
    target: (path, search, base) => (/^\/v\d+\//.test(path) ? on(base, path, search) : undefined),
    authorize: (request, env) => {
      const key = env.JUNCTION_API_KEY ?? ""
      // EU keys live on Junction's EU sandbox host (unless a JUNCTION_BASE_URL override is used).
      let out = request
      const url = new URL(request.url)
      if (key.startsWith("sk_eu_") && url.origin === JUNCTION_US) {
        url.hostname = JUNCTION_EU_HOST
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
    baseUrl: "https://api.resend.com",
    target: (path, search, base) => on(base, path, search),
    authorize: (request, env) => bearer(request, env.RESEND_API_KEY ?? ""),
  },
  slack: {
    id: "slack",
    label: "Slack",
    secrets: ["SLACK_BOT_TOKEN"],
    baseUrl: "https://slack.com",
    target: (path, search, base) => (/^\/api\//.test(path) ? on(base, path, search) : undefined),
    authorize: (request, env) => bearer(request, env.SLACK_BOT_TOKEN ?? ""),
  },
  twilio: {
    id: "twilio",
    label: "Twilio",
    secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    identifiers: ["TWILIO_ACCOUNT_SID"],
    baseUrl: TWILIO_API,
    target: (path, search, base) => {
      const host = twilioHost(path, base)
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
    baseUrl: "https://fcm.googleapis.com",
    target: (path, search, base) => (FCM_SEND.test(path) ? on(base, path, search) : undefined),
    authorize: (request, env) => {
      const url = new URL(request.url)
      url.pathname = url.pathname.replace(
        /\/v1\/projects\/[^/]+\//,
        `/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID ?? "")}/`,
      )
      return bearer(withUrl(request, url), env.FCM_ACCESS_TOKEN ?? "")
    },
  },
} satisfies Record<string, DevProvider>

// ---------------------------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------------------------

/** True when `source` ends with an unescaped `$`. */
const endsAnchored = (source: string) => {
  if (!source.endsWith("$")) return false
  let slashes = 0
  for (let index = source.length - 2; index >= 0 && source[index] === "\\"; index--) slashes++
  return slashes % 2 === 0
}

/**
 * Validate the allow map and compile each pattern as a full match (`^(?:…)$`), so a top-level
 * alternation such as `/^a|b$/` cannot match a substring.
 */
const compileAllow = (allow: DevProxyOptions["allow"] | undefined): Map<string, RegExp> => {
  if (!allow || typeof allow !== "object")
    throw new Error(
      "createDevProxy needs an `allow` map: an anchored pattern for every env value a provider reads",
    )
  const compiled = new Map<string, RegExp>()
  for (const [name, pattern] of Object.entries(allow)) {
    if (!(pattern instanceof RegExp)) throw new Error(`allow.${name} must be a RegExp`)
    if (!pattern.source.startsWith("^") || !endsAnchored(pattern.source))
      throw new Error(
        `allow.${name} must be anchored: its pattern has to start with ^ and end with $ (got /${pattern.source}/)`,
      )
    if (pattern.flags.includes("m"))
      throw new Error(`allow.${name} must not use the m flag; it lets ^ and $ match inside a value`)
    compiled.set(name, new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, "")))
  }
  return compiled
}

type ProviderStatus = { missing: string[]; blocked?: string; base: string }

/** An `https:` URL without credentials, query or fragment, normalized without a trailing slash. */
const parseBaseUrl = (value: string): string | undefined => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/** Default deny: every value the provider reads must be allow-listed and not a production format. */
const evaluate = (
  provider: DevProvider,
  env: DevEnv,
  allow: ReadonlyMap<string, RegExp>,
): ProviderStatus => {
  const missing = provider.secrets.filter((name) => !env[name])
  const check = (name: string): string | undefined => {
    const pattern = allow.get(name)
    if (!pattern) return `No allow-list pattern for ${name}`
    const value = env[name]
    if (!value) return undefined
    const deny = provider.deny?.[name]
    if (deny && matches(deny, value)) return `${name} is a production credential`
    if (!matches(pattern, value)) return `${name} does not match its allow-list pattern`
    return undefined
  }
  let blocked: string | undefined
  for (const name of provider.secrets) {
    blocked = check(name)
    if (blocked) break
  }
  let base = provider.baseUrl
  const baseName = devBaseUrlName(provider.id)
  const override = env[baseName]
  if (!blocked && override) {
    const pattern = allow.get(baseName)
    const parsed = parseBaseUrl(override)
    if (!pattern) blocked = `No allow-list pattern for ${baseName}`
    else if (!parsed) blocked = `${baseName} must be an https URL without query or credentials`
    else if (!matches(pattern, override))
      blocked = `${baseName} does not match its allow-list pattern`
    else base = parsed
  }
  return { missing, base, ...(blocked ? { blocked } : {}) }
}

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
const DROP_REQUEST_PREFIX = ["x-mockingbird-", "cf-", "x-forwarded-", "sec-fetch-", "sec-ch-"]

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

const matchesOrigin = (origin: string, allow: readonly (string | RegExp)[]) =>
  allow.some((entry) => (typeof entry === "string" ? entry === origin : entry.test(origin)))

/** Validate options once; the result answers one request against the env it is given. */
const buildHandler = (
  options: Omit<DevProxyOptions, "env">,
): ((request: Request, env: DevEnv) => Promise<Response>) => {
  const allow = compileAllow(options.allow)
  const basePath = (options.basePath ?? "").replace(/\/+$/, "")
  const allowOrigins = options.allowOrigins ?? []
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request))
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]))
  if (providers.size !== options.providers.length)
    throw new Error("dev providers must have distinct ids")

  return async (request, env) => {
    const origin = request.headers.get("origin")
    const corsOrigin = origin && matchesOrigin(origin, allowOrigins) ? origin : undefined

    /** Every value a response must never contain. */
    const secretValues = (credentialsOnly: boolean) => {
      const values = new Set<string>()
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
      return fail(404, "not_found", "Not a dev proxy path")
    const rest = url.pathname.slice(basePath.length)

    if (request.method === "OPTIONS") {
      const headers = new Headers({ vary: "Origin" })
      if (corsOrigin) {
        const requested = (request.headers.get("access-control-request-headers") ?? "")
          .split(",")
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name && !DROP_REQUEST.has(name))
        const allowed = new Set(["content-type", ...requested])
        headers.set("access-control-allow-origin", corsOrigin)
        headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE")
        headers.set("access-control-allow-headers", [...allowed].join(", "))
        headers.set("access-control-max-age", "600")
      }
      return new Response(null, { status: 204, headers })
    }

    // Same-origin trust: only the dev app's own pages (or an allowOrigins page) may use the proxy.
    const site = request.headers.get("sec-fetch-site")
    const listed = origin !== null && corsOrigin !== undefined
    if (origin !== null && origin !== url.origin && !listed)
      return fail(403, "cross_origin", "The dev proxy only answers its own origin")
    if (site === null ? !options.trustNonBrowser : site !== "same-origin" && !listed)
      return fail(403, "cross_origin", "The dev proxy only answers same-origin browser requests")

    if (rest === "" || rest === "/") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return fail(405, "method_not_allowed", "The manifest only answers GET")
      const manifest: DevManifest = {
        providers: options.providers.map((provider) => {
          const { missing, blocked } = evaluate(provider, env, allow)
          return {
            id: provider.id,
            label: provider.label,
            configured: missing.length === 0 && blocked === undefined,
            missing,
            ...(blocked !== undefined ? { blocked: redact(blocked) } : {}),
          }
        }),
      }
      return decorate(
        Response.json(manifest, { headers: { "cache-control": "no-store" } }) as Response,
      )
    }

    const match = /^\/([^/]+)(\/.*)?$/.exec(rest)
    const provider = match ? providers.get(decodeURIComponent(match[1] ?? "")) : undefined
    if (!match || !provider) return fail(404, "unknown_provider", "No such dev provider")
    const path = match[2] ?? "/"

    const status = evaluate(provider, env, allow)
    if (status.missing.length > 0)
      return fail(503, "not_configured", `Missing ${status.missing.join(", ")} on the proxy`)
    if (status.blocked) return fail(403, "not_allowed", status.blocked)

    const target =
      provider.methods?.includes(request.method.toUpperCase()) === false
        ? undefined
        : provider.target(path, url.search, status.base)
    if (!target)
      return fail(
        501,
        "unsupported_operation",
        `The ${provider.label} dev resource is not reached for ${request.method} ${path}`,
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
        `The ${provider.label} dev resource could not be reached: ${caught instanceof Error ? caught.message : String(caught)}`,
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

/**
 * The dev proxy's Fetch handler. `GET <basePath>/` is the manifest; `<basePath>/<id>/...` relays
 * to that provider's dev resource. Fails closed: a request that is not same-origin (see
 * `allowOrigins`, `trustNonBrowser`) answers 403 `cross_origin`, and a provider whose env values are
 * not all allow-listed (or match a production format) answers 403 `not_allowed`; neither sends
 * anything.
 * Throws when `allow` is missing or holds an unanchored pattern.
 */
export const createDevProxy = (
  options: DevProxyOptions,
): ((request: Request) => Promise<Response>) => {
  const handle = buildHandler(options)
  return (request) =>
    handle(request, typeof options.env === "function" ? options.env(request) : options.env)
}

/**
 * A Cloudflare Worker:
 * `export default devProxyWorker({ basePath: "/__dev", providers, allow })`.
 * Options are validated once, here; secrets are read from the Worker env per call.
 */
export const devProxyWorker = (
  options: Omit<DevProxyOptions, "env">,
): { fetch(request: Request, env: DevEnv): Promise<Response> } => {
  const handle = buildHandler(options)
  return { fetch: (request, env) => handle(request, env) }
}
