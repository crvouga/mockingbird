/**
 * Preview status: a stateless Fetch handler that tells a deployed preview what CI is doing to it.
 *
 * GitHub is the source of truth. On request it reads the PR's head commit and the latest runs of
 * the build and checks workflows from the GitHub REST API, and the deployed version from the static
 * `version.json`. `GET {base}/status` answers one snapshot; `GET {base}/live` streams snapshots as
 * Server-Sent Events for up to `maxMs`, then closes so the client reconnects. Nothing is stored
 * beyond a short per-isolate cache (plus the Cache API, when given), so it runs on any serverless
 * Fetch runtime. A stateful push layer could be added on top later; nothing here needs one.
 *
 * Portable: Fetch, Streams and timers only.
 */

/** The preview build for one commit: the build workflow's latest run for the PR head. */
export type PreviewBuildStatus = {
  kind: "build"
  state: "building" | "deployed" | "failed"
  /** Full commit SHA the build is for (the PR head). */
  version: string
  /** ISO time the run last changed. */
  at: string
  /** The GitHub Actions run. */
  runUrl?: string
  /** Short failure reason. */
  message?: string
}

/** The PR's CI checks for one commit: the checks workflow's latest run for the PR head. */
export type PreviewChecksStatus = {
  kind: "checks"
  state: "running" | "passed" | "failed"
  version: string
  at: string
  runUrl?: string
  /** E.g. "12 of 14 passed". */
  summary?: string
}

/** Where the CI half of a snapshot came from. */
export type PreviewStatusSource = "github" | "unauthenticated" | "rate-limited" | "unavailable"

export type PreviewStatusSnapshot = {
  /** The PR head's build (any state). */
  build?: PreviewBuildStatus
  /** What `version.json` says is deployed. */
  deployed?: { version: string; at: string; runUrl?: string }
  /** The PR head's checks. */
  checks?: PreviewChecksStatus
  pr?: { number: number; url: string }
  /** "github" when CI status is fresh; otherwise why it is missing or stale. */
  source: PreviewStatusSource
  /** Why CI status is missing or stale. Never contains a secret. */
  message?: string
  updatedAt: string
}

/** The deployed build, as the static `version.json` names it. */
export type PreviewDeployedVersion = { version: string; builtAt: string }

/** A cache, as much of the Workers / browser Cache API as this module uses. */
export type PreviewStatusCacheLike = {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export type PreviewStatusOptions = {
  /** "owner/name". */
  repository: string
  /** The PR this preview belongs to. */
  pr: number
  /** Workflow file names. Default build "system-preview.yml", checks "pr.yml". */
  workflows?: { build?: string; checks?: string }
  /** Optional read-only GitHub token. Unauthenticated (60 requests/hour per IP) when absent. */
  token?: string
  /** Reads the deployed `version.json`; undefined when there is none. */
  readVersion(): Promise<PreviewDeployedVersion | undefined>
  /** Reaches the GitHub API. Default the global `fetch`. */
  fetch?: (request: Request) => Promise<Response>
  /** Clock in ms. Default `Date.now`. */
  now?: () => number
  /** How long a snapshot is reused. Default 10 000 ms. */
  cacheTtlMs?: number
  /** Shares snapshots across isolates (e.g. `caches.default`). */
  cache?: PreviewStatusCacheLike
  /** Default "/__preview". */
  basePath?: string
  /** `/live` timing. Defaults: recompute every 5 000 ms, heartbeat 15 000 ms, close after 55 000 ms. */
  sse?: { intervalMs?: number; heartbeatMs?: number; maxMs?: number }
}

const GITHUB_API = "https://api.github.com"
const API_VERSION = "2022-11-28"
const USER_AGENT = "mockingbird-preview"
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000
const SSE_RETRY_MS = 2_000

const RUNNING = new Set(["queued", "in_progress", "waiting", "requested", "pending"])
const FAILED_MESSAGES: Record<string, string> = {
  failure: "The build failed",
  cancelled: "The build was cancelled",
  timed_out: "The build timed out",
  startup_failure: "The build could not start",
  action_required: "The build needs approval",
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })

const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== new URL(request.url).origin) return false
  const site = request.headers.get("sec-fetch-site")
  // Browsers always send Sec-Fetch-Site; a non-browser client (no header) cannot be a CSRF vector
  // and the snapshot holds nothing secret.
  return site === null || site === "same-origin" || site === "none"
}

