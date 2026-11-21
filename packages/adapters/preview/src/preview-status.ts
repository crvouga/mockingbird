/**
 * Preview status: CI tells a deployed preview what is happening to it, and every open tab hears
 * about it at once.
 *
 * GitHub Actions POSTs build and checks events to `/__preview/events`, authenticated by the job's
 * GitHub OIDC token (no shared secret). A Durable Object keeps the latest snapshot and broadcasts
 * it over hibernatable WebSockets (`/__preview/live`); `/__preview/status` serves it to pollers.
 *
 * Portable: Fetch + WebCrypto (+ the Workers `WebSocketPair` global, when present). The Durable
 * Object platform types are structural, so nothing here imports `cloudflare:workers`.
 */

/** A build of the preview for one commit. */
export type PreviewBuildEvent = {
  kind: "build"
  state: "building" | "deployed" | "failed"
  /** Full commit SHA the build is for. */
  version: string
  /** ISO time of this event. */
  at: string
  /** The GitHub Actions run. */
  runUrl?: string
  /** Short failure reason. */
  message?: string
}

/** The PR's CI checks for one commit. */
export type PreviewChecksEvent = {
  kind: "checks"
  state: "running" | "passed" | "failed"
  version: string
  at: string
  runUrl?: string
  /** E.g. "12 of 14 passed". */
  summary?: string
}

export type PreviewEvent = PreviewBuildEvent | PreviewChecksEvent

export type PreviewStatusSnapshot = {
  /** Latest build event (any state). */
  build?: PreviewBuildEvent
  /** Latest "deployed" build. */
  deployed?: { version: string; at: string; runUrl?: string }
  /** Latest checks event. */
  checks?: PreviewChecksEvent
  pr?: { number: number; url: string }
  updatedAt: string
}

/** What a verifier decides about one request. */
export type PreviewVerifyResult =
  | { ok: true; claims?: Record<string, unknown> }
  | { ok: false; reason: string }

// --- event parsing ---

const BUILD_STATES = ["building", "deployed", "failed"] as const
const CHECK_STATES = ["running", "passed", "failed"] as const
const VERSION = /^[0-9a-f]{7,64}$/i
const MAX_TEXT = 500
const MAX_BODY_BYTES = 16 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalText = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  if (value.length > MAX_TEXT) throw new Error(`${key} must be at most ${MAX_TEXT} characters`)
  return value
}

