import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertAssetsOnlyConfig, parseJsonc } from "./src/assets-only.js"
import { runPreviewCli } from "./src/cli-main.js"
import type { PreviewCliDeps } from "./src/cli-previews.js"
import { createPreviewGitHub } from "./src/github.js"
import {
  PREVIEW_SECTION_END,
  PREVIEW_SECTION_START,
  readPreviewSection,
  stripPreviewSection,
  upsertPreviewSection,
} from "./src/pr-section.js"
import {
  checkUntilPassing,
  type PreviewChecks,
  previewGateUploads,
  waitUntilServing,
} from "./src/serving.js"
import { deployPreviewSite } from "./src/site.js"

const root = mkdtempSync(join(tmpdir(), "mockingbird-named-previews-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dirs = 0
const site = (files: Record<string, string> = { "index.html": "<h1>hi</h1>" }) => {
  const dir = join(root, `site-${dirs++}`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
  Response.json({ success: true, result, ...extra })

/** An in-memory Cloudflare (named Previews of one Worker), GitHub and edge, behind one fetch. */
const world = (options: { head?: string; open?: number[]; body?: string } = {}) => {
  const calls: string[] = []
  let clock = Date.parse("2026-11-21T00:00:00Z")
  const previews = new Map<string, { id: string; name: string; updated_on: string }>()
  const served = new Map<string, string>()
  const state = {
    head: options.head ?? "commit-a",
    prState: "open",
    body: options.body ?? "Author text",
    deployments: [] as { id: number; environment: string; statuses: unknown[] }[],
    nextId: 1,
    /** Commits the edge reports before it moves to the deployed one. */
    lag: 0,
    keepDeleted: false,
  }
  const fetch = async (input: string, init: RequestInit = {}) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const method = request.method
    calls.push(`${method} ${url.host}${url.pathname}`)
    if (url.host === "api.cloudflare.com") {
      const path = url.pathname.replace("/client/v4/accounts/acct", "")
      const match = path.match(/^\/workers\/workers\/site\/previews(?:\/([^/]+))?(\/.*)?$/)
      if (path === "/workers/scripts/site/assets-upload-session")
        return ok({ jwt: "done", buckets: [] })
      if (!match) return new Response(null, { status: 418 })
      const [, name, rest] = match
      if (!name && method === "GET")
        return ok([...previews.values()], { result_info: { total_pages: 1 } })
      if (!name && method === "POST") {
        const body = (await request.json()) as { name: string }
        const created = {
          id: `id-${body.name}`,
          name: body.name,
          updated_on: "2026-11-20T00:00:00Z",
          urls: [`https://${body.name}-site.acct.workers.dev`],
        }
        previews.set(body.name, created)
        return ok(created)
      }
      const preview = [...previews.values()].find((p) => p.name === name || p.id === name)
      if (method === "DELETE") {
        if (preview && !state.keepDeleted) previews.delete(preview.name)
        return ok(null)
      }
      if (!preview) return new Response(null, { status: 404 })
      if (!rest) return ok(preview)
      if (rest === "/deployments/latest") return new Response(null, { status: 404 })
      if (rest === "/deployments" && method === "POST") {
        const metadata = JSON.parse(String((await request.formData()).get("metadata"))) as {
          annotations: Record<string, string>
        }
        served.set(preview.name, metadata.annotations["workers/commit_sha"] as string)
        return ok({ id: `deployment-${preview.name}` })
      }
    }
    if (url.host === "api.github.com") {
      const path = url.pathname.replace("/repos/owner/repo", "")
      if (path === "/pulls/12" && method === "GET")
        return Response.json({
          state: state.prState,
          body: state.body,
          base: { repo: { full_name: "owner/repo" } },
          head: { sha: state.head, repo: { full_name: "owner/repo" } },
        })
      if (path === "/pulls/12" && method === "PATCH") {
        state.body = ((await request.json()) as { body: string }).body
        return Response.json({})
      }
      if (path === "/pulls")
        return Response.json((options.open ?? [12]).map((number) => ({ number })))
      if (path === "/branches/main") return Response.json({ commit: { sha: state.head } })
      if (path === "/deployments" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>
        expect(body.transient_environment).toBe(true)
        const deployment = {
          id: state.nextId++,
          environment: String(body.environment),
          statuses: [],
        }
        state.deployments.push(deployment)
        return Response.json({ id: deployment.id })
      }
      if (path === "/deployments" && method === "GET")
        return Response.json(
          state.deployments
            .filter((d) => d.environment === url.searchParams.get("environment"))
            .reverse(),
        )
      const status = path.match(/^\/deployments\/(\d+)\/statuses$/)
      if (status) {
        state.deployments
          .find((d) => d.id === Number(status[1]))
          ?.statuses.push(await request.json())
        return Response.json({})
      }
      const remove = path.match(/^\/deployments\/(\d+)$/)
      if (remove && method === "DELETE") {
        state.deployments = state.deployments.filter((d) => d.id !== Number(remove[1]))
        return new Response(null, { status: 204 })
      }
    }
    if (url.pathname === "/version.json") {
      const name = url.host.split(".")[0]?.replace(/-site$/, "") ?? ""
      if (state.lag > 0) {
        state.lag--
        return Response.json({ version: "older" })
      }
      return Response.json({ version: served.get(name) ?? "none" })
    }
    if (url.pathname === "/") return new Response("<h1>hi</h1>")
    return new Response(null, { status: 404 })
  }
  const deps: PreviewCliDeps = {
    env: {
      CLOUDFLARE_API_TOKEN: "cf",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      GITHUB_TOKEN: "gh",
    },
    fetch,
    // A fake clock: polling deadlines pass without waiting.
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  }
  return { calls, previews, served, state, deps, fetch }
}

const io = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
  }
}

const deployArgs = (outdir: string, extra: string[] = []) => [
  "deploy-preview",
  "--worker",
  "site",
  "--outdir",
  outdir,
  "--commit",
  "commit-a",
  "--pr",
  "12",
  "--repository",
  "owner/repo",
  ...extra,
]

describe("#856 named Previews of one assets-only Worker", () => {
  test("1. deploys Preview pr-<n> of the given Worker, never a Worker script or a per-PR Worker", async () => {
    const w = world()
    const outdir = site()
    const result = join(root, "result-856.json")
    const { out, io: sink } = io()
    const code = await runPreviewCli(deployArgs(outdir, ["--result", result]), sink, w.deps)
    expect(code).toBe(0)
    expect(w.served.get("pr-12")).toBe("commit-a")
    expect(w.calls).toContain(
      "POST api.cloudflare.com/client/v4/accounts/acct/workers/workers/site/previews/id-pr-12/deployments",
    )
    // No script upload, no wrangler deploy, no `<name>-pr-<n>` Worker.
    expect(w.calls.some((call) => /\/workers\/scripts\/[^/]+$/.test(call))).toBe(false)
    expect(w.calls.some((call) => call.includes("site-pr-12"))).toBe(false)
    const written = JSON.parse(readFileSync(result, "utf8"))
    expect(written).toMatchObject({
      site: "site",
      name: "pr-12",
      state: "live",
      deployed: "commit-a",
    })
    expect(written.url).toBe("https://pr-12-site.acct.workers.dev")
    expect(JSON.parse(readFileSync(join(outdir, "version.json"), "utf8")).version).toBe("commit-a")
    expect(out.at(-1)).toContain("live")
  })

  test("1. serves at pr-<n>.<host> through the custom domain, falling back to workers.dev while its certificate issues", async () => {
    const w = world()
    const custom = async (input: string, init?: RequestInit) => {
      if (new URL(input).host === "pr-12.preview.example.com") {
        if (custom.ready) return Response.json({ version: "commit-a" })
        throw new TypeError("certificate not yet issued")
      }
      return w.fetch(input, init)
    }
    custom.ready = false
    const run = async () => {
      const result = join(root, `result-host-${custom.ready}.json`)
      await runPreviewCli(
        deployArgs(site(), ["--host", "preview.example.com", "--result", result]),
        io().io,
        { ...w.deps, fetch: custom },
      )
      return JSON.parse(readFileSync(result, "utf8")).url
    }
    expect(await run()).toBe("https://pr-12-site.acct.workers.dev")
    custom.ready = true
    expect(await run()).toBe("https://pr-12.preview.example.com")
  })

  test("2. a closed pull request's Preview is deleted and confirmed gone", async () => {
    const w = world()
    await runPreviewCli(deployArgs(site()), io().io, w.deps)
    expect(w.previews.has("pr-12")).toBe(true)
    const { out, io: sink } = io()
    expect(
      await runPreviewCli(["remove-preview", "--worker", "site", "--pr", "12"], sink, w.deps),
    ).toBe(0)
    expect(w.previews.has("pr-12")).toBe(false)
    expect(out.join("\n")).toContain("confirmed gone")

    const stuck = world()
    await runPreviewCli(deployArgs(site()), io().io, stuck.deps)
    stuck.state.keepDeleted = true
    const failed = io()
    expect(
      await runPreviewCli(
        ["remove-preview", "--worker", "site", "--pr", "12"],
        failed.io,
        stuck.deps,
      ),
    ).toBe(1)
    expect(failed.err.join("\n")).toContain("still listed")
  })

  test("2. a deploy for a pull request that closed meanwhile removes its Preview instead", async () => {
    const w = world()
    await runPreviewCli(deployArgs(site()), io().io, w.deps)
    w.state.prState = "closed"
    const result = join(root, "result-closed.json")
    expect(await runPreviewCli(deployArgs(site(), ["--result", result]), io().io, w.deps)).toBe(0)
    expect(JSON.parse(readFileSync(result, "utf8")).state).toBe("removed")
    expect(w.previews.has("pr-12")).toBe(false)
  })

  test("3. refuses a Worker config that declares anything but static files", async () => {
    expect(
      assertAssetsOnlyConfig({
        name: "site",
        compatibility_date: "2026-11-01",
        assets: { directory: "dist", not_found_handling: "single-page-application" },
      }),
    ).toEqual({ compatibilityDate: "2026-11-01", notFoundHandling: "single-page-application" })
    for (const [config, offending] of [
      [{ main: "worker.js", assets: { directory: "dist" } }, "main"],
      [{ assets: { directory: "dist", binding: "ASSETS" } }, "assets.binding"],
      [{ vars: { A: "1" } }, "vars"],
      [{ assets: { directory: "dist", run_worker_first: ["/api/*"] } }, "assets.run_worker_first"],
      [{ kv_namespaces: [{ binding: "KV", id: "x" }] }, "kv_namespaces"],
      [{ durable_objects: { bindings: [{ name: "D" }] } }, "durable_objects"],
    ] as const)
      expect(() => assertAssetsOnlyConfig(config)).toThrow(offending)

    const w = world()
    const config = join(root, "wrangler.jsonc")
    writeFileSync(
      config,
      `{
  // an older per-PR Worker config
  "name": "site",
  "main": "worker.js",
  "assets": { "directory": "dist", "run_worker_first": ["/__preview/*"], },
}`,
    )
    expect(parseJsonc(readFileSync(config, "utf8"))).toMatchObject({ main: "worker.js" })
    const { err, io: sink } = io()
    expect(await runPreviewCli(deployArgs(site(), ["--config", config]), sink, w.deps)).toBe(1)
    expect(err.join("\n")).toContain("static files only")
    expect(w.calls).toEqual([])
  })

  test("4. the docs say /__preview/* live status is unavailable in this mode", () => {
    const docs = readFileSync(join(import.meta.dir, "../../../docs/PREVIEWS.md"), "utf8")
    expect(docs).toMatch(/named-previews[\s\S]*`\/__preview\/\*`[\s\S]*not available/)
  })
})

describe("#858 PR description section and GitHub Deployments", () => {
  const facts = {
    state: "live" as const,
    sites: [
      { name: "app", url: "https://pr-12.app.example.com", state: "live" as const },
      { name: "storybook", url: "https://pr-12.storybook.example.com", state: "live" as const },
    ],
    attempted: "aaaaaaa1111",
    deployed: "aaaaaaa1111",
    runUrl: "https://github.com/owner/repo/actions/runs/9",
    repository: "owner/repo",
  }

  test("1. owns one block at the very top and never changes the author's text", () => {
    const author = "## Summary\n\nAuthor text <!-- a comment -->\n\n- item\n"
    const once = upsertPreviewSection(author, facts)
    expect(once.startsWith(PREVIEW_SECTION_START)).toBe(true)
    expect(once).toContain(PREVIEW_SECTION_END)
    expect(once).toContain("**Preview:** Live")
    expect(once).toContain("[Open](https://pr-12.app.example.com)")
    expect(once).toContain("[Open](https://pr-12.storybook.example.com)")
    expect(once).toContain("[run](https://github.com/owner/repo/actions/runs/9)")
    expect(once).toContain("/owner/repo/commit/aaaaaaa1111")
    expect(stripPreviewSection(once)).toBe(author)
    const twice = upsertPreviewSection(once, { ...facts, state: "deploying" })
    expect(twice.match(/preview:start/g)?.length).toBe(1)
    expect(stripPreviewSection(twice)).toBe(author)
    // A block the author moved down is put back on top.
    const moved = `${author}\n${once.slice(0, once.indexOf(PREVIEW_SECTION_END) + PREVIEW_SECTION_END.length)}`
    const fixed = upsertPreviewSection(moved, facts)
    expect(fixed.startsWith(PREVIEW_SECTION_START)).toBe(true)
    expect(fixed.match(/preview:start/g)?.length).toBe(1)
    for (const [state, label] of [
      ["deploying", "Deploying"],
      ["failing-checks", "Deployed, but failing its checks"],
      ["failed", "Failed"],
      ["removed", "Removed"],
      ["expired", "Expired"],
    ] as const)
      expect(upsertPreviewSection("", { ...facts, state })).toContain(`**Preview:** ${label}`)
    expect(upsertPreviewSection(null, facts).endsWith(`${PREVIEW_SECTION_END}\n\n`)).toBe(true)
  })

  test("2. each deploy is a Deployment in a transient environment; earlier ones go inactive and are deleted; removal deletes all", async () => {
    const w = world()
    const gh = createPreviewGitHub({ token: "gh", repository: "owner/repo", fetch: w.fetch })
    const log = "https://github.com/owner/repo/actions/runs/1"
    const first = await gh.startDeployment({
      environment: "preview/app/pr-12",
      ref: "a",
      logUrl: log,
    })
    await gh.finishDeployment({
      environment: "preview/app/pr-12",
      state: "success",
      logUrl: log,
      environmentUrl: "https://pr-12.app.example.com",
    })
    expect(w.state.deployments[0]?.statuses).toEqual([
      { state: "in_progress", auto_inactive: false, log_url: log },
      {
        state: "success",
        auto_inactive: false,
        log_url: log,
        environment_url: "https://pr-12.app.example.com",
      },
    ])
    const { io: sink } = io()
    const args = ["deployment", "--repository", "owner/repo", "--environment", "preview/app/pr-12"]
    expect(
      await runPreviewCli(
        [...args, "--state", "in_progress", "--ref", "b", "--run-url", log],
        sink,
        w.deps,
      ),
    ).toBe(0)
    expect(w.state.deployments.map((d) => d.id)).toEqual([first + 1])
    expect(
      await runPreviewCli([...args, "--state", "failure", "--run-url", log], sink, w.deps),
    ).toBe(0)
    expect(w.state.deployments[0]?.statuses.at(-1)).toMatchObject({
      state: "failure",
      log_url: log,
    })
    expect(await runPreviewCli([...args, "--state", "removed"], sink, w.deps)).toBe(0)
    expect(w.state.deployments).toEqual([])
  })

  test("3. a run that fails before upload marks the section failed while the previous commit keeps serving", async () => {
    const live = upsertPreviewSection("text", facts)
    const failed = upsertPreviewSection(live, {
      state: "failed",
      sites: [
        { name: "app", state: "failed" },
        { name: "storybook", state: "failed" },
      ],
      attempted: "bbbbbbb2222",
      repository: "owner/repo",
    })
    expect(failed).toContain("**Preview:** Failed (the previous deploy keeps serving)")
    expect(failed).toContain("Deployed [`aaaaaaa`]")
    expect(failed).toContain("attempted [`bbbbbbb`]")
    expect(failed).toContain("[Open](https://pr-12.app.example.com)")
    expect(readPreviewSection(failed)?.deployed).toBe("aaaaaaa1111")

    // Through the CLI: a site job that failed before upload leaves a failed result.
    const w = world({ body: live })
    const results = join(root, "results-858")
    mkdirSync(results, { recursive: true })
    writeFileSync(
      join(results, "app.json"),
      JSON.stringify({
        site: "app",
        worker: "app",
        name: "pr-12",
        state: "failed",
        attempted: "bbbbbbb2222",
      }),
    )
    expect(
      await runPreviewCli(
        [
          "pr-section",
          "--repository",
          "owner/repo",
          "--pr",
          "12",
          "--results",
          results,
          "--attempted",
          "bbbbbbb2222",
        ],
        io().io,
        w.deps,
      ),
    ).toBe(0)
    expect(w.state.body).toContain("**Preview:** Failed")
    expect(readPreviewSection(w.state.body)?.deployed).toBe("aaaaaaa1111")
    expect(stripPreviewSection(w.state.body)).toBe("text")
  })
})

describe("#859 the deployed commit is served, and consumer checks", () => {
  test("1. waitUntilServing polls version.json until it names the commit", async () => {
    const w = world()
    w.served.set("pr-12", "commit-a")
    w.state.lag = 3
    const { attempts } = await waitUntilServing("https://pr-12-site.acct.workers.dev", "commit-a", {
      fetch: w.fetch,
      sleep: async () => {},
    })
    expect(attempts).toBe(4)
    let clock = 0
    await expect(
      waitUntilServing("https://pr-12-site.acct.workers.dev", "commit-b", {
        fetch: w.fetch,
        timeoutMs: 10_000,
        intervalMs: 1_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
      }),
    ).rejects.toThrow("is not serving commit-b after 10000 ms (version.json names commit-a)")
  })

  test("2. checks run on the built directory before upload and against the origin after it, re-read until the edge agrees", async () => {
    const seen: string[] = []
    const checks: PreviewChecks = async (origin, fetch) => {
      const version = (await (await fetch(`${origin}/version.json`)).json()) as { version: string }
      seen.push(`${origin} ${version.version}`)
      return [{ name: "version", ok: version.version === "commit-a", detail: version.version }]
    }
    const w = world()
    w.state.lag = 0
    let reads = 0
    const lagging = async (input: string, init?: RequestInit) => {
      // The edge serves the deploy to waitUntilServing, then one stale machine answers the checks once.
      if (input.includes("/version.json") && !input.includes("?t=") && reads++ === 0)
        return Response.json({ version: "older" })
      return w.fetch(input, init)
    }
    const result = await deployPreviewSite({
      site: "site",
      worker: "site",
      name: "pr-12",
      outdir: site(),
      commit: "commit-a",
      target: "pull-request",
      previews: (await import("./src/cloudflare.js")).createCloudflarePreviews({
        accountId: "acct",
        workerName: "site",
        token: "cf",
        fetch: (input, init) => w.fetch(String(input), init),
      }),
      currentPullRequest: async () => ({
        state: "open",
        repository: "o/r",
        headRepository: "o/r",
        head: "commit-a",
      }),
      checks,
      fetch: lagging,
      sleep: async () => {},
    })
    expect(seen).toEqual([
      "http://preview.local commit-a",
      "https://pr-12-site.acct.workers.dev older",
      "https://pr-12-site.acct.workers.dev commit-a",
    ])
    expect(result.state).toBe("live")

    const always = await checkUntilPassing(
      async () => [{ name: "never", ok: false }],
      "https://x.example",
      {
        timeoutMs: 0,
        sleep: async () => {},
      },
    )
    expect(always).toMatchObject({ passed: false, attempts: 1 })
  })

  test("3. a pull request's gate is best effort; a branch's is strict", async () => {
    expect(previewGateUploads("pull-request", false)).toBe(true)
    expect(previewGateUploads("branch", false)).toBe(false)
    expect(previewGateUploads("branch", true)).toBe(true)
    const checksModule = join(root, "checks.ts")
    writeFileSync(
      checksModule,
      `export default async (origin, fetch) => [{ name: "home has a title", ok: (await (await fetch(origin + "/")).text()).includes("<title>") }]\n`,
    )
    const w = world()
    const result = join(root, "result-gate.json")
    const pr = io()
    expect(
      await runPreviewCli(
        deployArgs(site(), ["--checks", checksModule, "--result", result]),
        pr.io,
        w.deps,
      ),
    ).toBe(0)
    expect(JSON.parse(readFileSync(result, "utf8"))).toMatchObject({
      state: "failing-checks",
      deployed: "commit-a",
    })
    expect(pr.out.join("\n")).toContain("deployed, but failing its checks")

    const branch = world()
    const branchResult = join(root, "result-branch.json")
    const args = [
      "deploy-preview",
      "--worker",
      "site",
      "--outdir",
      site(),
      "--commit",
      "commit-a",
      "--branch",
      "main",
      "--repository",
      "owner/repo",
      "--checks",
      checksModule,
      "--result",
      branchResult,
    ]
    expect(await runPreviewCli(args, io().io, branch.deps)).toBe(1)
    expect(JSON.parse(readFileSync(branchResult, "utf8"))).toMatchObject({
      state: "failed",
      name: "main",
    })
    expect(branch.calls.some((call) => call.includes("api.cloudflare.com"))).toBe(false)
  })
})

describe("#860 sweep", () => {
  test("1. lists the Worker's Previews, reads open PRs, plans, deletes and confirms; non-zero if any is left", async () => {
    const w = world({
      open: [12, 13],
      body: upsertPreviewSection("text", {
        state: "live",
        sites: [{ name: "app", url: "https://pr-13.example.com" }],
      }),
    })
    const now = Date.parse("2026-11-21T00:00:00Z")
    const add = (name: string, updated: string) =>
      w.previews.set(name, { id: `id-${name}`, name, updated_on: updated })
    add("pr-11", "2026-11-20T00:00:00Z") // closed: orphaned
    add("pr-12", "2026-11-01T00:00:00Z") // open but past retention: expired
    add("pr-13", "2026-11-20T00:00:00Z") // open and fresh: kept
    add("main", "2026-01-01T00:00:00Z") // not a pull request Preview: never touched
    const { out, io: sink } = io()
    const deps = { ...w.deps, now: () => now }
    expect(
      await runPreviewCli(["sweep", "--worker", "site", "--repository", "owner/repo"], sink, deps),
    ).toBe(0)
    expect([...w.previews.keys()].sort()).toEqual(["main", "pr-13"])
    expect(out).toContain("site: removed pr-11 (orphaned)")
    expect(out).toContain("site: removed pr-12 (expired)")
    expect(w.state.body).toContain("**Preview:** Expired")

    add("pr-13", "2026-11-20T00:00:00Z")
    add("pr-14", "2026-11-19T00:00:00Z")
    w.state.keepDeleted = true
    const left = io()
    expect(
      await runPreviewCli(
        ["sweep", "--worker", "site", "--open-prs", "13,14", "--capacity", "1"],
        left.io,
        deps,
      ),
    ).toBe(1)
    expect(left.out.join("\n")).toContain("still listed after deletion: pr-14")
  })
})

describe("reusable workflow", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "../../../.github/workflows/preview.yml"), "utf8"),
  ) as {
    on: { workflow_call: { inputs: Record<string, { default?: unknown; required?: boolean }> } }
    jobs: Record<
      string,
      {
        if?: string
        needs?: string | string[]
        strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown> }
        steps: { name?: string; run?: string; if?: string }[]
      }
    >
  }
  const inputs = workflow.on.workflow_call.inputs
  const runs = (job: string) =>
    workflow.jobs[job]?.steps.map((step) => step.run ?? "").join("\n") ?? ""

  test("the per-PR Worker mode stays the default; named Previews are opt-in", () => {
    expect(inputs.mode?.default).toBe("worker")
    expect(workflow.jobs.preview?.if).toContain("inputs.mode != 'named-previews'")
    for (const job of ["plan", "site", "report", "sweep"])
      expect(workflow.jobs[job]?.if ?? "").toContain("named-previews")
  })

  test("#856.1 named mode deploys Previews with the CLI, never `wrangler deploy` or a Worker script", () => {
    expect(runs("site")).toContain("deploy-preview")
    expect(runs("site")).not.toMatch(/wrangler|workers\/scripts/)
  })

  test("#857.1 every site is its own matrix job, run concurrently, one failure not holding back the others", () => {
    expect(inputs.sites).toBeDefined()
    expect(workflow.jobs.site?.strategy?.["fail-fast"]).toBe(false)
    expect(JSON.stringify(workflow.jobs.site?.strategy?.matrix)).toContain(
      "fromJSON(needs.plan.outputs.sites)",
    )
  })

  test("#857.2 / #856.2 a closed PR removes every site's Preview", () => {
    const remove = workflow.jobs.site?.steps.find((step) => step.run?.includes("remove-preview"))
    expect(remove?.if).toContain("close")
  })

  test("#858 the report job writes the PR section; site jobs record Deployments", () => {
    expect(runs("plan")).toContain("pr-section")
    expect(runs("report")).toContain("pr-section")
    expect(runs("site")).toContain("deployment")
    expect(workflow.jobs.report?.if).toContain("always()")
  })

  test("#860.2 a schedule or workflow_dispatch runs the sweep", () => {
    expect(runs("sweep")).toContain("sweep --worker")
    expect(workflow.jobs.plan?.steps.map((s) => s.run).join("\n")).toMatch(
      /schedule[\s\S]*workflow_dispatch|workflow_dispatch[\s\S]*schedule/,
    )
    for (const input of ["retention-days", "capacity"]) expect(inputs[input]).toBeDefined()
  })
})