/** A GitHub answer this module cannot use, classified without keeping its body. */
class GithubFailure extends Error {
  constructor(
    readonly source: Exclude<PreviewStatusSource, "github">,
    message: string,
    readonly retryAt?: number,
  ) {
    super(message)
  }
}

type Run = { status: string; conclusion: string | null; url?: string; at: string }

const parseRun = (body: unknown): Run | undefined => {
  const runs = isRecord(body) && Array.isArray(body.workflow_runs) ? body.workflow_runs : []
  const run: unknown = runs[0]
  if (!isRecord(run) || typeof run.status !== "string") return undefined
  const at =
    typeof run.updated_at === "string" && !Number.isNaN(Date.parse(run.updated_at))
      ? new Date(run.updated_at).toISOString()
      : undefined
  if (at === undefined) return undefined
  return {
    status: run.status,
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    ...(typeof run.html_url === "string" && run.html_url.startsWith("https://")
      ? { url: run.html_url }
      : {}),
    at,
  }
}

const toBuild = (run: Run | undefined, version: string): PreviewBuildStatus | undefined => {
  if (run === undefined) return undefined
  const base = { kind: "build" as const, version, at: run.at }
  const runUrl = run.url === undefined ? {} : { runUrl: run.url }
  if (run.status !== "completed") {
    return RUNNING.has(run.status) ? { ...base, state: "building", ...runUrl } : undefined
  }
  if (run.conclusion === "success") return { ...base, state: "deployed", ...runUrl }
  const message = FAILED_MESSAGES[run.conclusion ?? ""]
  if (message === undefined) return undefined // skipped, neutral, stale: no build happened
  return { ...base, state: "failed", ...runUrl, message }
}

const toChecks = (run: Run | undefined, version: string): PreviewChecksStatus | undefined => {
  if (run === undefined) return undefined
  const base = { kind: "checks" as const, version, at: run.at }
  const runUrl = run.url === undefined ? {} : { runUrl: run.url }
  if (run.status !== "completed") {
    return RUNNING.has(run.status) ? { ...base, state: "running", ...runUrl } : undefined
  }
  if (run.conclusion === "success" || run.conclusion === "neutral") {
    return { ...base, state: "passed", ...runUrl }
  }
  if (run.conclusion === "skipped" || run.conclusion === "stale") return undefined
  return { ...base, state: "failed", ...runUrl }
}

/** Everything but `updatedAt`: two snapshots with the same key say the same thing. */
const snapshotKey = (snapshot: PreviewStatusSnapshot): string => {
  const { updatedAt: _, ...rest } = snapshot
  return JSON.stringify(rest)
}

const isSnapshot = (value: unknown): value is PreviewStatusSnapshot =>
  isRecord(value) && typeof value.updatedAt === "string" && typeof value.source === "string"

/**
 * A stateless Fetch handler for `{basePath}/status` and `{basePath}/live`, backed by the GitHub REST
 * API. Returns undefined for any path outside `basePath`, so the Worker falls through.
 */
