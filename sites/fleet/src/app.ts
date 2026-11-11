import { type Context, createRoutes, type Deps, hasRole, type Route, roleOf } from "./api.js"
import { type Auth, type Principal, readCookie, sessionCookieName } from "./auth.js"
import type { Config } from "./config.js"
import type { EmulatorSpec, Engine } from "./engine.js"
import {
  badRequest,
  errorResponse,
  forbidden,
  HttpError,
  notFound,
  unauthorized,
} from "./errors.js"
import { agentGuide } from "./guide.js"
import { randomString, safeEqual, sha256 } from "./ids.js"
import {
  effectiveLimits,
  type RateDecision,
  RateLimiter,
  rateHeaders,
  type UsageMeter,
} from "./limits.js"
import { openApiDocument, SCHEMAS, validate } from "./openapi.js"
import type { Database, Row } from "./store/schema.js"
import type { Telemetry } from "./telemetry.js"

export type AppConfig = Pick<
  Config,
  | "publicUrl"
  | "fleetUrl"
  | "oidc"
  | "devLogin"
  | "limits"
  | "orgsPerUser"
  | "operatorTokenHash"
  | "rateLimits"
  | "fleetMaxConcurrent"
  | "fleetRequestTimeoutMs"
  | "trustedProxyHops"
  | "corsOrigins"
>

export type AppDeps = {
  db: Database
  engine: Engine
  auth: Auth
  config: AppConfig
  telemetry: Telemetry
  meter: UsageMeter
  now?: () => number
  /** The built dashboard: return the file at `path`, or `undefined` when there is none. */
  asset?: (path: string) => Response | undefined | Promise<Response | undefined>
}

const MAX_JSON_BYTES = 1024 * 1024
const FLEET_CACHE_MS = 3000
const AUDIT_DAYS = 90
const DASHBOARD_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
}

type Compiled = Route & { pattern: RegExp; names: string[] }

