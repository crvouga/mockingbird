/**
 * The launcher page's pure half: the relay's `PreviewLaunch` (a structural copy of
 * `@crvouga/mockingbird-preview`'s type, which this package does not depend on), its validation,
 * the path matcher, friendly step labels, how often to poll, and the view model the DOM paints.
 * Time is always passed in.
 */

/** One build step, as a launcher shows it. */
export type PreviewLaunchStep = {
  name: string
  state: "pending" | "running" | "done" | "failed" | "skipped"
}

/** The CI run building the head commit. */
export type PreviewLaunchRun = { url: string; startedAt: string }

/** Fields every `PreviewLaunch` carries. */
export type PreviewLaunchBase = {
  pullRequest: number
  /** The pull request's head commit. */
  head?: string
  /** An older commit that is live while the head is not, and its address. */
  live?: { commit: string; url: string }
  /** The usual build time, in seconds, when known. */
  estimateSeconds?: number
}

/** The state of a pull request's preview for its head commit, as the relay answers it. */
export type PreviewLaunch = PreviewLaunchBase &
  (
    | { state: "idle" }
    | {
        state: "queued" | "building" | "publishing"
        run?: PreviewLaunchRun
        steps: PreviewLaunchStep[]
      }
    | { state: "live"; commit: string; url: string }
    | { state: "failed"; reason: string; retryable: boolean; run?: PreviewLaunchRun }
    | { state: "unsupported"; message: string }
    | { state: "closed"; message: string }
    | { state: "unavailable"; message: string }
  )

/**
 * What the launcher shows: `loading` before the relay's first answer, a `PreviewLaunch`, `reconnecting` while the relay does not answer
 * one, or `busy` when it refused to start a build because too many are running (HTTP 429).
 */
export type LauncherInput =
  | PreviewLaunch
  | { state: "loading" }
  | { state: "reconnecting" }
  | { state: "busy"; message: string }

export type LauncherState = LauncherInput["state"]

const STEP_STATES = new Set(["pending", "running", "done", "failed", "skipped"])
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === "string"
const isRun = (value: unknown): value is PreviewLaunchRun =>
  isRecord(value) && isText(value.url) && isText(value.startedAt)

/**
 * Reads a relay answer: the `PreviewLaunch` for `pullRequest`, keeping only the fields the
 * launcher knows (so nothing the relay did not mean to show is ever drawn), or undefined.
 */
export function parseLaunch(value: unknown, pullRequest: number): PreviewLaunch | undefined {
  if (!isRecord(value) || value.pullRequest !== pullRequest) return undefined
  const base: PreviewLaunchBase = { pullRequest }
  if (isText(value.head)) base.head = value.head
  if (isRecord(value.live) && isText(value.live.commit) && isText(value.live.url))
    base.live = { commit: value.live.commit, url: value.live.url }
  if (typeof value.estimateSeconds === "number" && value.estimateSeconds > 0)
    base.estimateSeconds = value.estimateSeconds
  const run = isRun(value.run)
    ? { run: { url: value.run.url, startedAt: value.run.startedAt } }
    : {}
  switch (value.state) {
    case "idle":
      return { ...base, state: "idle" }
    case "queued":
    case "building":
    case "publishing": {
      if (!Array.isArray(value.steps)) return undefined
      const steps: PreviewLaunchStep[] = []
      for (const step of value.steps) {
        if (!isRecord(step) || !isText(step.name) || !STEP_STATES.has(step.state as string))
          return undefined
        steps.push({ name: step.name, state: step.state as PreviewLaunchStep["state"] })
      }
      return { ...base, state: value.state, ...run, steps }
    }
    case "live":
      return isText(value.commit) && isText(value.url)
        ? { ...base, state: "live", commit: value.commit, url: value.url }
        : undefined
    case "failed":
      return isText(value.reason) && typeof value.retryable === "boolean"
        ? { ...base, state: "failed", reason: value.reason, retryable: value.retryable, ...run }
        : undefined
    case "unsupported":
    case "closed":
    case "unavailable":
      return isText(value.message)
        ? { ...base, state: value.state, message: value.message }
        : undefined
    default:
      return undefined
  }
}

/**
 * The pull request number in a launcher address such as `/pr/42` (a trailing slash is fine), or
 * undefined: `/pr/0`, leading zeros, anything but digits and trailing segments are rejected.
 */
