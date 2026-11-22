/**
 * On-demand previews: build a pull request's preview only when someone opens it.
 *
 * `createBuildRelay()` is a Fetch handler a small trusted relay (an edge function) serves. A
 * launcher page polls `GET <relay>?pr=<n>` for the preview's `PreviewLaunch` and asks for a build
 * with `POST <relay>?pr=<n>`. The relay starts a build through a `BuildProvider` (the GitHub
 * Actions one is `createGitHubActionsProvider()`) and tells which commit is live from the
 * `preview-source.json` every build writes next to its index (`previewSourceLiveCommit()`).
 *
 * Security model: only open, same-repository pull requests are built, and only on their own
 * branch (so PR code never writes the base branch's caches). Answers carry the PR number, commits,
 * the run link and step names; never the token, the PR title, the branch name or a provider's
 * error body.
 *
 * Portable: Fetch and timers only; the clock and `fetch` are injected.
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
  /** The pull request's head commit (absent when the PR is missing or the relay is off). */
  head?: string
  /** An older commit that is live while the head is not, and its address. */
  live?: { commit: string; url: string }
  /** The usual build time, in seconds, when known. */
  estimateSeconds?: number
}

/** The state of a pull request's preview for its current head commit. */
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

export type PreviewLaunchState = PreviewLaunch["state"]

/** The fixed sentences a relay answers with. */
export const PREVIEW_LAUNCH_MESSAGES = {
  disabled: "On-demand previews are switched off.",
  noToken: "On-demand previews are not configured for this repository.",
  providerDown: "The build service is not answering. Trying again shortly.",
  overCap: "Too many previews are building right now. Try again in a few minutes.",
  attempts: (n: number) =>
    `This commit failed to build ${n} times. Push a new commit to try again.`,
  unsupported:
    "This branch predates on-demand previews. Merge the base branch into it, then open this page again.",
  closed: "This pull request is closed, merged, from a fork, or does not exist.",
  failed: "The build failed.",
  cancelled: "The build was cancelled.",
  notPublished: (minutes: number) =>
    `The build finished but was not published within ${minutes} minutes.`,
} as const

/** What a provider says about a pull request. `ref` stays inside the relay. */
export type BuildPullRequest = {
  state: "open" | "closed" | "merged"
  /** True when the head branch lives in another repository. */
  fork: boolean
  head: string
  ref: string
}

/** One CI run for a commit. */
export type BuildRun = {
  id: string
  status: "queued" | "in_progress" | "completed"
  /** For a completed run. */
  conclusion?: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | (string & {})
  url: string
  /** ISO times. */
  createdAt: string
  startedAt?: string
  /** When a completed run finished. */
  updatedAt?: string
}

/** One raw step as the provider names it. */
export type BuildStep = {
  name: string
  status: "queued" | "in_progress" | "completed" | (string & {})
  conclusion?: string | null
}

/** A CI system that can build a preview on demand. */
export type BuildProvider = {
  /** False when the provider has no credentials: the relay then answers `unavailable` without calling it. */
  readonly configured: boolean
  pullRequest(number: number): Promise<BuildPullRequest | undefined>
  /** Every on-demand run for `head`, any order. */
  runs(head: string): Promise<BuildRun[]>
  steps(run: BuildRun): Promise<BuildStep[]>
  /** Starts a build of `pr.head` on `pr.ref`. `"unsupported"` when the branch's workflow cannot take it. */
  dispatch(number: number, pr: BuildPullRequest): Promise<"dispatched" | "unsupported">
  /** On-demand builds queued or running across the repository. */
  active(): Promise<number>
  /** The usual build time in seconds, when known. */
  estimate?(): Promise<number | undefined>
}

/** Which commit a pull request's preview serves, and where. */
export type LiveCommit = (
  pullRequest: number,
) => Promise<{ commit: string; url: string } | undefined>

