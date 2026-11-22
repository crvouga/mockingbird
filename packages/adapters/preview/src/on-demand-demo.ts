/**
 * A simulated on-demand build service, for demos and stories: a `BuildProvider` whose builds take
 * a fixed time on the injected clock, behind the real `createBuildRelay()`, with controls to push a
 * commit, fail the next build, take the service offline and switch the token off.
 *
 * `createPreviewLaunchDemo()` answers the relay at any path and the controls at
 * `POST /demo/<key>`: `push`, `fail`, `offline`, `online`, `token-off`, `token-on`.
 *
 * Portable: no timers, everything is derived from the clock on each call.
 */

import {
  type BuildProvider,
  type BuildRelay,
  type BuildRun,
  type BuildStep,
  createBuildRelay,
} from "./on-demand.js"

export type PreviewLaunchDemoOptions = {
  /** Default 42. */
  pullRequest?: number
  /** Time a build runs, in seconds. Default 40. */
  buildSeconds?: number
  /** Time a build waits in the queue. Default 3. */
  queueSeconds?: number
  /** Time between a build finishing and its commit going live. Default 4. */
  publishSeconds?: number
  /** Start with an older commit live. Default true. */
  olderLive?: boolean
  /** The preview's address. Default `https://pr-<n>.preview.example/`. */
  url?: string
  clock?: () => number
}

export type PreviewLaunchDemoControl =
  | "push"
  | "fail"
  | "offline"
  | "online"
  | "token-off"
  | "token-on"

export const PREVIEW_LAUNCH_DEMO_CONTROLS: readonly PreviewLaunchDemoControl[] = [
  "push",
  "fail",
  "offline",
  "online",
  "token-off",
  "token-on",
]

const STEPS = [
  "Set up job",
  "Run actions/checkout@v4",
  "Run oven-sh/setup-bun@v2",
  "Run bun install --frozen-lockfile",
  "Run bun run build:preview",
  "Run bun run preview:publish",
  "Post Run actions/checkout@v4",
  "Complete job",
]

const commitFor = (n: number) => {
  let hash = ""
  let seed = 0x9e3779b9 ^ (n * 2654435761)
  while (hash.length < 40) {
    seed = (seed * 1103515245 + 12345) >>> 0
    hash += seed.toString(16).padStart(8, "0")
  }
  return hash.slice(0, 40)
}

export type PreviewLaunchDemo = {
  /** The relay plus the `/demo/<key>` controls. */
  fetch(request: Request): Promise<Response>
  relay: BuildRelay
  control(key: PreviewLaunchDemoControl): void
  /** The current head commit. */
  head(): string
  /** The commit live now, if any. */
  live(): string | undefined
  /** How many builds the relay dispatched. */
  dispatches(): number
}

export function createPreviewLaunchDemo(options: PreviewLaunchDemoOptions = {}): PreviewLaunchDemo {
  const clock = options.clock ?? Date.now
  const number = options.pullRequest ?? 42
  const buildMs = (options.buildSeconds ?? 40) * 1000
  const queueMs = (options.queueSeconds ?? 3) * 1000
  const publishMs = (options.publishSeconds ?? 4) * 1000
  const url = options.url ?? `https://pr-${number}.preview.example/`
  type SimRun = { id: number; commit: string; at: number; fails: boolean }
  let generation = 1
  let head = commitFor(generation)
  let baseLive: string | undefined = options.olderLive === false ? undefined : commitFor(0)
  const runs: SimRun[] = []
  let failNext = false
  let offline = false
  let token = true
  let dispatched = 0

  const phase = (run: SimRun) => {
    const age = clock() - run.at
    if (age < queueMs) return "queued" as const
    if (age < queueMs + buildMs) return "in_progress" as const
    return "completed" as const
  }
  const live = () => {
    let commit = baseLive
    let latest = -1
    for (const run of runs) {
      const done = run.at + queueMs + buildMs + publishMs
      if (!run.fails && clock() >= done && done > latest) {
        latest = done
        commit = run.commit
      }
    }
    return commit
  }
  const toRun = (run: SimRun): BuildRun => {
    const status = phase(run)
    const end = run.at + queueMs + buildMs
    return {
      id: String(run.id),
      status,
      ...(status === "completed" ? { conclusion: run.fails ? "failure" : "success" } : {}),
      url: `https://ci.example/runs/${run.id}`,
      createdAt: new Date(run.at).toISOString(),
      ...(status === "queued" ? {} : { startedAt: new Date(run.at + queueMs).toISOString() }),
      ...(status === "completed" ? { updatedAt: new Date(end).toISOString() } : {}),
    }
  }
  const guard = () => {
    if (offline) throw new Error("offline")
  }
  const provider: BuildProvider = {
    get configured() {
      return token
    },
    async pullRequest(n) {
      guard()
      return n === number ? { state: "open", fork: false, head, ref: "demo" } : undefined
    },
    async runs(commit) {
      guard()
      return runs.filter((run) => run.commit === commit).map(toRun)
    },
    async steps(item) {
      guard()
      const run = runs.find((candidate) => String(candidate.id) === item.id)
      if (!run) return []
      const progress =
        phase(run) === "queued" ? -1 : ((clock() - run.at - queueMs) / buildMs) * (STEPS.length - 2)
      return STEPS.map((name, index): BuildStep => {
        if (index >= STEPS.length - 2 || progress < index)
          return { name, status: "queued", conclusion: null }
        if (progress < index + 1) return { name, status: "in_progress", conclusion: null }
        return { name, status: "completed", conclusion: "success" }
      })
    },
    async dispatch() {
      guard()
      dispatched++
      runs.push({ id: runs.length + 1, commit: head, at: clock(), fails: failNext })
      failNext = false
      return "dispatched"
    },
    async active() {
      guard()
      return runs.filter((run) => phase(run) !== "completed").length
    },
    async estimate() {
      return Math.round((queueMs + buildMs) / 1000)
    },
  }
  const relay = createBuildRelay({
    provider,
    clock,
    cache: { stateMs: 0, pullRequestMs: 0 },
    dispatchGraceMs: 0,
    liveCommit: async (n) => {
      const commit = n === number ? live() : undefined
      return commit ? { commit, url } : undefined
    },
  })
  const control = (key: PreviewLaunchDemoControl) => {
    switch (key) {
      case "push":
        baseLive = live()
        generation++
        head = commitFor(generation)
        return
      case "fail":
        failNext = true
        return
      case "offline":
      case "online":
        offline = key === "offline"
        return
      case "token-off":
      case "token-on":
        token = key === "token-on"
        return
    }
  }
  return {
    relay,
    control,
    head: () => head,
    live,
    dispatches: () => dispatched,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      const match = /^\/demo\/([a-z-]+)$/.exec(pathname)
      if (match) {
        const key = match[1] as PreviewLaunchDemoControl
        if (request.method !== "POST" || !PREVIEW_LAUNCH_DEMO_CONTROLS.includes(key))
          return Response.json({ error: "unknown demo control" }, { status: 404 })
        control(key)
        return Response.json({ ok: true, head, live: live() ?? null })
      }
      if (offline) return Response.json({ error: "relay offline" }, { status: 503 })
      return relay(request)
    },
  }
}
