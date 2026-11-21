/**
 * Preview status: a stateless Fetch handler that tells a deployed preview what CI is doing to it.
 *
 * CI pushes the status. The preview workflow writes `PREVIEW_BUILD` and `PREVIEW_CHECKS` (JSON) into
 * the Worker's own configuration (`wrangler secret bulk`), which rolls a new Worker version with
 * the same code and assets; the deploy sets `PREVIEW_PR`. This handler only reads its env on each
 * request, and the deployed version from the static `version.json`. `GET {base}/status` answers one
 * snapshot; `GET {base}/live` streams snapshots as Server-Sent Events for up to `maxMs`, then closes
 * so the client reconnects (and reaches the newest Worker version). Nothing is stored and no
 * outside API is called, so it runs on any serverless Fetch runtime.
 *
 * Portable: Fetch, Streams and timers only.
 */

/** The preview build for one commit, as CI last reported it (`PREVIEW_BUILD`). */
export type PreviewBuildStatus = {
  kind: "build"
  state: "building" | "deployed" | "failed"
  /** Commit SHA the build is for. */
  version: string
  /** ISO time CI reported it. */
  at: string
  /** The CI run. */
  runUrl?: string
  /** Short failure reason. */
  message?: string
}

/** The PR's CI checks for one commit, as CI last reported them (`PREVIEW_CHECKS`). */
export type PreviewChecksStatus = {
  kind: "checks"
  state: "running" | "passed" | "failed"
  version: string
  at: string
  runUrl?: string
  /** E.g. "12 of 14 passed". */
  summary?: string
}

/** Where the CI half of a snapshot came from: `"ci"` once CI has reported, else `"none"`. */
export type PreviewStatusSource = "ci" | "none"

export type PreviewStatusSnapshot = {
  /** The latest build CI reported (any state). */
  build?: PreviewBuildStatus
  /** What `version.json` says is deployed. */
  deployed?: { version: string; at: string; runUrl?: string }
  /** The latest checks CI reported. */
  checks?: PreviewChecksStatus
  pr?: { number: number; url: string }
  /** `"ci"` when CI has reported for this preview; otherwise `"none"` with a `message`. */
  source: PreviewStatusSource
  /** Why CI status is missing. */
  message?: string
  updatedAt: string
}

/** The deployed build, as the static `version.json` names it. */
export type PreviewDeployedVersion = { version: string; builtAt: string }

export type PreviewStatusOptions = {
  /** The Worker env, read on every call: `PREVIEW_BUILD`, `PREVIEW_CHECKS`, `PREVIEW_PR`. */
  env: () => Record<string, unknown>
  /** Reads the deployed `version.json`; undefined when there is none. */
  readVersion(): Promise<PreviewDeployedVersion | undefined>
  /** Default "/__preview". */
  basePath?: string
  /** `/live` timing. Defaults: recompute every 5 000 ms, heartbeat 15 000 ms, close after 25 000 ms. */
  sse?: { intervalMs?: number; heartbeatMs?: number; maxMs?: number }
  /** Clock in ms, for `updatedAt`. Default `Date.now`. */
  now?: () => number
}

/** The env names CI and the deploy write. */
export const PREVIEW_ENV = {
  build: "PREVIEW_BUILD",
  checks: "PREVIEW_CHECKS",
  pr: "PREVIEW_PR",
} as const

export const PREVIEW_STATUS_NO_CI_MESSAGE = "CI has not reported for this preview yet"

const SSE_RETRY_MS = 2_000
const MAX_TEXT = 500

