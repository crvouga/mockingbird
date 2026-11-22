import { describe, expect, test } from "bun:test"
import {
  type BuildProvider,
  type BuildPullRequest,
  type BuildRun,
  type BuildStep,
  createBuildRelay,
  createGitHubActionsProvider,
  createPreviewSourceFile,
  mapBuildStep,
  PREVIEW_LAUNCH_MESSAGES,
  parsePreviewLaunch,
  parsePreviewSource,
  previewSourceLiveCommit,
} from "./src/on-demand.js"
import { createPreviewLaunchDemo } from "./src/on-demand-demo.js"

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const OLD = "0f9e8d7c6b5a4938271605f4e3d2c1b0a9876543"
const T0 = Date.parse("2026-11-21T12:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()

/** A scripted provider: PR facts, runs, steps and dispatch answers, counting every call. */
function scripted(
  script: {
    pr?: BuildPullRequest | undefined
    runs?: BuildRun[]
    steps?: BuildStep[]
    dispatch?: "dispatched" | "unsupported"
    active?: number
    estimate?: number
    configured?: boolean
    fail?: boolean
  } = {},
) {
  const calls = {
    pullRequest: 0,
    runs: 0,
    steps: 0,
    dispatch: [] as unknown[],
    active: 0,
    estimate: 0,
  }
  const state = {
    pr:
      "pr" in script
        ? script.pr
        : ({ state: "open", fork: false, head: HEAD, ref: "feature/x" } as BuildPullRequest),
    runs: script.runs ?? [],
    steps: script.steps ?? [],
  }
  const guard = () => {
    if (script.fail) throw new Error("secret-token-xyz exploded: <html>raw body</html>")
  }
  const provider: BuildProvider = {
    configured: script.configured ?? true,
    async pullRequest() {
      calls.pullRequest++
      guard()
      return state.pr
    },
    async runs(head) {
      calls.runs++
      guard()
      return state.runs.filter(() => head === state.pr?.head)
    },
    async steps() {
      calls.steps++
      return state.steps
    },
    async dispatch(number, pr) {
      calls.dispatch.push({ number, ref: pr.ref })
      return script.dispatch ?? "dispatched"
    },
    async active() {
      calls.active++
      return script.active ?? 0
    },
    async estimate() {
      calls.estimate++
      return script.estimate
    },
  }
  return { provider, calls, state }
}

function relayWith(
  script: Parameters<typeof scripted>[0] = {},
  extra: { live?: { commit: string; url: string }; enabled?: boolean } = {},
) {
  let now = T0
  const fake = scripted(script)
  let live = extra.live
  const relay = createBuildRelay({
    provider: fake.provider,
    liveCommit: async () => live,
    clock: () => now,
    ...(extra.enabled === undefined ? {} : { enabled: extra.enabled }),
  })
  const call = async (method: "GET" | "POST", pr = 7) => {
    const response = await relay(new Request(`https://relay.example/launch?pr=${pr}`, { method }))
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      text: "",
    }
  }
  return {
    relay,
    call,
    ...fake,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
    setLive: (value: { commit: string; url: string } | undefined) => {
      live = value
    },
  }
}

const run = (patch: Partial<BuildRun> & Pick<BuildRun, "status">): BuildRun => ({
  id: "100",
  url: "https://github.com/o/r/actions/runs/100",
  createdAt: iso(T0 - 60_000),
  startedAt: iso(T0 - 55_000),
  ...patch,
})