const optionalHttpsUrl = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = optionalText(record, key)
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${key} must be an absolute URL`)
  }
  if (url.protocol !== "https:") throw new Error(`${key} must be an https URL`)
  return url.href
}

/** Validates an incoming event body; throws Error with a message on anything malformed. */
export function parsePreviewEvent(value: unknown): PreviewEvent {
  if (!isRecord(value)) throw new Error("event must be a JSON object")
  const { kind, state, version, at } = value
  if (kind !== "build" && kind !== "checks") throw new Error('kind must be "build" or "checks"')
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw new Error("version must be a commit SHA (hex)")
  }
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) {
    throw new Error("at must be an ISO timestamp")
  }
  const iso = new Date(at).toISOString()
  const runUrl = optionalHttpsUrl(value, "runUrl")
  if (kind === "build") {
    if (!BUILD_STATES.includes(state as never)) {
      throw new Error(`state must be one of ${BUILD_STATES.join(", ")}`)
    }
    const message = optionalText(value, "message")
    return {
      kind,
      state: state as PreviewBuildEvent["state"],
      version: version.toLowerCase(),
      at: iso,
      ...(runUrl === undefined ? {} : { runUrl }),
      ...(message === undefined ? {} : { message }),
    }
  }
  if (!CHECK_STATES.includes(state as never)) {
    throw new Error(`state must be one of ${CHECK_STATES.join(", ")}`)
  }
  const summary = optionalText(value, "summary")
  return {
    kind,
    state: state as PreviewChecksEvent["state"],
    version: version.toLowerCase(),
    at: iso,
    ...(runUrl === undefined ? {} : { runUrl }),
    ...(summary === undefined ? {} : { summary }),
  }
}

// --- GitHub Actions OIDC ---

export type GithubOidcVerifierOptions = {
  /** "owner/name"; the token's `repository` claim must equal it. */
  repository: string
  /** Expected `aud`. Default: the request's origin. */
  audience?: (request: Request) => string
  /** Default "https://token.actions.githubusercontent.com". */
  issuer?: string
  /** Fetches the JWKS; injectable in tests. */
  fetch?: (request: Request) => Promise<Response>
  /** Clock in ms; injectable in tests. */
  now?: () => number
}

export type GithubOidcResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; reason: string }

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
const JWKS_TTL_MS = 10 * 60 * 1000
const UNKNOWN_KID_COOLDOWN_MS = 30 * 1000
const SKEW_S = 60

const base64UrlBytes = (text: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url")
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const base64UrlJson = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(text)))
  if (!isRecord(value)) throw new Error("not an object")
  return value
}

/** Verifies `Authorization: Bearer <GitHub Actions OIDC JWT>` (RS256 only). */
export function githubOidcVerifier(
  options: GithubOidcVerifierOptions,
): (request: Request) => Promise<GithubOidcResult> {
  const issuer = (options.issuer ?? GITHUB_ISSUER).replace(/\/$/, "")
  const fetcher = options.fetch ?? ((request: Request) => fetch(request))
  const now = options.now ?? Date.now
  const audienceOf = options.audience ?? ((request: Request) => new URL(request.url).origin)
  let keys: Map<string, CryptoKey> | undefined
  let fetchedAt = Number.NEGATIVE_INFINITY

  const loadKeys = async (): Promise<Map<string, CryptoKey>> => {
    const response = await fetcher(
      new Request(`${issuer}/.well-known/jwks`, { headers: { accept: "application/json" } }),
    )
    if (!response.ok) throw new Error(`JWKS fetch failed (${response.status})`)
    const body: unknown = await response.json()
    const list = isRecord(body) && Array.isArray(body.keys) ? body.keys : []
    const next = new Map<string, CryptoKey>()
    for (const jwk of list) {
      if (!isRecord(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue
      if (jwk.use !== undefined && jwk.use !== "sig") continue
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue
      try {
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n as string, e: jwk.e as string, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        )
        next.set(jwk.kid, key)
      } catch {
        // A key we cannot import cannot verify anything; skip it.
      }
    }
    keys = next
    fetchedAt = now()
    return next
  }

  const keyFor = async (kid: string): Promise<CryptoKey | undefined> => {
    let fetchedNow = false
    if (keys === undefined || now() - fetchedAt > JWKS_TTL_MS) {
      await loadKeys()
      fetchedNow = true
    }
    const found = keys?.get(kid)
    if (found !== undefined) return found
    // Unknown kid: GitHub may have rotated. Refetch once, at most every 30 s.
    if (fetchedNow || now() - fetchedAt < UNKNOWN_KID_COOLDOWN_MS) return undefined
    return (await loadKeys()).get(kid)
  }

  return async (request) => {
    const header = request.headers.get("authorization") ?? ""
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    if (!match?.[1]) return { ok: false, reason: "missing bearer token" }
    const parts = match[1].split(".")
    if (parts.length !== 3) return { ok: false, reason: "malformed token" }
    const [rawHeader = "", rawPayload = "", rawSignature = ""] = parts
    let jose: Record<string, unknown>
    let claims: Record<string, unknown>
    let signature: Uint8Array
    try {
      jose = base64UrlJson(rawHeader)
      claims = base64UrlJson(rawPayload)
      signature = base64UrlBytes(rawSignature)
    } catch {
      return { ok: false, reason: "malformed token" }
    }
    if (jose.alg !== "RS256") return { ok: false, reason: "unsupported token algorithm" }
    if (typeof jose.kid !== "string") return { ok: false, reason: "token has no key id" }
    let key: CryptoKey | undefined
    try {
      key = await keyFor(jose.kid)
    } catch {
      return { ok: false, reason: "could not load signing keys" }
    }
    if (key === undefined) return { ok: false, reason: "unknown signing key" }
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    )
    if (!valid) return { ok: false, reason: "bad signature" }
    if (claims.iss !== issuer) return { ok: false, reason: "wrong issuer" }
    const audience = audienceOf(request)
    const aud = claims.aud
    const audOk = Array.isArray(aud) ? aud.includes(audience) : aud === audience
    if (!audOk) return { ok: false, reason: "wrong audience" }
    const seconds = now() / 1000
    if (typeof claims.exp !== "number") return { ok: false, reason: "token has no expiry" }
    if (seconds > claims.exp + SKEW_S) return { ok: false, reason: "token expired" }
    if (
      claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" || seconds < claims.nbf - SKEW_S)
    ) {
      return { ok: false, reason: "token not yet valid" }
    }
    if (claims.repository !== options.repository) return { ok: false, reason: "wrong repository" }
    return { ok: true, claims }
  }
}

// --- Durable Object ---

/** The server end of a Workers WebSocket, as much of it as this module uses. */
export type PreviewWebSocketLike = {
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** The Durable Object state, as much of it as this module uses (hibernation API). */
export type DurableObjectStateLike = {
  acceptWebSocket(ws: PreviewWebSocketLike, tags?: string[]): void
  getWebSockets(tag?: string): PreviewWebSocketLike[]
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    put<T>(key: string, value: T): Promise<void>
  }
  setWebSocketAutoResponse?(pair: unknown): void
}

/** A Durable Object namespace binding, as much of it as this module uses. */
export type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

/** One WebSocket upgrade: the client end goes in the 101 response, the server end is accepted. */
export type PreviewWebSocketUpgrade = {
  server: PreviewWebSocketLike
  response: Response
}

export type PreviewStatusObjectOptions = {
  verify: (request: Request) => Promise<PreviewVerifyResult>
  /** The PR this preview belongs to, read from the Worker's env. */
  pr?: (env: Record<string, unknown>) => { number: number; url: string } | undefined
  /**
   * Creates a WebSocket pair and its 101 response. Default: the Workers `WebSocketPair` global and
   * `new Response(null, { status: 101, webSocket })`. Injectable for runtimes without them (tests).
   */
  upgrade?: () => PreviewWebSocketUpgrade
}

export type PreviewStatusObject = {
  fetch(request: Request): Promise<Response>
  webSocketMessage(ws: PreviewWebSocketLike, message: string | ArrayBuffer): void
  webSocketClose(ws: PreviewWebSocketLike, code: number, reason: string, wasClean: boolean): void
  webSocketError(ws: PreviewWebSocketLike, error: unknown): void
}

type WebSocketPairGlobal = new () => { 0: unknown; 1: PreviewWebSocketLike }
type AutoResponsePairGlobal = new (request: string, response: string) => unknown

const defaultUpgrade = (): PreviewWebSocketUpgrade => {
  const Pair = (globalThis as { WebSocketPair?: WebSocketPairGlobal }).WebSocketPair
  if (Pair === undefined) throw new Error("WebSocketPair is not available in this runtime")
  const pair = new Pair()
  return {
    server: pair[1],
    response: new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit),
  }
}

const SNAPSHOT_KEY = "snapshot"
type Stored = Omit<PreviewStatusSnapshot, "pr">

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })

const lastSegment = (pathname: string): string => pathname.slice(pathname.lastIndexOf("/") + 1)

/** `true` when `event` is older than the stored event of the same kind and version. */
const stale = (stored: { version: string; at: string } | undefined, event: PreviewEvent): boolean =>
  stored !== undefined &&
  stored.version === event.version &&
  Date.parse(stored.at) > Date.parse(event.at)

const readBody = async (request: Request): Promise<unknown> => {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error(`body must be at most ${MAX_BODY_BYTES} bytes`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error("body must be JSON")
  }
}

/**
 * A Durable Object class holding the preview's status snapshot. Export it from the Worker and bind
 * it (as `PREVIEW_STATUS` by default) with a `new_sqlite_classes` migration.
 */
export function createPreviewStatusObject(
  options: PreviewStatusObjectOptions,
): new (
  state: DurableObjectStateLike,
  env: Record<string, unknown>,
) => PreviewStatusObject {
  const upgrade = options.upgrade ?? defaultUpgrade
  return class PreviewStatus implements PreviewStatusObject {
    readonly #state: DurableObjectStateLike
    readonly #env: Record<string, unknown>
    #stored: Stored | undefined

    constructor(state: DurableObjectStateLike, env: Record<string, unknown>) {
      this.#state = state
      this.#env = env
      const AutoResponse = (globalThis as { WebSocketRequestResponsePair?: AutoResponsePairGlobal })
        .WebSocketRequestResponsePair
      if (AutoResponse !== undefined && state.setWebSocketAutoResponse !== undefined) {
        // Answered by the runtime without waking the object.
        state.setWebSocketAutoResponse(new AutoResponse("ping", "pong"))
      }
    }

    async #load(): Promise<Stored> {
      if (this.#stored === undefined) {
        this.#stored = (await this.#state.storage.get<Stored>(SNAPSHOT_KEY)) ?? {
          updatedAt: new Date(0).toISOString(),
        }
      }
      return this.#stored
    }

    async #snapshot(): Promise<PreviewStatusSnapshot> {
      const stored = await this.#load()
      const pr = options.pr?.(this.#env)
      return pr === undefined ? { ...stored } : { ...stored, pr }
    }

    #broadcast(snapshot: PreviewStatusSnapshot): void {
      const message = JSON.stringify({ type: "snapshot", snapshot })
      for (const ws of this.#state.getWebSockets()) {
        try {
          ws.send(message)
        } catch {
          // A socket closing under us; its close handler cleans up.
        }
      }
    }

    async fetch(request: Request): Promise<Response> {
      const route = lastSegment(new URL(request.url).pathname)
      if (route === "status") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json({ error: "method not allowed" }, 405)
        }
        return json(await this.#snapshot())
      }
      if (route === "live") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return json({ error: "expected a WebSocket upgrade" }, 426)
        }
        const { server, response } = upgrade()
        this.#state.acceptWebSocket(server)
        server.send(JSON.stringify({ type: "snapshot", snapshot: await this.#snapshot() }))
        return response
      }
      if (route === "events") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
        const verdict = await options.verify(request)
        if (!verdict.ok) return json({ error: verdict.reason }, 401)
        let event: PreviewEvent
        try {
          event = parsePreviewEvent(await readBody(request))
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "bad event" }, 400)
        }
        await this.#apply(event)
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
      }
      return json({ error: "not found" }, 404)
    }

    async #apply(event: PreviewEvent): Promise<void> {
      const stored = await this.#load()
      const next: Stored = { ...stored }
      if (event.kind === "build") {
        if (stale(stored.build, event)) return
        next.build = event
        if (event.state === "deployed") {
          if (stale(stored.deployed, event)) return
          next.deployed = {
            version: event.version,
            at: event.at,
            ...(event.runUrl === undefined ? {} : { runUrl: event.runUrl }),
          }
        }
      } else {
        if (stale(stored.checks, event)) return
        next.checks = event
      }
      next.updatedAt = new Date().toISOString()
      await this.#state.storage.put(SNAPSHOT_KEY, next)
      this.#stored = next
      this.#broadcast(await this.#snapshot())
    }

    webSocketMessage(ws: PreviewWebSocketLike, message: string | ArrayBuffer): void {
      if (message === "ping") ws.send("pong")
    }

    webSocketClose(ws: PreviewWebSocketLike, code: number, reason: string): void {
      try {
        ws.close(code === 1005 || code === 1006 ? 1000 : code, reason)
      } catch {
        // Already closed.
      }
    }

    webSocketError(ws: PreviewWebSocketLike): void {
      try {
        ws.close(1011, "error")
      } catch {
        // Already closed.
      }
    }
  }
}

// --- Worker router ---

export type PreviewStatusRoutesOptions = {
  /** Default "/__preview". */
  basePath?: string
  /** The Durable Object binding name. Default "PREVIEW_STATUS". */
  binding?: string
}

const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== new URL(request.url).origin) return false
  const site = request.headers.get("sec-fetch-site")
  // Browsers always send Sec-Fetch-Site; a non-browser client (no header) cannot be a CSRF vector
  // and the snapshot holds nothing secret.
  return site === null || site === "same-origin"
}

/**
 * Worker-side router: forwards `${basePath}/status|live|events` to the singleton status object.
 * Returns undefined for any other path, so the Worker falls through to its own handling.
 */
export function previewStatusRoutes(
  options: PreviewStatusRoutesOptions = {},
): (request: Request, env: Record<string, unknown>) => Promise<Response> | undefined {
  let basePath = options.basePath ?? "/__preview"
  while (basePath.endsWith("/")) basePath = basePath.slice(0, -1)
  const binding = options.binding ?? "PREVIEW_STATUS"
  return (request, env) => {
    const { pathname } = new URL(request.url)
    if (!pathname.startsWith(`${basePath}/`)) return undefined
    const route = pathname.slice(basePath.length + 1)
    if (route !== "status" && route !== "live" && route !== "events") return undefined
    return (async () => {
      if (route !== "events" && !sameOrigin(request)) {
        return json({ error: "cross-origin request refused" }, 403)
      }
      const namespace = env[binding] as DurableObjectNamespaceLike | undefined
      if (namespace === undefined || typeof namespace.idFromName !== "function") {
        return json({ error: `Durable Object binding ${binding} is not configured` }, 503)
      }
      return namespace.get(namespace.idFromName("status")).fetch(request)
    })()
  }
}