export type BuildRelayOptions = {
  provider: BuildProvider
  liveCommit: LiveCommit
  /** False switches the relay off (answers `unavailable`, calls nothing). Default true. */
  enabled?: boolean
  caps?: {
    /** Failed attempts (including failed publications) per commit before giving up. Default 3. */
    attempts?: number
    /** On-demand builds queued or running across the repository. Default 8. */
    concurrent?: number
    /** How long a successful build may take to go live. Default 600 000 ms. */
    publishMs?: number
  }
  /** Memo lifetimes. Defaults: state 3 000 ms, PR facts 30 000 ms, estimate 600 000 ms. */
  cache?: { stateMs?: number; pullRequestMs?: number; estimateMs?: number }
  /** How long a dispatch the provider does not list yet counts as queued. Default 120 000 ms. */
  dispatchGraceMs?: number
  /** A running step whose name matches means `publishing`. Default /publish|deploy/i. */
  publishStep?: RegExp
  /** Clock in ms. Default `Date.now`. */
  clock?: () => number
  /** `Access-Control-Allow-Origin` for a launcher on another origin. Default none (same origin). */
  allowOrigin?: string
}

/** A Fetch handler with the relay's state machine exposed for direct callers. */
export type BuildRelay = ((request: Request) => Promise<Response>) & {
  /** The state for `pullRequest`; with `start`, starts a build when none exists. */
  launch(pullRequest: number, start?: boolean): Promise<{ status: number; launch: PreviewLaunch }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const BOOKKEEPING = /^(?:Post |Complete job$)/

/** Maps a provider step to a launcher step; undefined for bookkeeping (`Post …`, `Complete job`). */
export function mapBuildStep(step: BuildStep): PreviewLaunchStep | undefined {
  if (BOOKKEEPING.test(step.name)) return undefined
  if (step.status !== "completed")
    return { name: step.name, state: step.status === "in_progress" ? "running" : "pending" }
  const conclusion = step.conclusion ?? "success"
  if (conclusion === "success" || conclusion === "neutral")
    return { name: step.name, state: "done" }
  if (conclusion === "skipped") return { name: step.name, state: "skipped" }
  return { name: step.name, state: "failed" }
}

/** Parses a relay answer; undefined unless it is a `PreviewLaunch` for `pullRequest`. */
export function parsePreviewLaunch(
  value: unknown,
  pullRequest?: number,
): PreviewLaunch | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.pullRequest !== "number" || !Number.isInteger(value.pullRequest))
    return undefined
  if (pullRequest !== undefined && value.pullRequest !== pullRequest) return undefined
  const text = (key: string) => typeof value[key] === "string"
  switch (value.state) {
    case "idle":
      return value as PreviewLaunch
    case "queued":
    case "building":
    case "publishing":
      return Array.isArray(value.steps) ? (value as PreviewLaunch) : undefined
    case "live":
      return text("commit") && text("url") ? (value as PreviewLaunch) : undefined
    case "failed":
      return text("reason") && typeof value.retryable === "boolean"
        ? (value as PreviewLaunch)
        : undefined
    case "unsupported":
    case "closed":
    case "unavailable":
      return text("message") ? (value as PreviewLaunch) : undefined
    default:
      return undefined
  }
}

type Memo<T> = { at: number; value: T }

/**
 * The on-demand build relay. `GET ?pr=<n>` answers the preview's `PreviewLaunch`; `POST ?pr=<n>`
 * starts a build of the head commit when none exists (HTTP 202), or answers HTTP 429 over the
 * concurrency cap. Provider failures answer HTTP 503 with `unavailable`.
 */