describe("on-demand build relay", () => {
  test("1: idle until POST, which sends exactly one dispatch on the PR's branch and answers queued (202)", async () => {
    const t = relayWith()
    const get = await t.call("GET")
    expect(get.status).toBe(200)
    expect(get.body).toEqual({ pullRequest: 7, head: HEAD, state: "idle" })
    expect(t.calls.dispatch).toEqual([])
    const post = await t.call("POST")
    expect(post.status).toBe(202)
    expect(post.body).toMatchObject({ pullRequest: 7, head: HEAD, state: "queued", steps: [] })
    expect(t.calls.dispatch).toEqual([{ number: 7, ref: "feature/x" }])
  })

  test("2: a dispatch the provider does not list yet stays queued, with no second dispatch, even for concurrent callers", async () => {
    const t = relayWith()
    const answers = await Promise.all([t.call("POST"), t.call("POST"), t.call("POST")])
    expect(t.calls.dispatch).toHaveLength(1)
    for (const answer of answers) expect(answer.body.state).toBe("queued")
    t.advance(10_000)
    expect((await t.call("GET")).body.state).toBe("queued")
    expect((await t.call("POST")).body.state).toBe("queued")
    expect(t.calls.dispatch).toHaveLength(1)
  })

  test("3: queued and in-progress runs map steps and drop bookkeeping", async () => {
    const steps: BuildStep[] = [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "Run actions/checkout@v4", status: "completed", conclusion: "success" },
      { name: "Run lint", status: "completed", conclusion: "skipped" },
      { name: "Run bun run build", status: "in_progress", conclusion: null },
      { name: "Run tests", status: "queued", conclusion: null },
      { name: "Post Run actions/checkout@v4", status: "queued", conclusion: null },
      { name: "Complete job", status: "queued", conclusion: null },
    ]
    const t = relayWith({ runs: [run({ status: "in_progress" })], steps, estimate: 240 })
    const answer = await t.call("GET")
    expect(answer.body).toEqual({
      pullRequest: 7,
      head: HEAD,
      estimateSeconds: 240,
      state: "building",
      run: { url: "https://github.com/o/r/actions/runs/100", startedAt: iso(T0 - 55_000) },
      steps: [
        { name: "Set up job", state: "done" },
        { name: "Run actions/checkout@v4", state: "done" },
        { name: "Run lint", state: "skipped" },
        { name: "Run bun run build", state: "running" },
        { name: "Run tests", state: "pending" },
      ],
    })
    expect(mapBuildStep({ name: "x", status: "completed", conclusion: "failure" })).toEqual({
      name: "x",
      state: "failed",
    })
    const queued = relayWith({ runs: [run({ status: "queued" })] })
    expect((await queued.call("GET")).body.state).toBe("queued")
    const publishing = relayWith({
      runs: [run({ status: "in_progress" })],
      steps: [{ name: "Run bun run preview:publish", status: "in_progress" }],
    })
    expect((await publishing.call("GET")).body.state).toBe("publishing")
  })

  test("4: the head commit is live whatever the runs say", async () => {
    const t = relayWith(
      { runs: [run({ status: "completed", conclusion: "failure", updatedAt: iso(T0) })] },
      { live: { commit: HEAD, url: "https://pr-7.preview.example/" } },
    )
    const answer = await t.call("POST")
    expect(answer.body).toEqual({
      pullRequest: 7,
      head: HEAD,
      state: "live",
      commit: HEAD,
      url: "https://pr-7.preview.example/",
    })
    expect(t.calls.dispatch).toEqual([])
    // An older live commit is offered while the head is not live.
    const older = relayWith({}, { live: { commit: OLD, url: "https://pr-7.preview.example/" } })
    expect((await older.call("GET")).body).toMatchObject({
      state: "idle",
      live: { commit: OLD, url: "https://pr-7.preview.example/" },
    })
  })

  test("5: a successful run not live after the limit is a failed publication", async () => {
    const t = relayWith({
      runs: [run({ status: "completed", conclusion: "success", updatedAt: iso(T0) })],
    })
    expect((await t.call("GET")).body.state).toBe("publishing")
    t.advance(600_001)
    expect((await t.call("GET")).body).toMatchObject({
      state: "failed",
      retryable: true,
      reason: PREVIEW_LAUNCH_MESSAGES.notPublished(10),
    })
  })

  test("6: a failed run can be retried; N failed attempts make the commit unavailable", async () => {
    const failed = run({ status: "completed", conclusion: "failure", updatedAt: iso(T0 - 1000) })
    const t = relayWith({ runs: [failed] })
    expect((await t.call("GET")).body).toMatchObject({
      state: "failed",
      reason: PREVIEW_LAUNCH_MESSAGES.failed,
    })
    expect((await t.call("POST")).status).toBe(202)
    expect(t.calls.dispatch).toHaveLength(1)
    const cancelled = relayWith({
      runs: [run({ status: "completed", conclusion: "cancelled", updatedAt: iso(T0) })],
    })
    expect((await cancelled.call("GET")).body.reason).toBe(PREVIEW_LAUNCH_MESSAGES.cancelled)

    const stalePublication = run({
      id: "3",
      status: "completed",
      conclusion: "success",
      updatedAt: iso(T0 - 700_000),
      createdAt: iso(T0 - 900_000),
      startedAt: iso(T0 - 900_000),
    })
    const exhausted = relayWith({
      runs: [
        run({
          id: "1",
          status: "completed",
          conclusion: "failure",
          createdAt: iso(T0 - 3_000_000),
          startedAt: iso(T0 - 3_000_000),
        }),
        run({
          id: "2",
          status: "completed",
          conclusion: "timed_out",
          createdAt: iso(T0 - 2_000_000),
          startedAt: iso(T0 - 2_000_000),
        }),
        stalePublication,
      ],
    })
    const answer = await exhausted.call("POST")
    expect(answer.body).toMatchObject({
      state: "unavailable",
      message: PREVIEW_LAUNCH_MESSAGES.attempts(3),
    })
    expect(exhausted.calls.dispatch).toEqual([])
  })

  test("7: at the concurrency cap POST answers 429 unavailable and dispatches nothing", async () => {
    const t = relayWith({ active: 8 })
    const answer = await t.call("POST")
    expect(answer.status).toBe(429)
    expect(answer.body).toMatchObject({
      state: "unavailable",
      message: PREVIEW_LAUNCH_MESSAGES.overCap,
    })
    expect(t.calls.dispatch).toEqual([])
  })

  test("8: a refused dispatch (422) is unsupported and says to merge the base branch", async () => {
    const t = relayWith({ dispatch: "unsupported" })
    const answer = await t.call("POST")
    expect(answer.body).toMatchObject({ state: "unsupported" })
    expect(String(answer.body.message)).toContain("Merge the base branch")
    expect((await t.call("POST")).body.state).toBe("unsupported")
    expect(t.calls.dispatch).toHaveLength(1)
  })

  test("9: closed, merged, fork and missing pull requests are closed and never dispatched", async () => {
    for (const pr of [
      { state: "closed", fork: false, head: HEAD, ref: "x" },
      { state: "merged", fork: false, head: HEAD, ref: "x" },
      { state: "open", fork: true, head: HEAD, ref: "x" },
      undefined,
    ] as const) {
      const t = relayWith({ pr })
      const answer = await t.call("POST")
      expect(answer.body).toEqual({
        pullRequest: 7,
        state: "closed",
        message: PREVIEW_LAUNCH_MESSAGES.closed,
      })
      expect(t.calls.dispatch).toEqual([])
    }
  })

  test("10: no token or a switched-off relay is unavailable with a fixed message and no provider call", async () => {
    const off = relayWith({}, { enabled: false })
    expect((await off.call("POST")).body).toEqual({
      pullRequest: 7,
      state: "unavailable",
      message: PREVIEW_LAUNCH_MESSAGES.disabled,
    })
    const noToken = relayWith({ configured: false })
    expect((await noToken.call("POST")).body).toEqual({
      pullRequest: 7,
      state: "unavailable",
      message: PREVIEW_LAUNCH_MESSAGES.noToken,
    })
    for (const t of [off, noToken]) {
      expect(t.calls).toMatchObject({
        pullRequest: 0,
        runs: 0,
        steps: 0,
        dispatch: [],
        active: 0,
        estimate: 0,
      })
    }
  })

  test("11: answers never carry the token, raw provider errors, the PR title or branch", async () => {
    const down = relayWith({ fail: true })
    const answer = await down.call("GET")
    expect(answer.status).toBe(503)
    expect(answer.body).toEqual({
      pullRequest: 7,
      state: "unavailable",
      message: PREVIEW_LAUNCH_MESSAGES.providerDown,
    })
    expect(JSON.stringify(answer.body)).not.toContain("secret-token")

    let sent: Request | undefined
    const github = createGitHubActionsProvider({
      repository: "o/r",
      workflow: "preview.yml",
      token: "ghs_SECRET",
      fetch: async (input, init) => {
        sent = new Request(input, init)
        return new Response("<html>ghs_SECRET internal</html>", { status: 500 })
      },
    })
    const error = await github.pullRequest(7).catch((caught: Error) => caught)
    expect(String(error)).toBe("BuildProviderError: Build provider pull request failed (HTTP 500)")
    expect(sent?.headers.get("authorization")).toBe("Bearer ghs_SECRET")

    const t = relayWith({
      pr: { state: "open", fork: false, head: HEAD, ref: "secret-branch-name" },
      runs: [run({ status: "in_progress" })],
    })
    for (const method of ["GET", "POST"] as const) {
      const body = JSON.stringify((await t.call(method)).body)
      expect(body).not.toContain("secret-branch-name")
      expect(body).not.toContain("title")
    }
  })

  test("12: GET state is memoized for seconds, PR facts for ~30 s and the estimate for ~10 min", async () => {
    const t = relayWith({ runs: [run({ status: "in_progress" })], estimate: 200 })
    await t.call("GET")
    await t.call("GET")
    expect(t.calls).toMatchObject({ pullRequest: 1, runs: 1, steps: 1, estimate: 1 })
    t.advance(5_000)
    await t.call("GET")
    expect(t.calls).toMatchObject({ pullRequest: 1, runs: 2, steps: 2, estimate: 1 })
    t.advance(26_000)
    await t.call("GET")
    expect(t.calls).toMatchObject({ pullRequest: 2, runs: 3, steps: 3, estimate: 1 })
    t.advance(600_000)
    await t.call("GET")
    expect(t.calls.estimate).toBe(2)
  })

  test("rejects a missing or malformed PR number and unknown methods", async () => {
    const t = relayWith()
    for (const pr of ["", "0", "007", "x", "-1"]) {
      const response = await t.relay(new Request(`https://relay.example/?pr=${pr}`))
      expect(response.status).toBe(400)
    }
    expect(
      (await t.relay(new Request("https://relay.example/?pr=1", { method: "DELETE" }))).status,
    ).toBe(405)
    expect(t.calls.pullRequest).toBe(0)
  })
})