export function matchLauncherPath(pathname: string, prefix = "/pr/"): number | undefined {
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`
  if (!pathname.startsWith(base)) return undefined
  const match = /^([1-9][0-9]{0,9})\/?$/.exec(pathname.slice(base.length))
  if (!match) return undefined
  const number = Number(match[1])
  return Number.isSafeInteger(number) ? number : undefined
}

/** A commit SHA as people read it. */
export const shortCommit = (commit: string) =>
  /^[0-9a-f]{8,}$/i.test(commit) ? commit.slice(0, 7) : commit

const TOOLS: Record<string, string> = {
  node: "Node.js",
  bun: "Bun",
  deno: "Deno",
  python: "Python",
  go: "Go",
  java: "Java",
  pnpm: "pnpm",
  ruby: "Ruby",
  dotnet: ".NET",
}

/** A CI step's name as people read it: "Run actions/checkout@v4" → "Getting the code". */
export function stepLabel(name: string): string {
  const raw = name.trim()
  if (/^set up job$/i.test(raw)) return "Preparing the build machine"
  if (/checkout/i.test(raw)) return "Getting the code"
  const setup = /setup-([a-z]+)/i.exec(raw)
  if (setup) {
    const tool = setup[1]?.toLowerCase() ?? ""
    return `Setting up ${TOOLS[tool] ?? tool}`
  }
  if (/\bcache\b/i.test(raw)) return "Restoring the cache"
  if (/\b(?:publish|deploy)/i.test(raw)) return "Publishing the preview"
  if (/\b(?:install|ci)\b/i.test(raw)) return "Installing dependencies"
  if (/\bbuild/i.test(raw)) return "Building"
  if (/\btest/i.test(raw)) return "Running tests"
  return raw.replace(/^Run\s+/, "") || raw
}

/** 0:42, 12:05, 1:02:03. */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** "about 45 s", "about 3 min". */
const roughly = (seconds: number) =>
  seconds < 90 ? `about ${Math.round(seconds)} s` : `about ${Math.round(seconds / 60)} min`

/** How long the launcher waits on Ready before opening the preview. */
export const READY_DELAY_MS = 800
/** The most the progress bar shows before the preview is live. */
export const PROGRESS_CAP = 95

/** Poll intervals in ms. */
export const POLL = { active: 5_000, idle: 15_000, live: 30_000 } as const

/**
 * How long until the next poll, or undefined for none: about 5 s while a build runs (or a start
 * is in flight, or the relay is reconnecting), 15 s while idle, failed or busy, 30 s while live
 * and staying, never for terminal states or a page that is about to open the preview.
 */
export function pollInterval(
  input: LauncherInput,
  options: { stay?: boolean; starting?: boolean } = {},
): number | undefined {
  switch (input.state) {
    case "queued":
    case "building":
    case "publishing":
    case "reconnecting":
      return POLL.active
    case "idle":
      return options.starting ? POLL.active : POLL.idle
    case "failed":
    case "busy":
      return POLL.idle
    case "live":
      return options.stay ? POLL.live : undefined
    default:
      return undefined
  }
}

export type LauncherPhaseId = "queued" | "building" | "publishing" | "ready"
export type LauncherPhase = {
  id: LauncherPhaseId
  label: string
  status: "done" | "current" | "todo"
}
export type LauncherStepView = {
  label: string
  name: string
  state: PreviewLaunchStep["state"]
}
export type LauncherTone = "active" | "ready" | "failed" | "stopped" | "reconnecting"

/** Everything the launcher paints for one state at one moment. */
export type LauncherView = {
  state: LauncherState
  tone: LauncherTone
  /** "Pull request #42". */
  title: string
  /** The head commit, short. */
  commit?: string
  /** One sentence for the live region. */
  headline: string
  /** A reason or the relay's message. */
  detail?: string
  /** The stepper, while a build is starting, running or done. */
  phases?: LauncherPhase[]
  steps: LauncherStepView[]
  /** "1:05", ticking from the run's start (or from when the page saw the build start). */
  elapsed?: string
  /** "about 3 min", from the estimate. */
  usually?: string
  /** A percentage capped below 100 until live; `indeterminate` without an estimate. */
  progress?: { percent: number } | "indeterminate"
  /** The build log. */
  log?: string
  /** An older commit that is live now. */
  current?: { label: string; url: string }
  /** The Open button (when staying on Ready). */
  open?: { label: string; url: string }
  /** Offer Try again. */
  retry: boolean
  /** Open the preview by itself after `afterMs` (when not staying). */
  redirect?: { url: string; afterMs: number }
  /** Repaint every second (elapsed time). */
  ticking: boolean
}

const PHASES: { id: LauncherPhaseId; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "building", label: "Building" },
  { id: "publishing", label: "Publishing" },
  { id: "ready", label: "Ready" },
]

const phases = (at: number): LauncherPhase[] =>
  PHASES.map((phase, index) => ({
    ...phase,
    status: index < at ? "done" : index === at ? "current" : "todo",
  }))

/**
 * The view for `input` at `now`. `stay` keeps the page on Ready with an Open button;
 * `startedAt` (ms) is when the page saw the build start, for elapsed time before the relay has a
 * run; `pullRequest` titles states that carry none (reconnecting, busy).
 */
export function launcherView(
  input: LauncherInput,
  now: number,
  options: { stay?: boolean; startedAt?: number; pullRequest?: number } = {},
): LauncherView {
  const pullRequest = "pullRequest" in input ? input.pullRequest : options.pullRequest
  const launch = "pullRequest" in input ? input : undefined
  const view: LauncherView = {
    state: input.state,
    tone: "active",
    title: pullRequest === undefined ? "Pull request preview" : `Pull request #${pullRequest}`,
    headline: "",
    steps: [],
    retry: false,
    ticking: false,
  }
  if (launch?.head) view.commit = shortCommit(launch.head)
  if (launch?.live && launch.live.commit !== launch.head)
    view.current = {
      label: `Open the current version (${shortCommit(launch.live.commit)})`,
      url: launch.live.url,
    }
  const estimate = launch?.estimateSeconds
  const since = (iso: string | undefined) => {
    const at = iso ? Date.parse(iso) : options.startedAt
    return at === undefined || Number.isNaN(at) ? undefined : Math.max(0, (now - at) / 1000)
  }

  switch (input.state) {
    case "idle":
      view.headline = "Starting a build…"
      view.phases = phases(0)
      view.progress = "indeterminate"
      return view
    case "queued":
    case "building":
    case "publishing": {
      view.headline =
        input.state === "queued"
          ? "Waiting for a build machine…"
          : input.state === "building"
            ? "Building the preview…"
            : "Publishing the preview…"
      view.phases = phases(PHASES.findIndex((phase) => phase.id === input.state))
      view.steps = input.steps.map((step) => ({
        label: stepLabel(step.name),
        name: step.name,
        state: step.state,
      }))
      const seconds = since(input.run?.startedAt)
      if (seconds !== undefined) {
        view.elapsed = formatElapsed(seconds)
        view.ticking = true
      }
      if (estimate !== undefined) view.usually = roughly(estimate)
      view.progress =
        estimate !== undefined && seconds !== undefined
          ? { percent: Math.min(PROGRESS_CAP, Math.floor((seconds / estimate) * 100)) }
          : "indeterminate"
      if (input.run) view.log = input.run.url
      return view
    }
    case "live":
      view.tone = "ready"
      view.phases = phases(PHASES.length).map((phase) =>
        phase.id === "ready" ? { ...phase, status: "current" } : phase,
      )
      view.progress = { percent: 100 }
      view.commit = shortCommit(input.commit)
      if (options.stay) {
        view.headline = "The preview is ready."
        view.open = { label: "Open preview", url: input.url }
      } else {
        view.headline = "Ready. Opening the preview…"
        view.redirect = { url: input.url, afterMs: READY_DELAY_MS }
      }
      return view
    case "failed":
      view.tone = "failed"
      view.headline = "The build failed."
      view.detail = input.reason
      view.retry = input.retryable
      if (input.run) view.log = input.run.url
      return view
    case "unsupported":
    case "closed":
    case "unavailable":
      view.tone = "stopped"
      view.headline =
        input.state === "closed"
          ? "This pull request has no preview."
          : input.state === "unsupported"
            ? "This branch cannot build a preview yet."
            : "Previews are not available right now."
      view.detail = input.message
      return view
    case "loading":
      view.headline = "Checking the preview…"
      view.progress = "indeterminate"
      return view
    case "busy":
      view.tone = "reconnecting"
      view.headline = "Waiting for a free build slot…"
      view.detail = input.message
      return view
    case "reconnecting":
      view.tone = "reconnecting"
      view.headline = "Reconnecting…"
      view.detail = "The preview service did not answer. Trying again shortly."
      return view
  }
}