export function createBuildRelay(options: BuildRelayOptions): BuildRelay {
  const { provider } = options
  const clock = options.clock ?? Date.now
  const attempts = options.caps?.attempts ?? 3
  const concurrent = options.caps?.concurrent ?? 8
  const publishMs = options.caps?.publishMs ?? 600_000
  const stateMs = options.cache?.stateMs ?? 3_000
  const pullRequestMs = options.cache?.pullRequestMs ?? 30_000
  const estimateMs = options.cache?.estimateMs ?? 600_000
  const graceMs = options.dispatchGraceMs ?? 120_000
  const publishStep = options.publishStep ?? /publish|deploy/i

  const facts = new Map<number, Memo<BuildPullRequest | undefined>>()
  const states = new Map<number, Memo<{ status: number; launch: PreviewLaunch }>>()
  /** A dispatch the provider may not list yet: queued until a new run shows up or grace ends. */
  const pending = new Map<number, { head: string; at: number; runsBefore: number }>()
  const unsupported = new Map<number, string>()
  const locks = new Map<number, Promise<unknown>>()
  let estimate: Memo<number | undefined> | undefined

  const fresh = <T>(memo: Memo<T> | undefined, ms: number): memo is Memo<T> =>
    memo !== undefined && clock() - memo.at < ms

  const readFacts = async (number: number) => {
    const memo = facts.get(number)
    if (fresh(memo, pullRequestMs)) return memo.value
    const value = await provider.pullRequest(number)
    facts.set(number, { at: clock(), value })
    return value
  }

  const readEstimate = async () => {
    const previous = estimate?.value
    if (fresh(estimate, estimateMs)) return estimate.value
    let value: number | undefined
    try {
      value = await provider.estimate?.()
    } catch {
      value = previous
    }
    estimate = { at: clock(), value }
    return value
  }

  const serial = <T>(number: number, run: () => Promise<T>): Promise<T> => {
    const previous = locks.get(number) ?? Promise.resolve()
    const next = previous.then(run, run)
    const settled = next.catch(() => {})
    locks.set(number, settled)
    void settled.then(() => {
      if (locks.get(number) === settled) locks.delete(number)
    })
    return next
  }

  const runTime = (run: BuildRun) => Date.parse(run.startedAt ?? run.createdAt)
  const finished = (run: BuildRun) => Date.parse(run.updatedAt ?? run.startedAt ?? run.createdAt)
  const runLink = (run: BuildRun): PreviewLaunchRun => ({
    url: run.url,
    startedAt: new Date(runTime(run)).toISOString(),
  })

  const compute = async (
    number: number,
    start: boolean,
  ): Promise<{ status: number; launch: PreviewLaunch }> => {
    const base: PreviewLaunchBase = { pullRequest: number }
    if (options.enabled === false)
      return {
        status: 200,
        launch: { ...base, state: "unavailable", message: PREVIEW_LAUNCH_MESSAGES.disabled },
      }
    if (!provider.configured)
      return {
        status: 200,
        launch: { ...base, state: "unavailable", message: PREVIEW_LAUNCH_MESSAGES.noToken },
      }

    const pr = await readFacts(number)
    if (pr === undefined || pr.state !== "open" || pr.fork)
      return {
        status: 200,
        launch: { ...base, state: "closed", message: PREVIEW_LAUNCH_MESSAGES.closed },
      }
    const head = pr.head
    const [live, estimateSeconds] = await Promise.all([
      options.liveCommit(number).catch(() => undefined),
      readEstimate(),
    ])
    const known: PreviewLaunchBase = {
      ...base,
      head,
      ...(estimateSeconds === undefined ? {} : { estimateSeconds }),
    }
    if (live?.commit === head)
      return { status: 200, launch: { ...known, state: "live", commit: head, url: live.url } }
    const withLive: PreviewLaunchBase = live ? { ...known, live } : known
    if (unsupported.get(number) === head)
      return {
        status: 200,
        launch: { ...withLive, state: "unsupported", message: PREVIEW_LAUNCH_MESSAGES.unsupported },
      }

    const runs = (await provider.runs(head)).sort((a, b) => runTime(b) - runTime(a))
    const marker = pending.get(number)
    if (
      marker &&
      (marker.head !== head || runs.length > marker.runsBefore || clock() - marker.at > graceMs)
    )
      pending.delete(number)
    const waiting = pending.get(number)
    const queuedByUs = (): PreviewLaunch => ({ ...withLive, state: "queued", steps: [] })
    if (waiting) return { status: start ? 202 : 200, launch: queuedByUs() }

    const stale = (run: BuildRun) =>
      run.status === "completed" &&
      run.conclusion === "success" &&
      clock() - finished(run) > publishMs
    const failures = runs.filter(
      (run) => (run.status === "completed" && run.conclusion !== "success") || stale(run),
    ).length
    const latest = runs[0]

    if (latest && latest.status !== "completed") {
      const steps = (await provider.steps(latest))
        .map(mapBuildStep)
        .filter((step): step is PreviewLaunchStep => step !== undefined)
      const publishing = steps.some(
        (step) => step.state === "running" && publishStep.test(step.name),
      )
      const state = latest.status === "queued" ? "queued" : publishing ? "publishing" : "building"
      return { status: 200, launch: { ...withLive, state, run: runLink(latest), steps } }
    }
    if (latest && latest.conclusion === "success" && !stale(latest))
      return {
        status: 200,
        launch: { ...withLive, state: "publishing", run: runLink(latest), steps: [] },
      }
    if (failures >= attempts)
      return {
        status: 200,
        launch: {
          ...withLive,
          state: "unavailable",
          message: PREVIEW_LAUNCH_MESSAGES.attempts(failures),
        },
      }

    const failed: PreviewLaunch | undefined = latest
      ? {
          ...withLive,
          state: "failed",
          retryable: true,
          run: runLink(latest),
          reason: stale(latest)
            ? PREVIEW_LAUNCH_MESSAGES.notPublished(Math.round(publishMs / 60_000))
            : latest.conclusion === "cancelled"
              ? PREVIEW_LAUNCH_MESSAGES.cancelled
              : PREVIEW_LAUNCH_MESSAGES.failed,
        }
      : undefined
    if (!start) return { status: 200, launch: failed ?? { ...withLive, state: "idle" } }

    const pendingElsewhere = [...pending.values()].length
    if ((await provider.active()) + pendingElsewhere >= concurrent)
      return {
        status: 429,
        launch: { ...withLive, state: "unavailable", message: PREVIEW_LAUNCH_MESSAGES.overCap },
      }
    const answer = await provider.dispatch(number, pr)
    if (answer === "unsupported") {
      unsupported.set(number, head)
      return {
        status: 200,
        launch: { ...withLive, state: "unsupported", message: PREVIEW_LAUNCH_MESSAGES.unsupported },
      }
    }
    pending.set(number, { head, at: clock(), runsBefore: runs.length })
    return { status: 202, launch: queuedByUs() }
  }

  const launch = (number: number, start = false) =>
    serial(number, async () => {
      const memo = states.get(number)
      if (!start && fresh(memo, stateMs)) return memo.value
      let value: { status: number; launch: PreviewLaunch }
      try {
        value = await compute(number, start)
      } catch {
        // Never leak a provider's error: one fixed sentence, retried by the launcher.
        facts.delete(number)
        value = {
          status: 503,
          launch: {
            pullRequest: number,
            state: "unavailable",
            message: PREVIEW_LAUNCH_MESSAGES.providerDown,
          },
        }
      }
      states.set(number, {
        at: clock(),
        value: start ? { status: 200, launch: value.launch } : value,
      })
      return value
    })

  const headers = (): Record<string, string> => ({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(options.allowOrigin
      ? {
          "access-control-allow-origin": options.allowOrigin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          vary: "origin",
        }
      : {}),
  })
  const reply = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: headers() })

  const handler = async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() })
    if (request.method !== "GET" && request.method !== "POST")
      return reply({ error: "method not allowed" }, 405)
    const raw = new URL(request.url).searchParams.get("pr") ?? ""
    if (!/^[1-9][0-9]{0,9}$/.test(raw))
      return reply({ error: "pr must be a pull request number" }, 400)
    const result = await launch(Number(raw), request.method === "POST")
    return reply(result.launch, result.status)
  }
  return Object.assign(handler, { launch })
}