describe("GitHub Actions provider", () => {
  const api = (routes: Record<string, (init: RequestInit) => Response>) => {
    const seen: { method: string; url: string; body?: unknown }[] = []
    const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      seen.push({
        method: init.method ?? "GET",
        url,
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      })
      const path = url.replace("https://api.github.com", "")
      const route = Object.keys(routes).find((key) => path.startsWith(key))
      return route
        ? (routes[route] as (init: RequestInit) => Response)(init)
        : new Response("{}", { status: 404 })
    }
    return { fetch, seen }
  }

  test("reads PR facts, runs and steps, dispatches on the PR's branch and counts active builds", async () => {
    const { fetch, seen } = api({
      "/repos/o/r/pulls/7": () =>
        Response.json({
          state: "open",
          merged: false,
          title: "Secret",
          head: { sha: HEAD, ref: "feat", repo: { full_name: "o/r" } },
          base: { repo: { full_name: "o/r" } },
        }),
      "/repos/o/r/actions/workflows/preview.yml/runs?head_sha": () =>
        Response.json({
          workflow_runs: [
            {
              id: 5,
              status: "in_progress",
              html_url: "https://github.com/o/r/actions/runs/5",
              created_at: iso(T0),
              run_started_at: iso(T0),
            },
          ],
        }),
      "/repos/o/r/actions/runs/5/jobs": () =>
        Response.json({
          jobs: [{ steps: [{ name: "Set up job", status: "completed", conclusion: "success" }] }],
        }),
      "/repos/o/r/actions/workflows/preview.yml/dispatches": () =>
        new Response(null, { status: 204 }),
      "/repos/o/r/actions/workflows/preview.yml/runs?status=queued": () =>
        Response.json({ total_count: 2 }),
      "/repos/o/r/actions/workflows/preview.yml/runs?status=in_progress": () =>
        Response.json({ total_count: 3 }),
      "/repos/o/r/actions/workflows/preview.yml/runs?status=success": () =>
        Response.json({
          workflow_runs: [100, 200, 300].map((seconds, id) => ({
            id,
            status: "completed",
            conclusion: "success",
            html_url: "https://x",
            created_at: iso(T0),
            run_started_at: iso(T0),
            updated_at: iso(T0 + seconds * 1000),
          })),
        }),
    })
    const github = createGitHubActionsProvider({
      repository: "o/r",
      workflow: "preview.yml",
      token: "t",
      fetch,
    })
    const pr = await github.pullRequest(7)
    expect(pr).toEqual({ state: "open", fork: false, head: HEAD, ref: "feat" })
    const runs = await github.runs(HEAD)
    expect(runs).toEqual([
      {
        id: "5",
        status: "in_progress",
        url: "https://github.com/o/r/actions/runs/5",
        createdAt: iso(T0),
        startedAt: iso(T0),
      },
    ])
    expect(await github.steps(runs[0] as BuildRun)).toEqual([
      { name: "Set up job", status: "completed", conclusion: "success" },
    ])
    expect(await github.dispatch(7, pr as BuildPullRequest)).toBe("dispatched")
    expect(seen.find((call) => call.method === "POST")?.body).toEqual({
      ref: "feat",
      inputs: { pull_request: "7" },
    })
    expect(await github.active()).toBe(5)
    expect(await github.estimate?.()).toBe(200)
    expect(github.configured).toBe(true)
    expect(
      createGitHubActionsProvider({ repository: "o/r", workflow: "p.yml", token: "" }).configured,
    ).toBe(false)
  })

  test("a fork, a merged PR and a 422 dispatch", async () => {
    const { fetch } = api({
      "/repos/o/r/pulls/1": () =>
        Response.json({
          state: "open",
          head: { sha: HEAD, ref: "f", repo: { full_name: "someone/r" } },
          base: { repo: { full_name: "o/r" } },
        }),
      "/repos/o/r/pulls/2": () =>
        Response.json({
          state: "closed",
          merged: true,
          head: { sha: HEAD, ref: "f", repo: { full_name: "o/r" } },
          base: { repo: { full_name: "o/r" } },
        }),
      "/repos/o/r/actions/workflows/preview.yml/dispatches": () =>
        Response.json({ message: "Unexpected inputs provided" }, { status: 422 }),
    })
    const github = createGitHubActionsProvider({
      repository: "o/r",
      workflow: "preview.yml",
      token: "t",
      fetch,
    })
    expect((await github.pullRequest(1))?.fork).toBe(true)
    expect((await github.pullRequest(2))?.state).toBe("merged")
    expect(await github.pullRequest(3)).toBeUndefined()
    expect(await github.dispatch(1, { state: "open", fork: false, head: HEAD, ref: "f" })).toBe(
      "unsupported",
    )
  })
})