export function createPreviewStatus(
  options: PreviewStatusOptions,
): (request: Request) => Promise<Response> | undefined {
  let basePath = options.basePath ?? "/__preview"
  while (basePath.endsWith("/")) basePath = basePath.slice(0, -1)
  const repository = options.repository
  const buildWorkflow = options.workflows?.build ?? "system-preview.yml"
  const checksWorkflow = options.workflows?.checks ?? "pr.yml"
  const fetcher = options.fetch ?? ((request: Request) => fetch(request))
  const now = options.now ?? Date.now
  const ttlMs = options.cacheTtlMs ?? 10_000
  const intervalMs = options.sse?.intervalMs ?? 5_000
  const heartbeatMs = options.sse?.heartbeatMs ?? 15_000
  const maxMs = options.sse?.maxMs ?? 55_000
  const pr = { number: options.pr, url: `https://github.com/${repository}/pull/${options.pr}` }
  const cacheKey = new Request(
    `https://mockingbird-preview.invalid/${encodeURIComponent(repository)}/pulls/${options.pr}`,
  )

  let last: PreviewStatusSnapshot | undefined
  let lastAt = Number.NEGATIVE_INFINITY
  let lastTtlMs = ttlMs
  let inflight: Promise<PreviewStatusSnapshot> | undefined
  let backoffUntil = Number.NEGATIVE_INFINITY

  const github = async (path: string): Promise<unknown> => {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": USER_AGENT,
    }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    let response: Response
    try {
      response = await fetcher(new Request(`${GITHUB_API}${path}`, { headers }))
    } catch {
      throw new GithubFailure("unavailable", "GitHub could not be reached")
    }
    if (response.ok) {
      try {
        return (await response.json()) as unknown
      } catch {
        throw new GithubFailure("unavailable", "GitHub answered with malformed JSON")
      }
    }
    void response.body?.cancel().catch(() => {})
    const { status } = response
    const remaining = response.headers.get("x-ratelimit-remaining")
    const retryAfter = response.headers.get("retry-after")
    if (status === 429 || (status === 403 && (remaining === "0" || retryAfter !== null))) {
      const reset = Number(response.headers.get("x-ratelimit-reset"))
      const retrySeconds = Number(retryAfter)
      const retryAt =
        retryAfter !== null && Number.isFinite(retrySeconds) && retrySeconds > 0
          ? now() + retrySeconds * 1000
          : Number.isFinite(reset) && reset * 1000 > now()
            ? reset * 1000
            : now() + DEFAULT_BACKOFF_MS
      throw new GithubFailure(
        "rate-limited",
        options.token
          ? "GitHub API rate limit reached"
          : "GitHub API rate limit reached; set a read-only token to raise it",
        retryAt,
      )
    }
    if (status === 401) {
      throw new GithubFailure("unauthenticated", "GitHub rejected the token")
    }
    if (status === 403 || status === 404) {
      throw options.token
        ? new GithubFailure("unavailable", "The token cannot read this repository or PR")
        : new GithubFailure(
            "unauthenticated",
            "The repository is not readable without a GitHub token",
          )
    }
    throw new GithubFailure("unavailable", `GitHub answered ${status}`)
  }

  const runs = async (workflow: string, sha: string): Promise<Run | undefined> => {
    const path = `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=1`
    return parseRun(await github(path))
  }

  const ci = async (): Promise<Pick<PreviewStatusSnapshot, "build" | "checks">> => {
    const pull = await github(`/repos/${repository}/pulls/${options.pr}`)
    const head = isRecord(pull) && isRecord(pull.head) ? pull.head.sha : undefined
    if (typeof head !== "string" || !/^[0-9a-f]{7,64}$/i.test(head)) {
      throw new GithubFailure("unavailable", "GitHub answered without a head commit")
    }
    const sha = head.toLowerCase()
    const [build, checks] = await Promise.all([runs(buildWorkflow, sha), runs(checksWorkflow, sha)])
    const buildStatus = toBuild(build, sha)
    const checksStatus = toChecks(checks, sha)
    return {
      ...(buildStatus === undefined ? {} : { build: buildStatus }),
      ...(checksStatus === undefined ? {} : { checks: checksStatus }),
    }
  }

  const readDeployed = async (
    build: PreviewBuildStatus | undefined,
  ): Promise<PreviewStatusSnapshot["deployed"]> => {
    try {
      const value: unknown = await options.readVersion()
      if (!isRecord(value) || typeof value.version !== "string") return undefined
      if (typeof value.builtAt !== "string") return undefined
      const runUrl =
        build?.state === "deployed" && build.version === value.version ? build.runUrl : undefined
      return {
        version: value.version,
        at: value.builtAt,
        ...(runUrl === undefined ? {} : { runUrl }),
      }
    } catch {
      return undefined
    }
  }

  const fromCache = async (): Promise<boolean> => {
    if (options.cache === undefined) return false
    try {
      const hit = await options.cache.match(cacheKey)
      if (hit === undefined) return false
      const fetchedAt = Number(hit.headers.get("x-fetched-at"))
      const hitTtl = Number(hit.headers.get("x-ttl-ms"))
      if (!Number.isFinite(fetchedAt) || !Number.isFinite(hitTtl)) return false
      if (now() - fetchedAt >= hitTtl) return false
      const body: unknown = await hit.json()
      if (!isSnapshot(body)) return false
      last = body
      lastAt = fetchedAt
      lastTtlMs = hitTtl
      return true
    } catch {
      return false
    }
  }

  const toCache = async (snapshot: PreviewStatusSnapshot, ttl: number): Promise<void> => {
    if (options.cache === undefined) return
    try {
      await options.cache.put(
        cacheKey,
        new Response(JSON.stringify(snapshot), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${Math.max(1, Math.ceil(ttl / 1000))}`,
            "x-fetched-at": String(now()),
            "x-ttl-ms": String(ttl),
          },
        }),
      )
    } catch {
      // The cache is an optimisation.
    }
  }

  const refresh = async (): Promise<PreviewStatusSnapshot> => {
    if (await fromCache()) return last as PreviewStatusSnapshot
    let source: PreviewStatusSource = "github"
    let message: string | undefined
    let ciPart: Pick<PreviewStatusSnapshot, "build" | "checks">
    if (now() < backoffUntil) {
      source = "rate-limited"
      message = "GitHub API rate limit reached; showing the last known status"
      ciPart = {
        ...(last?.build ? { build: last.build } : {}),
        ...(last?.checks ? { checks: last.checks } : {}),
      }
    } else {
      try {
        ciPart = await ci()
      } catch (error) {
        const failure =
          error instanceof GithubFailure
            ? error
            : new GithubFailure("unavailable", "CI status could not be read")
        source = failure.source
        message = failure.message
        if (failure.retryAt !== undefined) backoffUntil = failure.retryAt
        ciPart = {
          ...(last?.build ? { build: last.build } : {}),
          ...(last?.checks ? { checks: last.checks } : {}),
        }
      }
    }
    const deployed = await readDeployed(ciPart.build)
    const snapshot: PreviewStatusSnapshot = {
      ...ciPart,
      ...(deployed === undefined ? {} : { deployed }),
      pr,
      source,
      ...(message === undefined ? {} : { message }),
      updatedAt: new Date(now()).toISOString(),
    }
    const ttl = source === "rate-limited" ? Math.max(ttlMs, backoffUntil - now()) : ttlMs
    last = snapshot
    lastAt = now()
    lastTtlMs = ttl
    await toCache(snapshot, ttl)
    return snapshot
  }

  /** The current snapshot: cached for `cacheTtlMs`, one refresh shared by concurrent callers. */
  const snapshot = (): Promise<PreviewStatusSnapshot> => {
    if (last !== undefined && now() - lastAt < lastTtlMs) return Promise.resolve(last)
    if (inflight === undefined) {
      inflight = refresh().finally(() => {
        inflight = undefined
      })
    }
    return inflight
  }

  const live = (request: Request): Response => {
    const encoder = new TextEncoder()
    const handles = new Set<ReturnType<typeof setTimeout>>()
    let done = false
    let finish = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          if (done) return
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            finish()
          }
        }
        const later = (ms: number, run: () => void) => {
          if (done) return
          const handle = setTimeout(() => {
            handles.delete(handle)
            if (!done) run()
          }, ms)
          handles.add(handle)
        }
        finish = () => {
          if (done) return
          done = true
          for (const handle of handles) clearTimeout(handle)
          handles.clear()
          request.signal.removeEventListener("abort", finish)
          try {
            controller.close()
          } catch {
            // Already closed or cancelled.
          }
        }
        if (request.signal.aborted) {
          finish()
          return
        }
        request.signal.addEventListener("abort", finish)
        let sentKey: string | undefined
        const push = (value: PreviewStatusSnapshot) => {
          const key = snapshotKey(value)
          if (key === sentKey) return
          sentKey = key
          send(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`)
        }
        const tick = () => {
          void snapshot().then((value) => {
            if (done) return
            push(value)
            later(intervalMs, tick)
          })
        }
        const heartbeat = () => {
          send(": heartbeat\n\n")
          later(heartbeatMs, heartbeat)
        }
        send(`retry: ${SSE_RETRY_MS}\n\n`)
        later(maxMs, finish)
        later(heartbeatMs, heartbeat)
        tick()
      },
      cancel() {
        finish()
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    })
  }

  return (request) => {
    const { pathname } = new URL(request.url)
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return undefined
    const route = pathname.slice(basePath.length + 1)
    return (async () => {
      if (!sameOrigin(request)) return json({ error: "cross-origin request refused" }, 403)
      if (route !== "status" && route !== "live") return json({ error: "not found" }, 404)
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method not allowed" }, 405)
      }
      if (route === "live") return live(request)
      return json(await snapshot())
    })()
  }
}