/** `preview-source.json`: what every build writes next to its index. */
export type PreviewSource = {
  commit: string
  pullRequest: number
  builtAt: string
  /** Optional per-app content pins (see `createBuildIdentity`). */
  parts?: Record<string, string>
}

export const PREVIEW_SOURCE_PATH = "preview-source.json"

/** Validates a `preview-source.json` body; undefined when malformed. */
export function parsePreviewSource(value: unknown): PreviewSource | undefined {
  if (!isRecord(value)) return undefined
  const { commit, pullRequest, builtAt, parts } = value
  if (typeof commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(commit)) return undefined
  if (typeof pullRequest !== "number" || !Number.isInteger(pullRequest) || pullRequest <= 0)
    return undefined
  if (typeof builtAt !== "string" || Number.isNaN(Date.parse(builtAt))) return undefined
  if (parts !== undefined) {
    if (!isRecord(parts) || Object.values(parts).some((pin) => typeof pin !== "string"))
      return undefined
  }
  return {
    commit,
    pullRequest,
    builtAt,
    ...(parts === undefined ? {} : { parts: parts as Record<string, string> }),
  }
}

/** The `preview-source.json` file a build writes next to its index, ready for a static deploy. */
export function createPreviewSourceFile(source: PreviewSource): {
  path: string
  bytes: Uint8Array
  contentType: string
} {
  const valid = parsePreviewSource(source)
  if (!valid) throw new Error("Invalid preview source")
  return {
    path: PREVIEW_SOURCE_PATH,
    bytes: new TextEncoder().encode(`${JSON.stringify(valid)}\n`),
    contentType: "application/json",
  }
}