export function createApp(input: AppDeps) {
  const { db, engine, auth, config, telemetry, meter } = input
  const now = input.now ?? Date.now
  const publicOrigin = new URL(config.publicUrl)
  const fleetOrigin = new URL(config.fleetUrl)
  /** One origin serves both the dashboard and fleets unless a separate `FLEET_URL` is set. */
  const sharedOrigin = publicOrigin.origin === fleetOrigin.origin
  const limiter = new RateLimiter(now)
  const inFlight = new Map<string, number>()
  let auditSequence = 0

  const fleets = new Map<string, { row: Row<"fleets">; org: Row<"orgs">; at: number }>()
  const fleetBySlug = async (slug: string, fresh = false) => {
    const cached = fleets.get(slug)
    if (!fresh && cached && now() - cached.at < FLEET_CACHE_MS) return cached
    const [row] = await db.find("fleets", { slug })
    const org = row && (await db.get("orgs", row.org_id))
    if (!row || !org) {
      fleets.delete(slug)
      return undefined
    }
    const entry = { row, org, at: now() }
    fleets.set(slug, entry)
    return entry
  }

  const deps: Deps = {
    db,
    engine,
    auth,
    config,
    meter,
    now,
    fleetChanged: (slug) => void fleets.delete(slug),
  }
  const routes: Compiled[] = createRoutes().map((route) => {
    const names: string[] = []
    const pattern = new RegExp(
      `^${route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
        names.push(name)
        return "([^/]+)"
      })}$`,
    )
    return { ...route, pattern, names }
  })
  const document = openApiDocument(routes, config.publicUrl)
  const guide = agentGuide(config, routes)

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } })

  /**
   * The address a request came from. Behind N trusted proxies the N-th entry from the right of
   * `X-Forwarded-For` is the one the outermost trusted proxy saw; anything further left is
   * whatever the client chose to send, and is ignored.
   */
  function clientAddress(request: Request, socketAddress: string | undefined): string {
    if (config.trustedProxyHops > 0) {
      const chain = (request.headers.get("x-forwarded-for") ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
      const entry = chain[chain.length - config.trustedProxyHops]
      if (entry) return entry
    }
    return socketAddress ?? "unknown"
  }

  const tooMany = (code: string, message: string, decision: RateDecision) =>
    new HttpError(429, code, message, undefined, rateHeaders(decision))
  const spend = (key: string, perMinute: number, code: string, message: string) => {
    const decision = limiter.take(key, perMinute)
    if (!decision.allowed) {
      telemetry.count("fleet.rate_limited", { limit: code })
      throw tooMany(code, `${message} Retry in ${decision.retryAfter} s.`, decision)
    }
    return decision
  }
  /** Too many rejected credentials or sign-in attempts from one address: stop checking them. */
  const guardAuth = (address: string) => {
    if (limiter.exhausted(`auth:${address}`, config.rateLimits.authPerMinute))
      spend(
        `auth:${address}`,
        config.rateLimits.authPerMinute,
        "auth_rate_limited",
        "Too many sign-in attempts or rejected credentials from this address.",
      )
  }
  const authFailed = (address: string) =>
    void limiter.take(`auth:${address}`, config.rateLimits.authPerMinute)

  async function readJson(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text()
    if (text.length > MAX_JSON_BYTES) throw new HttpError(413, "body_too_large", "Body too large")
    let parsed: unknown
    // A mockingbird.yaml can be sent as it is: `--data-binary @mockingbird.yaml`.
    const yaml = /\byaml\b/i.test(request.headers.get("content-type") ?? "")
    try {
      parsed = text === "" ? {} : yaml ? Bun.YAML.parse(text) : JSON.parse(text)
    } catch (error) {
      throw badRequest(
        yaml
          ? `The request body is not valid YAML: ${(error as Error).message}`
          : "The request body is not valid JSON",
      )
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw badRequest("The request body must be a JSON object")
    return parsed as Record<string, unknown>
  }

  /**
   * A browser session authorizes a state change only when the request provably came from the
   * dashboard: it carries a header a cross-site form cannot set, and its Origin, when present,
   * is ours. API keys are not ambient credentials and need neither.
   */
  function checkCsrf(request: Request, principal: Principal | undefined) {
    if (principal?.kind !== "user" || principal.via !== "session") return
    if (["GET", "HEAD"].includes(request.method)) return
    const origin = request.headers.get("origin")
    if (
      request.headers.get("x-mockingbird-csrf") !== "1" ||
      (origin && origin !== publicOrigin.origin)
    )
      throw forbidden("Missing x-mockingbird-csrf header")
  }

  const bearer = (request: Request) => {
    const header = request.headers.get("authorization")
    return header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined
  }

  const actorOf = (context: Context) =>
    context.operator
      ? "operator"
      : context.principal?.kind === "user"
        ? `user:${context.principal.user.id}:${context.principal.user.email ?? ""}`
        : context.principal
          ? `key:${context.principal.key.id}:${context.principal.key.name}`
          : "anonymous"

  async function api(request: Request, path: string, address: string): Promise<Response> {
    if (path === "/openapi.json") return json(document)
    if (!path.startsWith("/v1/")) throw notFound("Endpoint")
    const sub = path.slice(3)
    const candidates = routes.filter((route) => route.pattern.test(sub))
    const route = candidates.find((candidate) => candidate.method === request.method)
    if (!route) {
      if (candidates.length === 0) throw notFound("Endpoint")
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }
    const match = route.pattern.exec(sub) as RegExpExecArray
    const params = Object.fromEntries(
      route.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]),
    )

    let principal: Principal | undefined
    let operator = false
    const presented = bearer(request) ?? request.headers.get("x-mockingbird-api-key") ?? undefined
    if (presented !== undefined) guardAuth(address)
    try {
      if (route.auth === "operator") {
        if (!config.operatorTokenHash)
          throw new HttpError(
            404,
            "operator_api_disabled",
            "The operator API is off. Set OPERATOR_TOKEN (32+ characters) on the server to enable it.",
          )
        if (!presented || !safeEqual(sha256(presented), config.operatorTokenHash))
          throw unauthorized("This endpoint needs the operator token as a Bearer credential")
        operator = true
      } else {
        principal = await auth.authenticate(request)
        if (route.auth === "required" && !principal) throw unauthorized()
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 401 && presented !== undefined)
        authFailed(address)
      throw error
    }
    // One bucket per credential, so a noisy integration cannot starve the others; anonymous
    // callers share a bucket per address.
    const identity = operator
      ? "operator"
      : principal?.kind === "user"
        ? `user:${principal.user.id}`
        : principal
          ? `key:${principal.key.id}`
          : `addr:${address}`
    const decision = spend(
      `api:${identity}`,
      config.rateLimits.apiPerMinute,
      "rate_limited",
      "Too many API requests.",
    )
    checkCsrf(request, principal)
    let body: Record<string, unknown> = {}
    if (route.body) {
      body = await readJson(request)
      const problems = validate(SCHEMAS[route.body] ?? {}, body)
      if (problems.length > 0) throw badRequest(problems[0] ?? "Invalid body", problems)
    }
    const context: Context = {
      deps,
      principal,
      operator,
      params,
      body,
      request,
      operationId: route.operationId,
    }
    return telemetry.span(
      `api ${route.operationId}`,
      { "api.operation": route.operationId },
      async () => {
        const result = await route.handler(context)
        // Deleting an organization deletes its log too; an entry written afterwards would be orphaned.
        if (request.method !== "GET" && context.orgId && route.operationId !== "deleteOrg")
          await audit(context, route)
        return json(result, route.status ?? 200, rateHeaders(decision))
      },
    )
  }

  /** Record who changed what. A failed audit write is logged, never allowed to fail the change. */
  async function audit(context: Context, route: Route) {
    try {
      await db.insert("audit", {
        // Sortable: entries written in the same millisecond keep the order they happened in.
        id: `aud_${String(now()).padStart(15, "0")}${String(auditSequence++ % 1_000_000).padStart(6, "0")}${randomString(6)}`,
        org_id: context.orgId as string,
        actor: actorOf(context),
        action: route.operationId,
        target: Object.values(context.params).join("/") || (context.orgId as string),
        created_at: new Date(now()).toISOString(),
      })
      if (Math.random() < 0.01)
        await db.removeExpired(
          "audit",
          "created_at",
          new Date(now() - AUDIT_DAYS * 86_400_000).toISOString(),
        )
    } catch (error) {
      telemetry.log("error", "audit write failed", {
        action: route.operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** `/f/<fleet>/<emulator>/<vendor path>`: the URL an SDK is pointed at. */
  async function dataPlane(request: Request, url: URL, address: string): Promise<Response> {
    // Cheapest check first: one address hammering any fleets is stopped before any lookup.
    spend(
      `client:${address}`,
      config.rateLimits.clientPerMinute,
      "rate_limited",
      "Too many requests from this address.",
    )
    const [, , slug = "", name, ...rest] = url.pathname.split("/")
    let entry = await fleetBySlug(slug)
    // A cached fleet may predate the emulator being added.
    if (entry && name && !(entry.row.emulators as Record<string, unknown>)[name])
      entry = await fleetBySlug(slug, true)
    if (!entry) throw notFound("Fleet")
    const { row: fleet, org } = entry
    const emulators = fleet.emulators as Record<string, EmulatorSpec>
    const path = `/${rest.join("/")}`
    const admin = /^\/__admin(\/|$)/.test(path)

    if (org.suspended !== null)
      throw new HttpError(
        403,
        "org_suspended",
        `The organization that owns this fleet is suspended: ${org.suspended}`,
      )

    // Only this header: `Authorization` belongs to the vendor API being emulated, and a
    // dashboard session cookie must never authorize a request an emulator page could make.
    const presented = request.headers.get("x-mockingbird-api-key")
    let role: string | undefined
    if (presented !== null) {
      guardAuth(address)
      const principal = await auth
        .authenticate(new Request(request.url, { headers: { "x-mockingbird-api-key": presented } }))
        .catch((error) => {
          authFailed(address)
          throw error
        })
      role = principal && (await roleOf(db, principal, fleet.org_id, fleet.project_id))
      if (!role) throw forbidden("This API key has no access to this fleet")
    } else if (fleet.access === "key" || admin)
      throw unauthorized(
        admin
          ? "Emulator admin routes need an API key in x-mockingbird-api-key"
          : "This fleet needs an API key in x-mockingbird-api-key",
      )
    if (admin && !hasRole(role, "member")) throw forbidden()
    /** May reset, reseed, time-travel and inject faults: a member key, on any fleet. */
    const privileged = hasRole(role, "member")

    if (!name)
      return json({
        fleet: fleet.slug,
        emulators: Object.fromEntries(
          Object.entries(emulators).map(([key, spec]) => [
            key,
            {
              target: spec.target,
              durability: spec.durability,
              url: `${fleetOrigin.origin}/f/${slug}/${key}`,
            },
          ]),
        ),
      })
    const spec = emulators[name]
    if (!spec) throw notFound("Emulator")

    const limits = effectiveLimits(config.limits, org.limits)
    const own = (fleet.options as { requestsPerMinute?: number }).requestsPerMinute
    const perMinute =
      own && limits.fleetRequestsPerMinute > 0
        ? Math.min(own, limits.fleetRequestsPerMinute)
        : (own ?? limits.fleetRequestsPerMinute)
    const decision = spend(
      `fleet:${fleet.id}`,
      perMinute,
      "fleet_rate_limited",
      `This fleet accepts ${perMinute} requests per minute.`,
    )
    if (limits.requestsPerMonth > 0 && (await meter.month(org.id)) >= limits.requestsPerMonth)
      throw new HttpError(
        429,
        "quota_exceeded",
        `This organization has used its ${limits.requestsPerMonth} emulator requests for the month. The count resets on the 1st (UTC); the operator can raise requestsPerMonth.`,
        { limit: "requestsPerMonth", max: limits.requestsPerMonth },
      )
    const active = inFlight.get(fleet.id) ?? 0
    if (active >= config.fleetMaxConcurrent)
      throw new HttpError(
        429,
        "too_many_concurrent_requests",
        `This fleet already has ${active} requests in flight; retry shortly.`,
        undefined,
        { "retry-after": "1" },
      )

    const headers = new Headers(request.headers)
    headers.delete("x-mockingbird-api-key")
    // Emulators take per-request control headers (reset, restore, clock, faults, delay). From an
    // anonymous caller those would be a way to wipe an open fleet or hold its connections open,
    // so only a member key may send them. Choosing a namespace is harmless and always allowed.
    if (!privileged)
      for (const key of [...headers.keys()])
        if (key.startsWith("x-mockingbird-") && key !== "x-mockingbird-namespace")
          headers.delete(key)
    const cookieName = sessionCookieName(config)
    if (readCookie(request, cookieName) !== undefined) {
      const kept = (headers.get("cookie") ?? "")
        .split(";")
        .filter((pair) => pair.split("=")[0]?.trim() !== cookieName)
        .join(";")
      if (kept.trim()) headers.set("cookie", kept)
      else headers.delete("cookie")
    }
    const forwarded = new Request(`${fleetOrigin.origin}${path}${url.search}`, {
      method: request.method,
      headers,
      ...(request.body ? { body: request.body, duplex: "half" } : {}),
      signal: request.signal,
    } as RequestInit)

    const started = performance.now()
    const attributes = { "fleet.slug": slug, "emulator.name": name, "emulator.target": spec.target }
    meter.record(org.id)
    inFlight.set(fleet.id, active + 1)
    return telemetry
      .span(
        "fleet.request",
        {
          ...attributes,
          "emulator.durability": spec.durability,
          "http.request.method": request.method,
        },
        async (span) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const response = await Promise.race([
            engine.handle(
              {
                fleetId: fleet.id,
                name,
                spec,
                baseUrl: `${fleetOrigin.origin}/f/${slug}/${name}`,
                maxStateBytes: limits.stateBytes,
              },
              forwarded,
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new HttpError(
                      504,
                      "emulator_timeout",
                      `The emulator did not answer within ${config.fleetRequestTimeoutMs} ms`,
                    ),
                  ),
                config.fleetRequestTimeoutMs,
              )
            }),
          ]).finally(() => clearTimeout(timer))
          span.set({ "http.response.status_code": response.status })
          telemetry.count("fleet.requests", { target: spec.target, durability: spec.durability })
          telemetry.record("fleet.request.duration", performance.now() - started, {
            target: spec.target,
            durability: spec.durability,
          })
          const out = new Headers(response.headers)
          // Never let an emulated response set or clear the dashboard's own session cookie.
          const cookies = out.getSetCookie().filter((value) => !value.startsWith(`${cookieName}=`))
          out.delete("set-cookie")
          for (const value of cookies) out.append("set-cookie", value)
          if (sharedOrigin) {
            // Emulators can serve HTML (hosted checkout pages, stored objects). On a shared origin
            // that page must not run with the dashboard's authority, so it gets an opaque origin.
            out.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups")
            out.set("x-content-type-options", "nosniff")
          }
          for (const [key, value] of Object.entries(rateHeaders(decision))) out.set(key, value)
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: out,
          })
        },
      )
      .finally(() => {
        const remaining = (inFlight.get(fleet.id) ?? 1) - 1
        if (remaining > 0) inFlight.set(fleet.id, remaining)
        else inFlight.delete(fleet.id)
      })
  }

  /** Browser apps on an allowed origin may call the API with an API key, never with cookies. */
  function cors(request: Request): Record<string, string> | undefined {
    const origin = request.headers.get("origin")
    if (!origin || !config.corsOrigins.includes(origin)) return undefined
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type, x-mockingbird-api-key",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
      "access-control-expose-headers":
        "ratelimit-limit, ratelimit-remaining, retry-after, x-request-id",
      "access-control-max-age": "600",
      vary: "origin",
    }
  }

  async function dashboard(request: Request, url: URL, address: string): Promise<Response> {
    if (url.pathname.startsWith("/auth/")) {
      spend(
        `auth:${address}`,
        config.rateLimits.authPerMinute,
        "auth_rate_limited",
        "Too many sign-in attempts from this address.",
      )
      if (url.pathname === "/auth/login" && request.method === "GET") return auth.login(request)
      if (url.pathname === "/auth/callback" && request.method === "GET")
        return auth.callback(request)
      if (request.method !== "POST") throw notFound("Page")
      if (request.headers.get("x-mockingbird-csrf") !== "1") throw forbidden()
      if (url.pathname === "/auth/logout")
        return json({ ok: true }, 200, { "set-cookie": await auth.logout(request) })
      const body = await readJson(request)
      if (url.pathname === "/auth/dev-login") {
        if (typeof body.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(body.email))
          throw badRequest("email is required")
        return json({ ok: true }, 200, { "set-cookie": await auth.devLogin(body.email) })
      }
      if (url.pathname === "/auth/token-login") {
        if (typeof body.token !== "string") throw badRequest("token is required")
        return json({ ok: true }, 200, { "set-cookie": await auth.tokenLogin(body.token) })
      }
      throw notFound("Page")
    }
    if (url.pathname.startsWith("/api/")) {
      const allowed = cors(request)
      if (request.method === "OPTIONS" && allowed)
        return new Response(null, { status: 204, headers: allowed })
      let response: Response
      try {
        response = await api(request, url.pathname.slice(4), address)
      } catch (error) {
        if (!(error instanceof HttpError)) throw error
        response = errorResponse(error)
      }
      for (const [key, value] of Object.entries(allowed ?? {})) response.headers.set(key, value)
      return response
    }
    if (!["GET", "HEAD"].includes(request.method)) throw notFound("Page")
    if (url.pathname === "/llms.txt")
      return new Response(guide, { headers: { "content-type": "text/plain; charset=utf-8" } })
    const file =
      (await input.asset?.(url.pathname)) ??
      // Client-side routes: any path without a file extension is the single-page app.
      (/\.[a-z0-9]+$/i.test(url.pathname) ? undefined : await input.asset?.("/index.html"))
    if (!file) throw notFound("Page")
    for (const [key, value] of Object.entries(DASHBOARD_HEADERS)) file.headers.set(key, value)
    return file
  }

  return {
    openapi: document,
    /** `socketAddress` is the peer address of the connection, from the HTTP server. */
    async fetch(request: Request, socketAddress?: string): Promise<Response> {
      const url = new URL(request.url)
      // Liveness: no database, no object store, no auth. A deploy is healthy once this answers.
      if (url.pathname === "/health") return json({ status: "ok" })
      const started = performance.now()
      const supplied = request.headers.get("x-request-id") ?? ""
      const requestId = /^[\w.-]{8,64}$/.test(supplied) ? supplied : `req_${randomString(16)}`
      const fleetRequest = url.pathname === "/f" || url.pathname.startsWith("/f/")
      const address = clientAddress(request, socketAddress)
      let response: Response
      try {
        response = await telemetry.span(
          `${request.method} ${fleetRequest ? "/f/*" : url.pathname.startsWith("/api/") ? "/api/*" : "/*"}`,
          {
            "http.request.method": request.method,
            "url.path": url.pathname,
            "request.id": requestId,
          },
          async (span) => {
            let result: Response
            try {
              if (url.pathname === "/ready") {
                await db.ping()
                result = json({ status: "ready", loadedEmulators: engine.size })
              } else if (fleetRequest) {
                // With a dedicated fleet host, each host serves only its own half.
                if (!sharedOrigin && url.host !== fleetOrigin.host) throw notFound("Page")
                result = await dataPlane(request, url, address)
              } else {
                if (!sharedOrigin && url.host === fleetOrigin.host) throw notFound("Page")
                result = await dashboard(request, url, address)
              }
            } catch (error) {
              if (!(error instanceof HttpError)) throw error
              result = errorResponse(error)
            }
            span.set({ "http.response.status_code": result.status })
            telemetry.record("http.server.duration", performance.now() - started, {
              plane: fleetRequest ? "fleet" : "control",
            })
            return result
          },
          { kind: "server", traceparent: request.headers.get("traceparent") },
        )
      } catch (error) {
        telemetry.log("error", "unhandled request error", {
          path: url.pathname,
          request_id: requestId,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        })
        response = errorResponse(
          new HttpError(
            500,
            "internal_error",
            `Something went wrong. Quote request id ${requestId} when reporting it.`,
          ),
        )
      }
      // Quote this id in a bug report; it is on the matching log line and trace.
      try {
        response.headers.set("x-request-id", requestId)
      } catch {
        // A redirect built with immutable headers; the id is still in the logs.
      }
      return response
    },
  }
}
