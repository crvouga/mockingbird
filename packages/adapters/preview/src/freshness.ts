/**
 * Freshness: an open tab knows which build it runs, which build is current for its preview, and
 * what is happening to the next one.
 *
 * - A `BuildIdentity` (`{ commit, builtAt, parts: { [appId]: pin } }`) is what a tab carries; a
 *   part's pin is the content hash of that app's part (a `PreviewArtifact`'s `sha256`).
 * - A `FreshnessStatus` (`{ current, next? }`) is a small document per preview, written next to
 *   the deployment by trusted CI (`createFreshnessStatusFile`) or derived by the on-demand build
 *   relay (`freshnessFromLaunch`). It is served with `no-store` and open CORS.
 * - `watchFreshness()` polls it on the page, pauses while hidden, checks at once on focus, backs
 *   off on errors and yields a `Freshness`: `current`, `newer-live`, `newer-building`,
 *   `newer-failed` or `unknown`.
 *
 * Portable: Fetch and timers only; the document's visibility is injected.
 */

import type { PreviewArtifact } from "./artifacts.js"
import type { PreviewLaunch } from "./on-demand.js"

/** The build a tab runs. `parts` maps an app id to the content hash of its part. */
export type BuildIdentity = {
  commit: string
  builtAt: string
  parts: Record<string, string>
}

/** The next build of a preview, while it is not current. */
export type FreshnessNext = {
  state: "queued" | "building" | "publishing" | "failed"
  commit: string
  startedAt: string
  /** The CI run's address. */
  run: string
}

/** The status document of one preview (per PR, or per base branch). */
export type FreshnessStatus = { current: BuildIdentity | null; next?: FreshnessNext }

/** How to apply a newer live build: swap one app's part, or reload the shell. */
export type FreshnessUpdate = { kind: "app"; app: string } | { kind: "reload" }

/** What an open tab should know about its build. `changed` lists the apps whose part differs. */
export type Freshness =
  | { state: "current"; running: BuildIdentity; changed: [] }
  | {
      state: "newer-live"
      running: BuildIdentity
      current: BuildIdentity
      changed: string[]
      update: FreshnessUpdate
      /** A build after `current`, if one is under way. */
      next?: FreshnessNext
    }
  | {
      state: "newer-building"
      running: BuildIdentity
      next: FreshnessNext
      /** Unknown until the build publishes its parts. */
      changed: null
    }
  | { state: "newer-failed"; running: BuildIdentity; next: FreshnessNext; changed: null }
  | {
      state: "unknown"
      running: BuildIdentity
      changed: null
      /** Why the status could not be read. */
      reason: string
      /** When the next try is due (ms from now). */
      retryInMs: number
    }

export type FreshnessState = Freshness["state"]

/** The file name `createFreshnessStatusFile` writes and `watchFreshness` reads by default. */
export const FRESHNESS_STATUS_PATH = "freshness.json"

/** The headers a status document is served with: never cached, readable from any origin. */
export const FRESHNESS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const NEXT_STATES = new Set(["queued", "building", "publishing", "failed"])
const COMMIT = /^[0-9a-f]{7,64}$/i
const isDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value))

/** A build identity; a part may be given as its pin or as its `PreviewArtifact`. */
export function createBuildIdentity(options: {
  commit: string
  builtAt?: string
  parts?: Record<string, string | Pick<PreviewArtifact, "sha256">>
}): BuildIdentity {
  const parts: Record<string, string> = {}
  for (const [app, part] of Object.entries(options.parts ?? {}))
    parts[app] = typeof part === "string" ? part : part.sha256
  const identity = parseBuildIdentity({
    commit: options.commit,
    builtAt: options.builtAt ?? new Date().toISOString(),
    parts,
  })
  if (!identity) throw new Error("Invalid build identity")
  return identity
}

/** Validates a build identity; undefined when malformed. */
export function parseBuildIdentity(value: unknown): BuildIdentity | undefined {
  if (!isRecord(value)) return undefined
  const { commit, builtAt } = value
  const parts = value.parts ?? {}
  if (typeof commit !== "string" || !COMMIT.test(commit) || !isDate(builtAt)) return undefined
  if (!isRecord(parts)) return undefined
  const pins: Record<string, string> = {}
  for (const [app, pin] of Object.entries(parts)) {
    if (!app || typeof pin !== "string" || !pin) return undefined
    pins[app] = pin
  }
  return { commit, builtAt, parts: pins }
}