/**
 * The default `liveCommit`: reads `preview-source.json` at `url(pr)` (the preview's address; the
 * file sits next to its index). Undefined when there is none, or it belongs to another PR.
 */
export function previewSourceLiveCommit(options: {
  url: (pullRequest: number) => string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}): LiveCommit {
  return async (pullRequest) => {
    const address = new URL(options.url(pullRequest))
    const response = await (options.fetch ?? fetch)(new URL(PREVIEW_SOURCE_PATH, address), {
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
    })
    if (!response.ok) return undefined
    const source = parsePreviewSource(await response.json().catch(() => undefined))
    if (!source || source.pullRequest !== pullRequest) return undefined
    return { commit: source.commit, url: address.href }
  }
}

export type GitHubActionsProviderOptions = {
  /** `owner/name`. */
  repository: string
  /** The workflow file name (`preview.yml`) or numeric id. */
  workflow: string
  /** A token that can read pull requests and actions and dispatch workflows. Empty means not configured. */
  token: string | undefined
  /** The `workflow_dispatch` input that receives the PR number. Default "pull_request". */
  input?: string
  /** Default "https://api.github.com". */
  apiUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

/** Thrown for any provider failure; its message never holds the provider's body or the token. */
export class BuildProviderError extends Error {
  constructor(
    operation: string,
    readonly status?: number,
  ) {
    super(`Build provider ${operation} failed${status ? ` (HTTP ${status})` : ""}`)
    this.name = "BuildProviderError"
  }
}

const RUN_STATUS = new Set(["queued", "in_progress", "completed"])
const QUEUED_ALIASES = new Set(["waiting", "pending", "requested"])

/**
 * A `BuildProvider` on GitHub Actions: dispatches a `workflow_dispatch` workflow on the PR's own
 * branch with its number as an input, and reads PR facts, runs and job steps from the REST API.
 */
export function createGitHubActionsProvider(options: GitHubActionsProviderOptions): BuildProvider {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository))
    throw new Error("repository must be owner/name")
  if (!options.workflow || /[/?#]/.test(options.workflow))
    throw new Error("workflow must be a file name or id")
  const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "")
  const repo = `/repos/${options.repository}`
  const workflow = `${repo}/actions/workflows/${encodeURIComponent(options.workflow)}`
  const input = options.input ?? "pull_request"
  const call = async (
    operation: string,
    path: string,
    init: RequestInit = {},
    allow: number[] = [],
  ): Promise<{ status: number; body: unknown }> => {
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(`${api}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${options.token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      })
    } catch {
      throw new BuildProviderError(operation)
    }
    if (!response.ok && !allow.includes(response.status))
      throw new BuildProviderError(operation, response.status)
    const body = response.status === 204 ? undefined : await response.json().catch(() => undefined)
    return { status: response.status, body }
  }
  const run = (value: unknown): BuildRun | undefined => {
    if (!isRecord(value)) return undefined
    const status = typeof value.status === "string" ? value.status : ""
    const normalized = RUN_STATUS.has(status) ? status : QUEUED_ALIASES.has(status) ? "queued" : ""
    if (!normalized || typeof value.html_url !== "string" || typeof value.created_at !== "string")
      return undefined
    return {
      id: String(value.id),
      status: normalized as BuildRun["status"],
      ...(typeof value.conclusion === "string" ? { conclusion: value.conclusion } : {}),
      url: value.html_url,
      createdAt: value.created_at,
      ...(typeof value.run_started_at === "string" ? { startedAt: value.run_started_at } : {}),
      ...(typeof value.updated_at === "string" ? { updatedAt: value.updated_at } : {}),
    }
  }
  const runs = (body: unknown) =>
    isRecord(body) && Array.isArray(body.workflow_runs)
      ? body.workflow_runs.map(run).filter((item): item is BuildRun => item !== undefined)
      : []
  const total = (body: unknown) =>
    isRecord(body) && typeof body.total_count === "number" ? body.total_count : 0

  return {
    configured: Boolean(options.token),
    async pullRequest(number) {
      const { status, body } = await call("pull request", `${repo}/pulls/${number}`, {}, [404])
      if (status === 404 || !isRecord(body)) return undefined
      const head = isRecord(body.head) ? body.head : {}
      const base = isRecord(body.base) ? body.base : {}
      const headRepo = isRecord(head.repo) ? head.repo.full_name : undefined
      const baseRepo = isRecord(base.repo) ? base.repo.full_name : options.repository
      if (typeof head.sha !== "string" || typeof head.ref !== "string") return undefined
      return {
        state:
          body.merged === true || body.merged_at
            ? "merged"
            : body.state === "open"
              ? "open"
              : "closed",
        fork:
          typeof headRepo !== "string" || headRepo.toLowerCase() !== String(baseRepo).toLowerCase(),
        head: head.sha,
        ref: head.ref,
      }
    },
    async runs(head) {
      const query = new URLSearchParams({
        head_sha: head,
        event: "workflow_dispatch",
        per_page: "30",
      })
      return runs((await call("runs", `${workflow}/runs?${query}`)).body)
    },
    async steps(item) {
      const { body } = await call(
        "jobs",
        `${repo}/actions/runs/${encodeURIComponent(item.id)}/jobs?per_page=30`,
      )
      if (!isRecord(body) || !Array.isArray(body.jobs)) return []
      return body.jobs.flatMap((job) =>
        isRecord(job) && Array.isArray(job.steps)
          ? job.steps
              .filter(
                (step): step is Record<string, unknown> =>
                  isRecord(step) && typeof step.name === "string",
              )
              .map((step) => ({
                name: step.name as string,
                status: typeof step.status === "string" ? step.status : "queued",
                conclusion: typeof step.conclusion === "string" ? step.conclusion : null,
              }))
          : [],
      )
    },
    async dispatch(number, pr) {
      const { status } = await call(
        "dispatch",
        `${workflow}/dispatches`,
        {
          method: "POST",
          body: JSON.stringify({ ref: pr.ref, inputs: { [input]: String(number) } }),
        },
        [422],
      )
      return status === 422 ? "unsupported" : "dispatched"
    },
    async active() {
      const count = async (status: string) => {
        const query = new URLSearchParams({ status, event: "workflow_dispatch", per_page: "1" })
        return total((await call("active runs", `${workflow}/runs?${query}`)).body)
      }
      const [queued, running] = await Promise.all([count("queued"), count("in_progress")])
      return queued + running
    },
    async estimate() {
      const query = new URLSearchParams({
        status: "success",
        event: "workflow_dispatch",
        per_page: "10",
      })
      const durations = runs((await call("estimate", `${workflow}/runs?${query}`)).body)
        .map(
          (item) =>
            (Date.parse(item.updatedAt ?? "") - Date.parse(item.startedAt ?? item.createdAt)) /
            1000,
        )
        .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
        .sort((a, b) => a - b)
      if (durations.length === 0) return undefined
      return Math.round(durations[Math.floor(durations.length / 2)] as number)
    },
  }
}
