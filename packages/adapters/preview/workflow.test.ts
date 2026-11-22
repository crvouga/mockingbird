/**
 * The reusable preview workflow (.github/workflows/preview.yml), #862–#868: its job graph, and
 * its `run:` scripts executed with bash against fake `gh`, `wrangler`, `curl` and package managers.
 */
import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type Step = {
  name?: string
  id?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
type Job = {
  if?: string
  needs?: string | string[]
  "runs-on"?: string
  "timeout-minutes"?: string | number
  permissions?: Record<string, string>
  concurrency?: { group: string; "cancel-in-progress"?: boolean }
  env?: Record<string, string>
  outputs?: Record<string, string>
  steps: Step[]
}
const source = readFileSync(join(import.meta.dir, "../../../.github/workflows/preview.yml"), "utf8")
const workflow = Bun.YAML.parse(source) as {
  on: {
    workflow_call: {
      inputs: Record<string, { default?: unknown; type?: string }>
      outputs: Record<string, { value: string }>
      secrets: Record<string, unknown>
    }
  }
  env: Record<string, string>
  jobs: Record<string, Job>
}
const inputs = workflow.on.workflow_call.inputs
/** A GitHub expression, as the YAML spells it. */
const expr = (body: string) => `\${{ ${body} }}`
const job = (id: string) => {
  const found = workflow.jobs[id]
  if (!found) throw new Error(`no job ${id}`)
  return found
}
const step = (jobId: string, name: string) => {
  const found = job(jobId).steps.find((item) => item.name === name || item.id === name)
  if (!found) throw new Error(`no step ${name} in ${jobId}`)
  return found
}

const root = mkdtempSync(join(tmpdir(), "mockingbird-preview-workflow-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0
const dir = (name = "dir") => {
  const path = join(root, `${name}-${dirs++}`)
  mkdirSync(path, { recursive: true })
  return path
}
const executable = (path: string, body: string) => {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A fake `gh api [--paginate] <path> --jq <filter>` answering from `responses` (path → JSON). */
const fakeGh = (bin: string, responses: Record<string, unknown>) => {
  const data = dir("gh")
  for (const [path, body] of Object.entries(responses))
    writeFileSync(join(data, encodeURIComponent(path)), JSON.stringify(body))
  executable(
    join(bin, "gh"),
    `shift; filter=.
while [ $# -gt 0 ]; do case "$1" in --paginate) shift ;; --jq) filter=$2; shift 2 ;; *) path=$1; shift ;; esac; done
file="${data}/$(jq -rn --arg p "$path" '$p | @uri')"
[ -f "$file" ] || { echo "gh: no fake for $path" >&2; exit 1; }
jq -r "$filter" "$file"`,
  )
}

/** Runs one step's `run:` script as GitHub does (bash -eo pipefail), returning its outputs. */
const runStep = (
  script: string | undefined,
  env: Record<string, string> = {},
  bin: string = dir("bin"),
  cwd: string = root,
) => {
  if (!script) throw new Error("step has no run script")
  const runner = dir("runner")
  const output = join(runner, "output")
  const file = join(runner, "step.sh")
  writeFileSync(file, script)
  writeFileSync(output, "")
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", file], {
    cwd,
    env: {
      ...workflow.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME ?? root,
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "77",
      GITHUB_OUTPUT: output,
      GITHUB_ENV: join(runner, "env"),
      GITHUB_STEP_SUMMARY: join(runner, "summary"),
      RUNNER_TEMP: runner,
      ...env,
    },
  })
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    outputs,
    runner,
  }
}

/** Jobs that hold a deploy credential or the write token. */
const credentialed = Object.entries(workflow.jobs).filter(([, item]) =>
  JSON.stringify(item).match(/secrets\.|github\.token/),
)
const UNTRUSTED = ["build", "build-site", "verify"]

describe("#862 pull request code never runs where the credentials are", () => {
  test("#862.1 the build jobs get no secret, no write token and a read-only GITHUB_TOKEN", () => {
    for (const id of UNTRUSTED) {
      const text = JSON.stringify(job(id))
      expect(text).not.toMatch(/secrets\.|github\.token/)
      expect(job(id).permissions).toEqual({ contents: "read" })
    }
  })

  test("#862.2 every job that holds a credential checks out only the base commit, never builds", () => {
    expect(credentialed.map(([id]) => id).sort()).toEqual(
      ["deploy", "plan", "preview", "remove", "report", "site", "sweep", "vercel-status"].sort(),
    )
    for (const [id, item] of credentialed) {
      for (const each of item.steps) {
        if (each.uses?.startsWith("actions/checkout"))
          expect(`${id}: ${String(each.with?.ref)}`).toBe(
            `${id}: ${expr("github.event.pull_request.base.sha || github.sha")}`,
          )
        expect(each.run ?? "").not.toContain('eval "$BUILD"')
        expect(each.run ?? "").not.toMatch(/--checks\b/)
        expect(each.run ?? "").not.toContain("gate-preview")
        expect(each.run ?? "").not.toContain("check-preview")
      }
    }
  })

  test("#862.3 the build is handed over as an artifact, downloaded only by the deploy jobs", () => {
    expect(
      job("build").steps.some(
        (s) => s.uses?.startsWith("actions/upload-artifact") && s.with?.name === "preview-build",
      ),
    ).toBe(true)
    expect(
      job("deploy").steps.some(
        (s) => s.uses?.startsWith("actions/download-artifact") && s.with?.name === "preview-build",
      ),
    ).toBe(true)
    expect(job("deploy").needs).toEqual(["preview", "build"])
    expect(job("site").needs).toEqual(["plan", "build-site"])
  })

  test("#862.4 the deploy refuses an artifact with a symlink or an oversized file", () => {
    const artifact = dir("artifact")
    const assets = join(artifact, "assets")
    mkdirSync(join(assets, "nested"), { recursive: true })
    writeFileSync(join(assets, "index.html"), "<h1>hi</h1>")
    symlinkSync("/etc/passwd", join(assets, "nested", "leak.txt"))
    writeFileSync(join(assets, "big.bin"), new Uint8Array(2 * 1024 * 1024 + 1))
    const validate = (max: string) =>
      runStep(step("deploy", "Validate the build").run, {
        ARTIFACT: artifact,
        MAX_BYTES: String(2 * 1024 * 1024),
        MAX_FILES: max,
      })
    const run = validate("10")
    expect(run.code).toBe(1)
    expect(run.stdout).toContain("nested/leak.txt is not a regular file")
    expect(run.stdout).toContain("big.bin is 2 MiB, over the 2 MiB per-file limit")
    expect(validate("1").stdout).toContain("2 files, over the 1 files per deployment limit")
    rmSync(join(assets, "nested"), { recursive: true })
    rmSync(join(assets, "big.bin"))
    expect(validate("10").code).toBe(0)
  })

  /** An artifact as the build job leaves it, with a PR-controlled wrangler config. */
  const builtArtifact = (config: Record<string, unknown>) => {
    const temp = dir("runner-temp")
    const artifact = join(temp, "preview-artifact")
    mkdirSync(join(artifact, "assets", "node_modules", ".bin"), { recursive: true })
    mkdirSync(join(artifact, "worker"), { recursive: true })
    writeFileSync(join(artifact, "assets", "index.html"), "<h1>hi</h1>")
    writeFileSync(join(artifact, "worker", "worker.js"), "export default {}")
    // The PR's own CLI, which would print the deploy job's environment if anything ran it.
    executable(
      join(artifact, "assets", "node_modules", ".bin", "mockingbird-preview"),
      `env > "${temp}/stolen"`,
    )
    writeFileSync(join(artifact, "wrangler.json"), JSON.stringify(config))
    return { temp, artifact }
  }
  const fakeWrangler = (bin: string, out: string) =>
    executable(
      join(bin, "fake-wrangler"),
      `echo "$PWD" > "${out}/cwd"; printf '%s\\n' "$@" > "${out}/args"
if [ "$1" = deploy ]; then cp wrangler.json "${out}/config.json"; echo "Deployed https://$(jq -r .name wrangler.json).acct.workers.dev"; fi`,
    )

  test("#862 acceptance: a PR's own mockingbird-preview binary is never run by the deploy; the config is rebuilt from an allowlist", () => {
    const { temp, artifact } = builtArtifact({
      name: "evil",
      main: "worker.js",
      compatibility_date: "2026-11-13",
      build: { command: "cat /proc/self/environ" },
      assets: { directory: "/", binding: "ASSETS" },
      vars: { A: "1" },
    })
    const bin = dir("bin")
    const out = dir("out")
    fakeWrangler(bin, out)
    executable(join(bin, "curl"), "exit 0")
    // PATH also holds the PR's .bin: still nothing from it runs.
    const run = runStep(
      step("deploy", "Deploy").run,
      {
        RUNNER_TEMP: temp,
        ARTIFACT: artifact,
        HOSTING: "cloudflare",
        WRANGLER: join(bin, "fake-wrangler"),
        CLI: "mockingbird-preview",
        WORKER: "app-pr-12",
        PR: "12",
        PR_URL: "https://github.com/acme/app/pull/12",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        WORKER_SECRETS: "",
      },
      `${bin}:${join(artifact, "assets", "node_modules", ".bin")}`,
    )
    expect(run.stderr + run.stdout).not.toContain("error")
    expect(run.code).toBe(0)
    expect(existsSync(join(temp, "stolen"))).toBe(false)
    const config = JSON.parse(readFileSync(join(out, "config.json"), "utf8"))
    expect(config.build).toBeUndefined()
    expect(config.name).toBe("app-pr-12")
    expect(config.no_bundle).toBe(true)
    expect(config.main).toBe(join(artifact, "worker", "worker.js"))
    expect(config.assets.directory).toBe(join(artifact, "assets"))
    expect(config.vars).toEqual({
      A: "1",
      PREVIEW_PR: '{"number":12,"url":"https://github.com/acme/app/pull/12"}',
    })
    // wrangler ran from a directory of its own, not the artifact.
    expect(readFileSync(join(out, "cwd"), "utf8").trim()).toBe(join(temp, "preview-deploy"))
    expect(run.outputs.url).toBe("https://app-pr-12.acct.workers.dev")
  })

  test("#862 a wrangler-config setting that reads files or runs code in the deploy is refused by name", () => {
    for (const key of ["containers", "text_blobs", "wasm_modules", "site", "env"]) {
      const { temp, artifact } = builtArtifact({ main: "worker.js", [key]: {} })
      const bin = dir("bin")
      const out = dir("out")
      fakeWrangler(bin, out)
      const run = runStep(
        step("deploy", "Deploy").run,
        {
          RUNNER_TEMP: temp,
          ARTIFACT: artifact,
          HOSTING: "cloudflare",
          WRANGLER: join(bin, "fake-wrangler"),
          WORKER: "app-pr-12",
          PR: "12",
          PR_URL: "https://github.com/acme/app/pull/12",
        },
        bin,
      )
      expect(run.code).not.toBe(0)
      expect(run.stderr).toContain(
        `wrangler-config settings a preview deploy does not support: ${key}`,
      )
      expect(existsSync(join(out, "config.json"))).toBe(false)
    }
  })

  test("#862 WORKER_SECRETS cannot ride along to a Vercel preview, which runs no code", () => {
    const run = runStep(step("preview", "ctx").run, {
      EVENT: "pull_request",
      ACTION: "synchronize",
      PR_NUMBER: "12",
      SAME_REPO: "true",
      HEAD_SHA: "b".repeat(40),
      HAS_VERCEL: "true",
      HAS_WORKER_SECRETS: "true",
      HOSTING: "vercel",
      NAME: "app",
    })
    expect(run.code).toBe(1)
    expect(run.stdout).toContain("WORKER_SECRETS needs a Worker")
  })
})

describe("#865 the newest commit deploys last; unchanged pushes build nothing", () => {
  test("#865.1 deploys of one PR are serialized and a newer one (or the close) cancels the older", () => {
    for (const id of ["deploy", "remove", "build"])
      expect(job(id).concurrency?.["cancel-in-progress"]).toBe(true)
    expect(job("deploy").concurrency?.group).toBe(job("remove").concurrency?.group)
    expect(job("deploy").concurrency?.group).toContain("needs.preview.outputs.pr")
    expect(job("site").concurrency?.group).toContain("matrix.site.name")
  })

  const recheck = (
    pr: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    paths = "",
  ) => {
    const bin = dir("bin")
    fakeGh(bin, { "repos/acme/app/pulls/12": pr, ...extra })
    return runStep(
      step("deploy", "recheck").run,
      { PR: "12", SHA: "a".repeat(40), PATHS: paths },
      bin,
    )
  }

  test("#865.1 acceptance: an older build whose PR moved on is skipped, the current one deploys", () => {
    expect(recheck({ state: "open", head: { sha: "a".repeat(40) } }).outputs.current).toBe("true")
    const moved = recheck({ state: "open", head: { sha: "b".repeat(40) } })
    expect(moved.outputs.current).toBe("false")
    expect(moved.stdout).toContain("moved on to bbbbbbb; skipping aaaaaaa")
    expect(recheck({ state: "closed", head: { sha: "a".repeat(40) } }).outputs.current).toBe(
      "false",
    )
    // Every later step that deploys or writes status is gated on the recheck.
    for (const name of ["Validate the build", "Deploy"])
      expect(step("deploy", name).if).toContain("steps.recheck.outputs.current == 'true'")
  })

  test("#865.1 a build superseded only by commits that change nothing shipped still deploys", () => {
    const run = recheck(
      { state: "open", head: { sha: "b".repeat(40) } },
      {
        [`repos/acme/app/compare/${"a".repeat(40)}...${"b".repeat(40)}`]: {
          files: [{ filename: "docs/notes.md" }],
        },
      },
      "src/**\npackage.json",
    )
    expect(run.outputs.current).toBe("true")
  })

  const paths = (files: string[], patterns: string, env: Record<string, string> = {}) => {
    const bin = dir("bin")
    fakeGh(bin, {
      "repos/acme/app/compare/before...after": { files: files.map((filename) => ({ filename })) },
      "repos/acme/app/pulls/12/files": files.map((filename) => ({ filename })),
    })
    return runStep(
      step("preview", "paths").run,
      {
        MODE: "deploy",
        PATHS: patterns,
        PR: "12",
        ACTION: "synchronize",
        BEFORE: "before",
        AFTER: "after",
        ...env,
      },
      bin,
    ).outputs.mode
  }

  test("#865.2 acceptance: a push touching only ignored paths starts no build", () => {
    const shipped = "src/**\n!src/**/*.md\npackage.json"
    expect(paths(["docs/guide.md", "README.md"], shipped)).toBe("unchanged")
    expect(paths(["src/notes/plan.md"], shipped)).toBe("unchanged")
    expect(paths(["src/app/main.ts"], shipped)).toBe("deploy")
    expect(paths(["package.json"], shipped)).toBe("deploy")
    // `*` stays within a segment; `**` crosses them.
    expect(paths(["src/a/b.ts"], "src/*.ts")).toBe("unchanged")
    expect(paths(["src/a/b.ts"], "src/**/*.ts")).toBe("deploy")
    // Opened: the whole PR's files. No `paths`: always builds.
    expect(paths(["docs/a.md"], shipped, { ACTION: "opened" })).toBe("unchanged")
    expect(paths(["docs/a.md"], "")).toBe("deploy")
    // Unknown diff (a new branch): builds.
    expect(paths(["docs/a.md"], shipped, { BEFORE: "0".repeat(40), PR: "" })).toBe("deploy")
    expect(job("build").if).toBe(
      "needs.preview.outputs.mode == 'deploy' || needs.preview.outputs.mode == 'warm'",
    )
    expect(job("preview").outputs?.mode).toBe(expr("steps.paths.outputs.mode"))
    expect(job("plan").outputs?.mode).toBe(expr("steps.paths.outputs.mode"))
  })
})

describe("#864 runner, timeout, toolchain and caches", () => {
  test("#864.1 runs-on (a label or JSON) and timeout-minutes reach the build jobs", () => {
    expect(inputs["runs-on"]?.default).toBe("ubuntu-latest")
    expect(inputs["timeout-minutes"]?.type).toBe("number")
    for (const id of ["build", "build-site"]) {
      expect(job(id)["runs-on"]).toContain("fromJSON(inputs.runs-on)")
      expect(job(id)["timeout-minutes"]).toBe(expr("inputs.timeout-minutes"))
    }
  })

  test("#864.2 package-manager sets up pnpm and Node and picks the install", () => {
    const uses = job("build").steps.map((s) => s.uses ?? "")
    expect(uses.some((u) => u.startsWith("pnpm/action-setup"))).toBe(true)
    expect(uses.some((u) => u.startsWith("actions/setup-node"))).toBe(true)
    const node = job("build").steps.find((s) => s.uses?.startsWith("actions/setup-node"))
    expect(node?.with?.["node-version"]).toBe(expr("inputs.node-version"))
    expect(node?.with?.["node-version-file"]).toBe(expr("inputs.node-version-file"))
    expect(node?.if).toContain("inputs.package-manager != 'bun'")
    const install = (manager: string, explicit = "") => {
      const bin = dir("bin")
      const log = join(dir("log"), "calls")
      for (const tool of ["bun", "pnpm", "npm"])
        executable(join(bin, tool), `echo "${tool} $*" >> "${log}"`)
      const run = runStep(
        step("build", "Install").run,
        { INSTALL: explicit, PACKAGE_MANAGER: manager },
        bin,
      )
      return { code: run.code, calls: existsSync(log) ? readFileSync(log, "utf8").trim() : "" }
    }
    expect(install("pnpm").calls).toBe("pnpm install --frozen-lockfile")
    expect(install("npm").calls).toBe("npm ci")
    expect(install("bun").calls).toBe("bun install --frozen-lockfile")
    expect(install("pnpm", "pnpm install --filter app...").calls).toBe(
      "pnpm install --filter app...",
    )
    expect(install("yarn").code).toBe(1)
  })

  test("#864.3 caches restore read-only on pull requests and save only from the default branch", () => {
    for (const id of ["build", "build-site"]) {
      const restore = job(id).steps.find((s) => s.uses?.startsWith("actions/cache/restore"))
      const save = job(id).steps.find((s) => s.uses?.startsWith("actions/cache/save"))
      expect(restore?.with?.path).toBe(expr("inputs.cache-paths"))
      expect(String(restore?.with?.key)).toStartWith(`${expr("inputs.cache-key-prefix")}-`)
      expect(save?.if).toContain("github.event_name == 'push'")
      expect(save?.if).toContain("format('refs/heads/{0}', github.event.repository.default_branch)")
      expect(job(id).steps.some((s) => s.uses === "actions/cache@v4")).toBe(false)
    }
    const warm = runStep(step("preview", "ctx").run, {
      EVENT: "push",
      DEFAULT_BRANCH_PUSH: "true",
      CACHE_PATHS: ".turbo",
      HOSTING: "cloudflare",
      NAME: "app",
    })
    expect(warm.outputs.mode).toBe("warm")
  })
})

describe("#866 asset limits before upload", () => {
  test("#866.1 the build job preflights and the deploy job re-validates with the same script", () => {
    expect(step("build", "Stamp, preflight and package the preview").run).toContain(
      'bash -c "$PREVIEW_VALIDATE" - "$OUTDIR" "$MAX_BYTES" "$MAX_FILES"',
    )
    expect(step("deploy", "Validate the build").run).toContain('bash -c "$PREVIEW_VALIDATE"')
    const limits = (hosting: string, extra: Record<string, string> = {}) =>
      runStep(step("preview", "ctx").run, {
        EVENT: "pull_request",
        ACTION: "opened",
        PR_NUMBER: "1",
        SAME_REPO: "true",
        HAS_CLOUDFLARE: "true",
        HAS_VERCEL: "true",
        HOSTING: hosting,
        NAME: "app",
        ...extra,
      }).outputs
    expect(limits("cloudflare")["max-bytes"]).toBe(String(25 * 1024 * 1024))
    expect(limits("cloudflare")["max-files"]).toBe("20000")
    expect(limits("cloudflare", { MAX_FILE_MIB: "40", MAX_FILES: "100" })["max-bytes"]).toBe(
      String(40 * 1024 * 1024),
    )
  })

  test("#866.2 split-large-files runs `check --split` in the build job", () => {
    const split = step("build", "Split files over the limit")
    expect(split.if).toContain("inputs.split-large-files")
    expect(split.run).toContain("--split")
  })
})

describe("#868 the PR link and permissions", () => {
  const link = async (path: string | undefined, body = "Author text") => {
    const script = String(step("deploy", "Put the preview link at the top of the PR").with?.script)
    let updated: string | undefined
    const github = {
      rest: {
        pulls: {
          get: async () => ({ data: { body } }),
          update: async (request: { body: string }) => {
            updated = request.body
          },
        },
      },
    }
    const previous = { ...process.env }
    process.env.PR = "12"
    process.env.PREVIEW_URL = "https://app-pr-12.acct.workers.dev"
    if (path === undefined) delete process.env.LINK_PATH
    else process.env.LINK_PATH = path
    try {
      const run = new Function("github", "context", `return (async () => { ${script} })()`)
      await run(github, { repo: { owner: "acme", repo: "app" } })
    } finally {
      process.env = previous
    }
    return updated
  }

  test("#868.1 the link opens `link-path` (default `/`), no surface assumed", async () => {
    expect(inputs["link-path"]?.default).toBe("/")
    expect(await link("/")).toContain("[Preview](https://app-pr-12.acct.workers.dev/)")
    expect(await link("/?surface=app")).toContain(
      "[Preview](https://app-pr-12.acct.workers.dev/?surface=app)",
    )
    expect(await link("/")).not.toContain("surface=")
    expect(source).not.toContain("/?surface=app)")
  })

  test("#868.2 the documented permissions match the workflow header, with a reason for each", () => {
    const docs = readFileSync(join(import.meta.dir, "../../../docs/PREVIEWS.md"), "utf8")
    const header = source.match(/^# {3}permissions: (.*)$/m)?.[1]
    expect(header).toBe("{ contents: read, pull-requests: write }")
    expect(docs).toContain(`permissions: ${header}`)
    expect(docs).not.toContain("actions: read")
    expect(source).not.toContain("actions: read")
    expect(source).toContain("`contents: read` checks out the code; `pull-requests: write`")
  })

  test("#868.3 pr-link: false leaves the description alone; the `url` output carries the link", () => {
    expect(inputs["pr-link"]?.default).toBe(true)
    expect(step("deploy", "Put the preview link at the top of the PR").if).toContain(
      "inputs.pr-link",
    )
    expect(workflow.on.workflow_call.outputs.url?.value).toBe(expr("jobs.deploy.outputs.url"))
    expect(job("deploy").outputs?.url).toBe(expr("steps.deploy.outputs.url"))
  })
})

describe("#863 hosting input", () => {
  test("#863 hosting: vercel takes only Vercel credentials and deploys with the base commit's CLI", () => {
    expect(inputs.hosting?.default).toBe("cloudflare")
    for (const name of ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_ORG_ID"])
      expect(workflow.on.workflow_call.secrets[name]).toBeDefined()
    expect(step("deploy", "Deploy").run).toContain("$CLI host-deploy")
    expect(step("remove", "Remove the preview").run).toContain("host-remove")
    expect(step("vercel-status", "Tell the preview its status").run).toContain("push-status")
    const ctx = runStep(step("preview", "ctx").run, {
      EVENT: "pull_request",
      ACTION: "opened",
      PR_NUMBER: "1",
      SAME_REPO: "true",
      HAS_CLOUDFLARE: "false",
      HAS_VERCEL: "true",
      HOSTING: "vercel",
      NAME: "app",
    })
    expect(ctx.outputs.mode).toBe("deploy")
    const wrong = runStep(step("preview", "ctx").run, { HOSTING: "netlify", NAME: "app" })
    expect(wrong.code).toBe(1)
    expect(wrong.stdout).toContain("hosting is cloudflare or vercel")
    const named = runStep(step("plan", "ctx").run, { HOSTING: "vercel" })
    expect(named.code).toBe(1)
    expect(named.stdout).toContain("supported only in worker mode")
  })
})