describe("preview-source.json and parsing", () => {
  test("liveCommit reads preview-source.json next to the index", async () => {
    const file = createPreviewSourceFile({ commit: HEAD, pullRequest: 7, builtAt: iso(T0) })
    expect(file.path).toBe("preview-source.json")
    const urls: string[] = []
    const live = previewSourceLiveCommit({
      url: (pr) => `https://pr-${pr}.preview.example/`,
      fetch: async (input) => {
        urls.push(String(input))
        return new Response(new Uint8Array(file.bytes))
      },
    })
    expect(await live(7)).toEqual({ commit: HEAD, url: "https://pr-7.preview.example/" })
    expect(urls).toEqual(["https://pr-7.preview.example/preview-source.json"])
    expect(await live(8)).toBeUndefined()
    const missing = previewSourceLiveCommit({
      url: () => "https://x.example/",
      fetch: async () => new Response("", { status: 404 }),
    })
    expect(await missing(7)).toBeUndefined()
    expect(parsePreviewSource({ commit: "nope", pullRequest: 7, builtAt: iso(T0) })).toBeUndefined()
  })

  test("parsePreviewLaunch accepts only a launch for this pull request", () => {
    expect(parsePreviewLaunch({ pullRequest: 7, state: "idle" }, 7)).toEqual({
      pullRequest: 7,
      state: "idle",
    })
    expect(parsePreviewLaunch({ pullRequest: 8, state: "idle" }, 7)).toBeUndefined()
    expect(parsePreviewLaunch({ pullRequest: 7, state: "building" }, 7)).toBeUndefined()
    expect(parsePreviewLaunch("<html>", 7)).toBeUndefined()
  })
})