const BUILD_STATES = new Set(["building", "deployed", "failed"])
const CHECKS_STATES = new Set(["running", "passed", "failed"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A JSON env value (a secret is a string; a plain var may already be an object). */
const readJson = (value: unknown): Record<string, unknown> | undefined => {
  if (isRecord(value)) return value
  if (typeof value !== "string" || value === "") return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const iso = (value: unknown): string | undefined =>
  typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined

const httpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  try {
    return new URL(value).protocol === "https:" ? value : undefined
  } catch {
    return undefined
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value.slice(0, MAX_TEXT) : undefined

const optional = <K extends string>(key: K, value: string | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>

/** Parses `PREVIEW_BUILD`; undefined when missing or malformed. */
export const parsePreviewBuild = (value: unknown): PreviewBuildStatus | undefined => {
  const raw = readJson(value)
  if (raw === undefined) return undefined
  const at = iso(raw.at)
  if (typeof raw.state !== "string" || !BUILD_STATES.has(raw.state)) return undefined
  if (typeof raw.version !== "string" || raw.version === "" || at === undefined) return undefined
  return {
    kind: "build",
    state: raw.state as PreviewBuildStatus["state"],
    version: raw.version,
    at,
    ...optional("runUrl", httpsUrl(raw.runUrl)),
    ...optional("message", text(raw.message)),
  }
}

/** Parses `PREVIEW_CHECKS`; undefined when missing or malformed. */
export const parsePreviewChecks = (value: unknown): PreviewChecksStatus | undefined => {
  const raw = readJson(value)
  if (raw === undefined) return undefined
  const at = iso(raw.at)
  if (typeof raw.state !== "string" || !CHECKS_STATES.has(raw.state)) return undefined
  if (typeof raw.version !== "string" || raw.version === "" || at === undefined) return undefined
  return {
    kind: "checks",
    state: raw.state as PreviewChecksStatus["state"],
    version: raw.version,
    at,
    ...optional("runUrl", httpsUrl(raw.runUrl)),
    ...optional("summary", text(raw.summary)),
  }
}

/** Parses `PREVIEW_PR`; undefined when missing or malformed. */
export const parsePreviewPr = (value: unknown): { number: number; url: string } | undefined => {
  const raw = readJson(value)
  if (raw === undefined) return undefined
  const url = httpsUrl(raw.url)
  const number = raw.number
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined
  return url === undefined ? undefined : { number, url }
}

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

/** Everything but `updatedAt`: two snapshots with the same key say the same thing. */
const snapshotKey = (snapshot: PreviewStatusSnapshot): string => {
  const { updatedAt: _, ...rest } = snapshot
  return JSON.stringify(rest)
}

/**
 * A stateless Fetch handler for `{basePath}/status` and `{basePath}/live`, backed by the Worker env
 * CI writes. Returns undefined for any path outside `basePath`, so the Worker falls through.
 */
export function createPreviewStatus(
  options: PreviewStatusOptions,
): (request: Request) => Promise<Response> | undefined {
  let basePath = options.basePath ?? "/__preview"
  while (basePath.endsWith("/")) basePath = basePath.slice(0, -1)
  const now = options.now ?? Date.now
  const intervalMs = options.sse?.intervalMs ?? 5_000
  const heartbeatMs = options.sse?.heartbeatMs ?? 15_000
  const maxMs = options.sse?.maxMs ?? 25_000

  const readDeployed = async (
    build: PreviewBuildStatus | undefined,
  ): Promise<PreviewStatusSnapshot["deployed"]> => {
    try {
      const value: unknown = await options.readVersion()
      if (!isRecord(value) || typeof value.version !== "string") return undefined
      if (typeof value.builtAt !== "string") return undefined
      const runUrl =
        build?.state === "deployed" && build.version === value.version ? build.runUrl : undefined
      return { version: value.version, at: value.builtAt, ...optional("runUrl", runUrl) }
    } catch {
      return undefined
    }
  }

  const snapshot = async (): Promise<PreviewStatusSnapshot> => {
    let env: Record<string, unknown> = {}
    try {
      const value = options.env()
      if (isRecord(value)) env = value
    } catch {
      // No env: nothing reported.
    }
    const build = parsePreviewBuild(env[PREVIEW_ENV.build])
    const checks = parsePreviewChecks(env[PREVIEW_ENV.checks])
    const pr = parsePreviewPr(env[PREVIEW_ENV.pr])
    const deployed = await readDeployed(build)
    const reported = build !== undefined || checks !== undefined
    return {
      ...(build === undefined ? {} : { build }),
      ...(checks === undefined ? {} : { checks }),
      ...(deployed === undefined ? {} : { deployed }),
      ...(pr === undefined ? {} : { pr }),
      source: reported ? "ci" : "none",
      ...(reported ? {} : { message: PREVIEW_STATUS_NO_CI_MESSAGE }),
      updatedAt: new Date(now()).toISOString(),
    }
  }

  const live = (request: Request): Response => {
    const encoder = new TextEncoder()
    const handles = new Set<ReturnType<typeof setTimeout>>()
    let done = false
    let finish = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          if (done) return
          try {
            controller.enqueue(encoder.encode(chunk))
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