/** Validates a status document; undefined when malformed. */
export function parseFreshnessStatus(value: unknown): FreshnessStatus | undefined {
  if (!isRecord(value) || !("current" in value)) return undefined
  const current = value.current === null ? null : parseBuildIdentity(value.current)
  if (current === undefined) return undefined
  if (value.next === undefined || value.next === null) return { current }
  const next = value.next
  if (
    !isRecord(next) ||
    typeof next.state !== "string" ||
    !NEXT_STATES.has(next.state) ||
    typeof next.commit !== "string" ||
    !COMMIT.test(next.commit) ||
    !isDate(next.startedAt) ||
    typeof next.run !== "string"
  )
    return undefined
  return {
    current,
    next: {
      state: next.state as FreshnessNext["state"],
      commit: next.commit,
      startedAt: next.startedAt,
      run: next.run,
    },
  }
}

/** The status document as a static file to deploy next to the preview (serve it with `FRESHNESS_HEADERS`). */
export function createFreshnessStatusFile(
  status: FreshnessStatus,
  path: string = FRESHNESS_STATUS_PATH,
): { path: string; bytes: Uint8Array; contentType: string; headers: string } {
  const valid = parseFreshnessStatus(status)
  if (!valid) throw new Error("Invalid freshness status")
  const route = `/${path.replace(/^\/+/, "")}`
  return {
    path,
    bytes: new TextEncoder().encode(`${JSON.stringify(valid)}\n`),
    contentType: "application/json",
    headers: `${route}\n${Object.entries(FRESHNESS_HEADERS)
      .filter(([name]) => name !== "content-type")
      .map(([name, value]) => `  ${name}: ${value}`)
      .join("\n")}\n`,
  }
}

/** The status document as a Fetch response (`no-store`, open CORS). */
export const freshnessStatusResponse = (status: FreshnessStatus): Response =>
  new Response(JSON.stringify(status), { headers: FRESHNESS_HEADERS })

/**
 * A status document derived from an on-demand relay's answer: `current` is the live build (its
 * identity, typically read from `preview-source.json`), `next` the head commit's build while it is
 * queued, building, publishing or failed.
 */
export function freshnessFromLaunch(
  launch: PreviewLaunch,
  current: BuildIdentity | null,
  now: () => number = Date.now,
): FreshnessStatus {
  if (launch.state !== "queued" && launch.state !== "building" && launch.state !== "publishing") {
    if (launch.state !== "failed" || !launch.head) return { current }
  }
  if (!launch.head || launch.head === current?.commit) return { current }
  const run = "run" in launch ? launch.run : undefined
  return {
    current,
    next: {
      state: launch.state,
      commit: launch.head,
      startedAt: run?.startedAt ?? new Date(now()).toISOString(),
      run: run?.url ?? "",
    },
  }
}

/** The apps whose part differs between two builds (added, removed or changed), sorted. */
export function changedParts(from: BuildIdentity, to: BuildIdentity): string[] {
  const apps = new Set([...Object.keys(from.parts), ...Object.keys(to.parts)])
  return [...apps].filter((app) => from.parts[app] !== to.parts[app]).sort()
}

/**
 * How to take `to`: when exactly one app's part changed (and no app was added or removed) it can
 * be applied to that app alone; anything else reloads the shell.
 */
export function planFreshnessUpdate(from: BuildIdentity, to: BuildIdentity): FreshnessUpdate {
  const changed = changedParts(from, to)
  const sameApps =
    Object.keys(from.parts).length === Object.keys(to.parts).length &&
    Object.keys(to.parts).every((app) => app in from.parts)
  return changed.length === 1 && sameApps
    ? { kind: "app", app: changed[0] as string }
    : { kind: "reload" }
}

/** What a tab running `running` should know, given a status document. */
export function compareFreshness(running: BuildIdentity, status: FreshnessStatus): Freshness {
  const { current, next } = status
  const pending = next && next.commit !== running.commit && next.commit !== current?.commit
  if (current && current.commit !== running.commit) {
    return {
      state: "newer-live",
      running,
      current,
      changed: changedParts(running, current),
      update: planFreshnessUpdate(running, current),
      ...(pending ? { next } : {}),
    }
  }
  if (pending && next.state === "failed")
    return { state: "newer-failed", running, next, changed: null }
  if (pending) return { state: "newer-building", running, next, changed: null }
  return { state: "current", running, changed: [] }
}

/** The page's visibility, injected so tests and non-DOM hosts can drive it. */
export type FreshnessVisibility = {
  hidden(): boolean
  /** Calls `listener` when the page becomes visible or gains focus; returns the unsubscriber. */
  onVisible(listener: () => void): () => void
}