describe("simulated relay (demo)", () => {
  test("a timed build goes idle → queued → building → publishing → live, and the controls work", async () => {
    let now = T0
    const demo = createPreviewLaunchDemo({
      clock: () => now,
      buildSeconds: 10,
      queueSeconds: 2,
      publishSeconds: 2,
      pullRequest: 5,
    })
    const call = async (method = "GET", path = "/launch?pr=5") =>
      (await (
        await demo.fetch(new Request(`https://demo.example${path}`, { method }))
      ).json()) as Record<string, unknown>
    expect((await call()).state).toBe("idle")
    expect((await call("POST")).state).toBe("queued")
    now += 3_000
    expect((await call()).state).toBe("building")
    now += 10_000
    expect((await call()).state).toBe("publishing")
    now += 2_000
    expect(await call()).toMatchObject({ state: "live", commit: demo.head() })
    await call("POST", "/demo/push")
    expect(await call()).toMatchObject({ state: "idle", live: { commit: demo.live() } })
    await call("POST", "/demo/fail")
    await call("POST")
    now += 15_000
    expect((await call()).state).toBe("failed")
    await call("POST", "/demo/token-off")
    expect((await call()).message).toBe(PREVIEW_LAUNCH_MESSAGES.noToken)
    await call("POST", "/demo/token-on")
    await call("POST", "/demo/offline")
    expect((await demo.fetch(new Request("https://demo.example/?pr=5"))).status).toBe(503)
    expect(demo.dispatches()).toBe(2)
  })
})