/** `document`'s visibility and the window's focus. */
export function documentVisibility(
  doc: Document = globalThis.document,
  win: Window | undefined = doc?.defaultView ?? undefined,
): FreshnessVisibility {
  return {
    hidden: () => doc?.visibilityState === "hidden",
    onVisible(listener) {
      const visible = () => {
        if (doc.visibilityState !== "hidden") listener()
      }
      doc?.addEventListener("visibilitychange", visible)
      win?.addEventListener("focus", visible)
      return () => {
        doc?.removeEventListener("visibilitychange", visible)
        win?.removeEventListener("focus", visible)
      }
    },
  }
}

export type WatchFreshnessOptions = {
  /** The status document's URL, or a function that reads it. */
  source: string | URL | (() => Promise<unknown>)
  /** The build this tab runs. */
  running: BuildIdentity
  /** Poll interval in ms. Default 30 000. */
  interval?: number
  /** Longest wait between failing tries, in ms. Default 600 000. */
  maxBackoff?: number
  onChange?(freshness: Freshness): void
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Default: `documentVisibility()` when there is a document, else always visible. */
  visibility?: FreshnessVisibility
  timers?: {
    setTimeout(run: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
}

export type FreshnessWatch = {
  get(): Freshness
  subscribe(listener: (freshness: Freshness) => void): () => void
  /** Checks now (also what focus does). */
  check(): Promise<Freshness>
  /** The tab takes `identity` (after an update): compare against it from now on. */
  setRunning(identity: BuildIdentity): void
  stop(): void
}

const key = (freshness: Freshness) => JSON.stringify(freshness)

/**
 * Watches a preview's status document. Polls every `interval` while the page is visible, does
 * nothing while it is hidden, checks once when it becomes visible or gains focus, and on errors
 * answers `unknown` and backs off (doubling up to `maxBackoff`). It never throws into the app.
 */
export function watchFreshness(options: WatchFreshnessOptions): FreshnessWatch {
  const interval = options.interval ?? 30_000
  const maxBackoff = options.maxBackoff ?? 600_000
  const timers = options.timers ?? {
    setTimeout: (run: () => void, ms: number) => globalThis.setTimeout(run, ms),
    clearTimeout: (handle: unknown) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const visibility =
    options.visibility ??
    (typeof document === "undefined"
      ? { hidden: () => false, onVisible: () => () => {} }
      : documentVisibility())
  const read =
    typeof options.source === "function"
      ? options.source
      : async () => {
          const response = await (options.fetch ?? fetch)(String(options.source), {
            cache: "no-store",
            credentials: "omit",
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json()
        }
  let running = options.running
  let value: Freshness = { state: "current", running, changed: [] }
  let failures = 0
  let timer: unknown
  let stopped = false
  let inflight: Promise<Freshness> | undefined
  const listeners = new Set<(freshness: Freshness) => void>()
  if (options.onChange) listeners.add(options.onChange)

  const emit = (next: Freshness) => {
    if (key(next) === key(value)) return
    value = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch {
        // A listener's error never stops the watch.
      }
    }
  }
  const schedule = (ms: number) => {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = undefined
    if (stopped || visibility.hidden()) return
    timer = timers.setTimeout(() => {
      timer = undefined
      if (!visibility.hidden()) void check()
    }, ms)
  }
  const check = (): Promise<Freshness> => {
    if (inflight) return inflight
    inflight = (async () => {
      let delay = interval
      try {
        const status = parseFreshnessStatus(await read())
        if (!status) throw new Error("not a freshness status")
        failures = 0
        emit(compareFreshness(running, status))
      } catch (error) {
        failures++
        delay = Math.min(maxBackoff, interval * 2 ** (failures - 1))
        emit({
          state: "unknown",
          running,
          changed: null,
          reason: error instanceof Error ? error.message : "unreadable",
          retryInMs: delay,
        })
      } finally {
        inflight = undefined
      }
      schedule(delay)
      return value
    })()
    return inflight
  }
  const unsubscribe = visibility.onVisible(() => {
    if (!stopped) void check()
  })
  if (!visibility.hidden()) void check()

  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    check,
    setRunning(identity) {
      running = identity
      value = { state: "current", running, changed: [] }
      void check()
    },
    stop() {
      stopped = true
      if (timer !== undefined) timers.clearTimeout(timer)
      timer = undefined
      unsubscribe()
      listeners.clear()
    },
  }
}
