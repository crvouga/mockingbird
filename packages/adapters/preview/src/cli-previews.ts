/**
 * The `mockingbird-preview` commands for named Previews of one assets-only Worker (the reusable
 * workflow's `mode: named-previews`): deploy-preview, remove-preview, sweep, pr-section and
 * deployment. Bun / Node only.
 */
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { PreviewAssetLimits } from "./assets-check.js"
import { assertAssetsOnlyConfig, parseJsonc } from "./assets-only.js"
import { createCloudflarePreviews } from "./cloudflare.js"
import { createPreviewGitHub } from "./github.js"
import type { PullRequestFacts } from "./lifecycle.js"
import {
  PREVIEW_SECTION_STATES,
  type PreviewSectionSite,
  type PreviewSectionState,
  readPreviewSection,
  summarizePreviewState,
  upsertPreviewSection,
} from "./pr-section.js"
import {
  checkUntilPassing,
  type PreviewCheck,
  type PreviewChecks,
  type PreviewHttpFetch,
  runPreviewChecks,
} from "./serving.js"
import {
  deployPreviewSite,
  directoryFetch,
  failedPreviewChecks,
  PREVIEW_LOCAL_ORIGIN,
  type PreviewSiteResult,
  PULL_REQUEST_PREVIEW,
  pullRequestPreviewName,
  removePreviewSite,
  sweepPreviews,
} from "./site.js"

export class PreviewUsageError extends Error {}

export type PreviewArgs = Map<string, string[]>

/** What the commands reach the outside world through; tests replace it. */
export type PreviewCliDeps = {
  env: Record<string, string | undefined>
  fetch: PreviewHttpFetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

type Io = { stdout(line: string): void; stderr(line: string): void }

const one = (args: PreviewArgs, key: string) => {
  const values = args.get(key)
  if (values !== undefined && values.length > 1) throw new PreviewUsageError(`--${key} given twice`)
  return values?.[0]
}
const need = (args: PreviewArgs, key: string) => {
  const value = one(args, key)
  if (!value) throw new PreviewUsageError(`--${key} is required`)
  return value
}
const allow = (args: PreviewArgs, keys: readonly string[]) => {
  for (const key of args.keys())
    if (!keys.includes(key)) throw new PreviewUsageError(`Unknown option --${key}`)
}
const positive = (value: string | undefined, key: string, fallback: number) => {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!(Number.isFinite(number) && number >= 0)) throw new PreviewUsageError(`--${key} is a number`)
  return number
}
const prNumber = (value: string | undefined) => {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!(Number.isInteger(number) && number > 0))
    throw new PreviewUsageError("--pr is a positive integer")
  return number
}
const env = (deps: PreviewCliDeps, key: string) => {
  const value = deps.env[key]
  if (!value) throw new PreviewUsageError(`${key} is required in the environment`)
  return value
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const cloudflare = (deps: PreviewCliDeps, worker: string) =>
  createCloudflarePreviews({
    accountId: env(deps, "CLOUDFLARE_ACCOUNT_ID"),
    token: env(deps, "CLOUDFLARE_API_TOKEN"),
    workerName: worker,
    fetch: (input, init) => deps.fetch(String(input), init),
  })
const github = (deps: PreviewCliDeps, repository: string) =>
  createPreviewGitHub({
    token: env(deps, "GITHUB_TOKEN"),
    repository,
    ...(deps.env.GITHUB_API_URL ? { apiUrl: deps.env.GITHUB_API_URL } : {}),
    fetch: deps.fetch,
  })

/** A branch's Preview name: lowercase letters, digits and dashes. */
export const branchPreviewName = (branch: string) =>
  branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "branch"

const loadChecks = async (path: string): Promise<PreviewChecks> => {
  const module = (await import(pathToFileURL(resolve(path)).href)) as {
    default?: unknown
    checks?: unknown
  }
  const checks = module.default ?? module.checks
  if (typeof checks !== "function")
    throw new PreviewUsageError(`${path} exports no checks function (default or \`checks\`)`)
  return checks as PreviewChecks
}

/** `--max-file-mib` / `--max-files`, when given. */
export const assetLimits = (args: PreviewArgs): Partial<PreviewAssetLimits> | undefined => {
  const file = one(args, "max-file-mib")
  const files = one(args, "max-files")
  if (file === undefined && files === undefined) return undefined
  const limits: Partial<PreviewAssetLimits> = {}
  if (file !== undefined) {
    const value = Number(file)
    if (!(value > 0)) throw new PreviewUsageError("--max-file-mib is a positive number")
    limits.maxFileBytes = Math.floor(value * 1024 * 1024)
  }
  if (files !== undefined) {
    const value = Number(files)
    if (!(Number.isSafeInteger(value) && value > 0))
      throw new PreviewUsageError("--max-files is a positive integer")
    limits.maxFiles = value
  }
  return limits
}

/** A gate result file `gate-preview` wrote: an array of `{ name, ok, detail? }`. */
const readGate = async (path: string): Promise<PreviewCheck[]> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (
    !Array.isArray(value) ||
    value.some(
      (check) =>
        !check ||
        typeof check !== "object" ||
        typeof (check as PreviewCheck).name !== "string" ||
        typeof (check as PreviewCheck).ok !== "boolean",
    )
  )
    throw new PreviewUsageError(`${path} is not a gate result (an array of { name, ok, detail? })`)
  return (value as PreviewCheck[]).map((check) => ({
    name: check.name,
    ok: check.ok,
    ...(typeof check.detail === "string" ? { detail: check.detail } : {}),
  }))
}

/**
 * Runs a site's checks on the built directory and writes the results (`--out`). The reusable
 * workflow runs it in the build job, which holds no credentials, and hands the file to the deploy
 * (`deploy-preview --gate`).
 */
const gatePreview = async (args: PreviewArgs, io: Io) => {
  allow(args, ["outdir", "checks", "out", "site"])
  const outdir = need(args, "outdir")
  const site = one(args, "site") ?? "site"
  const checks = await loadChecks(need(args, "checks"))
  const outcome = await runPreviewChecks(checks, PREVIEW_LOCAL_ORIGIN, directoryFetch(outdir))
  const out = need(args, "out")
  await mkdir(dirname(resolve(out)), { recursive: true })
  await writeFile(out, `${JSON.stringify(outcome.results, null, 2)}\n`)
  io.stdout(
    `${site}: gate ${outcome.passed ? "passed" : `failed (${failedPreviewChecks(outcome.results)})`}`,
  )
  return 0
}

/**
 * Runs a site's checks against its deployed origin (from a `deploy-preview --result` file),
 * re-read until they pass or the deadline passes, and records them in the same file: a live site
 * whose checks fail becomes `failing-checks`. The reusable workflow runs it in a job without
 * credentials, after the deploy.
 */
const checkPreview = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, ["checks", "result", "timeout-seconds"])
  const path = need(args, "result")
  const result = JSON.parse(await readFile(path, "utf8")) as PreviewSiteResult
  if (!result.url || (result.state !== "live" && result.state !== "failing-checks")) {
    io.stdout(`${result.site ?? "site"}: nothing deployed to check (${result.state})`)
    return 0
  }
  const checks = await loadChecks(need(args, "checks"))
  const outcome = await checkUntilPassing(checks, result.url, {
    timeoutMs: positive(one(args, "timeout-seconds"), "timeout-seconds", 180) * 1000,
    fetch: deps.fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  })
  const failing = [...(result.gate ?? []), ...outcome.results].filter((check) => !check.ok)
  const next: PreviewSiteResult = {
    ...result,
    after: outcome.results,
    state: failing.length > 0 ? "failing-checks" : "live",
  }
  if (failing.length > 0) next.message = failedPreviewChecks(failing)
  else delete next.message
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`)
  io.stdout(`${result.site}: checks after upload ${outcome.passed ? "passed" : "failed"}`)
  if (failing.length > 0)
    io.stdout(`::warning::${result.site} preview deployed, but failing its checks: ${next.message}`)
  return 0
}

const deployPreview = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, [
    "site",
    "worker",
    "name",
    "outdir",
    "commit",
    "pr",
    "branch",
    "repository",
    "config",
    "host",
    "checks",
    "gate",
    "max-file-mib",
    "max-files",
    "timeout-seconds",
    "result",
  ])
  const worker = need(args, "worker")
  const outdir = need(args, "outdir")
  const commit = need(args, "commit")
  const repository = need(args, "repository")
  const pr = prNumber(one(args, "pr"))
  const branch = one(args, "branch")
  if ((pr === undefined) === (branch === undefined))
    throw new PreviewUsageError("Give exactly one of --pr or --branch")
  const name =
    one(args, "name") ??
    (pr !== undefined ? pullRequestPreviewName(pr) : branchPreviewName(branch as string))
  const site = one(args, "site") ?? worker
  const configPath = one(args, "config")
  const config = configPath
    ? assertAssetsOnlyConfig(parseJsonc(await readFile(configPath, "utf8")))
    : undefined
  const checksPath = one(args, "checks")
  const checks = checksPath ? await loadChecks(checksPath) : undefined
  const gatePath = one(args, "gate")
  const gate = gatePath ? await readGate(gatePath) : undefined
  const host = one(args, "host")
  const limits = assetLimits(args)
  const gh = github(deps, repository)
  const server = deps.env.GITHUB_SERVER_URL ?? "https://github.com"
  const currentPullRequest = async (): Promise<PullRequestFacts> => {
    if (pr !== undefined) return (await gh.pullRequest(pr)).facts
    // A branch is "open" while it exists; deploy only while its head is still this commit.
    return {
      state: "open",
      repository,
      headRepository: repository,
      head: await gh.branchHead(branch as string),
    }
  }
  const result = await deployPreviewSite({
    site,
    worker,
    name,
    outdir,
    commit,
    target: pr !== undefined ? "pull-request" : "branch",
    previews: cloudflare(deps, worker),
    currentPullRequest,
    ...(pr !== undefined ? { pr: { number: pr, url: `${server}/${repository}/pull/${pr}` } } : {}),
    ...(config ? { config } : {}),
    ...(host ? { host } : {}),
    ...(checks ? { checks } : {}),
    ...(gate ? { gate } : {}),
    ...(limits ? { limits } : {}),
    timeoutMs: positive(one(args, "timeout-seconds"), "timeout-seconds", 180) * 1000,
    fetch: deps.fetch,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    log: (line) => io.stdout(`${site}: ${line}`),
  })
  const resultPath = one(args, "result")
  if (resultPath) {
    await mkdir(dirname(resolve(resultPath)), { recursive: true })
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  }
  io.stdout(
    `${site}: ${result.state}${result.url ? ` ${result.url}` : ""}${result.message ? ` (${result.message})` : ""}`,
  )
  if (result.state === "failed") {
    io.stdout(`::error::${site} preview failed: ${result.message ?? ""}`)
    return 1
  }
  if (result.state === "failing-checks")
    io.stdout(
      `::warning::${site} preview deployed, but failing its checks: ${result.message ?? ""}`,
    )
  return 0
}

const removePreview = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, ["worker", "name", "pr"])
  const worker = need(args, "worker")
  const pr = prNumber(one(args, "pr"))
  const name = one(args, "name") ?? (pr !== undefined ? pullRequestPreviewName(pr) : undefined)
  if (!name) throw new PreviewUsageError("--name or --pr is required")
  await removePreviewSite(cloudflare(deps, worker), name)
  io.stdout(`${worker}: Preview ${name} removed and confirmed gone`)
  return 0
}

const sweep = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, ["worker", "retention-days", "capacity", "repository", "open-prs"])
  const worker = need(args, "worker")
  const retentionDays = positive(one(args, "retention-days"), "retention-days", 7)
  const capacity = positive(one(args, "capacity"), "capacity", 80)
  if (!Number.isSafeInteger(capacity)) throw new PreviewUsageError("--capacity is an integer")
  const repository = one(args, "repository")
  const listed = one(args, "open-prs")
  let open: number[]
  if (listed !== undefined)
    open = listed
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((value) => {
        const number = prNumber(value)
        return number as number
      })
  else if (repository) open = await github(deps, repository).openPullRequests()
  else
    throw new PreviewUsageError(
      "--repository (to read open pull requests) or --open-prs is required",
    )
  const outcome = await sweepPreviews({
    previews: cloudflare(deps, worker),
    openPullRequests: open,
    retentionMs: retentionDays * 86_400_000,
    capacity,
    ...(deps.now ? { now: deps.now() } : {}),
  })
  for (const item of outcome.removed) io.stdout(`${worker}: removed ${item.name} (${item.reason})`)
  if (outcome.removed.length === 0) io.stdout(`${worker}: nothing to sweep`)
  // An open pull request whose Preview was swept says so in its description.
  if (repository && deps.env.GITHUB_TOKEN) {
    const gh = github(deps, repository)
    for (const item of outcome.removed) {
      const number = Number(PULL_REQUEST_PREVIEW.exec(item.name)?.[1])
      if (item.reason === "orphaned" || !open.includes(number) || outcome.left.includes(item.name))
        continue
      try {
        const { body } = await gh.pullRequest(number)
        const previous = readPreviewSection(body)
        if (!previous) continue
        const sites = (previous.sites ?? []).map((site) => ({ ...site, state: "expired" as const }))
        const next = upsertPreviewSection(body, { state: "expired", sites, repository })
        if (next !== body) await gh.setPullRequestBody(number, next)
      } catch (error) {
        io.stdout(`::warning::Could not mark #${number}'s preview expired: ${message(error)}`)
      }
    }
  }
  for (const failure of outcome.failures) io.stdout(`::error::${worker}: ${failure}`)
  if (outcome.left.length > 0) {
    io.stdout(`::error::${worker}: still listed after deletion: ${outcome.left.join(", ")}`)
    return 1
  }
  return outcome.failures.length > 0 ? 1 : 0
}

/** Every result file `deploy-preview --result` wrote under `dir`. */
export async function readPreviewResults(dir: string): Promise<PreviewSiteResult[]> {
  if (!existsSync(dir)) return []
  const results: PreviewSiteResult[] = []
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith(".json"))
        results.push(JSON.parse(await readFile(path, "utf8")) as PreviewSiteResult)
    }
  }
  await walk(dir)
  return results.sort((a, b) => a.site.localeCompare(b.site))
}

const sectionState = (result: PreviewSiteResult): PreviewSectionState =>
  result.state === "skipped" ? "deploying" : result.state

const prSection = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, ["repository", "pr", "state", "site", "results", "attempted", "run-url"])
  const repository = need(args, "repository")
  const pr = prNumber(need(args, "pr")) as number
  const results = await readPreviewResults(one(args, "results") ?? "")
  const named = args.get("site") ?? []
  const requested = one(args, "state")
  if (
    requested !== undefined &&
    requested !== "auto" &&
    !(PREVIEW_SECTION_STATES as readonly string[]).includes(requested)
  )
    throw new PreviewUsageError(`--state is auto or one of ${PREVIEW_SECTION_STATES.join(", ")}`)
  const sites: PreviewSectionSite[] = results.map((result) => ({
    name: result.site,
    ...(result.url ? { url: result.url } : {}),
    state: sectionState(result),
  }))
  for (const name of named)
    if (!sites.some((site) => site.name === name))
      sites.push({
        name,
        ...(requested && requested !== "auto" ? { state: requested as PreviewSectionState } : {}),
      })
  const state =
    requested && requested !== "auto"
      ? (requested as PreviewSectionState)
      : summarizePreviewState(sites.map((site) => site.state))
  const attempted = one(args, "attempted")
  const deployed = results.find((result) => result.deployed)?.deployed
  const runUrl = one(args, "run-url")
  const gh = github(deps, repository)
  const { body } = await gh.pullRequest(pr)
  const next = upsertPreviewSection(body, {
    state,
    sites,
    repository,
    ...(deps.env.GITHUB_SERVER_URL ? { serverUrl: deps.env.GITHUB_SERVER_URL } : {}),
    ...(attempted ? { attempted } : {}),
    ...(deployed ? { deployed } : {}),
    ...(runUrl ? { runUrl } : {}),
  })
  if (next !== body) await gh.setPullRequestBody(pr, next)
  io.stdout(`#${pr}: preview ${state}`)
  return 0
}

const deployment = async (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => {
  allow(args, ["repository", "environment", "ref", "state", "url", "run-url"])
  const gh = github(deps, need(args, "repository"))
  const environment = need(args, "environment")
  const state = need(args, "state")
  const runUrl = one(args, "run-url")
  const url = one(args, "url")
  if (state === "in_progress") {
    const id = await gh.startDeployment({
      environment,
      ref: need(args, "ref"),
      ...(runUrl ? { logUrl: runUrl } : {}),
    })
    io.stdout(`${environment}: deployment ${id} in_progress`)
  } else if (state === "success" || state === "failure") {
    const id = await gh.finishDeployment({
      environment,
      state,
      ...(runUrl ? { logUrl: runUrl } : {}),
      ...(url ? { environmentUrl: url } : {}),
    })
    io.stdout(`${environment}: deployment ${id} ${state}`)
  } else if (state === "removed") {
    const removed = await gh.removeDeployments(environment)
    io.stdout(`${environment}: ${removed.length} deployment(s) removed`)
  } else throw new PreviewUsageError("--state is in_progress, success, failure or removed")
  return 0
}

export const PREVIEW_COMMANDS: Record<
  string,
  (args: PreviewArgs, io: Io, deps: PreviewCliDeps) => Promise<number>
> = {
  "deploy-preview": deployPreview,
  "gate-preview": (args, io) => gatePreview(args, io),
  "check-preview": checkPreview,
  "remove-preview": removePreview,
  sweep,
  "pr-section": prSection,
  deployment,
}

export const PREVIEW_COMMANDS_USAGE = `  mockingbird-preview deploy-preview --worker <name> --outdir <dir> --commit <sha>
    (--pr <n> | --branch <name>) --repository <owner/name> [--site <name>] [--name <preview>]
    [--config <wrangler.json(c)>] [--host <domain>] [--checks <module> | --gate <file>]
    [--max-file-mib 25] [--max-files 20000] [--timeout-seconds <n>] [--result <file>]
  mockingbird-preview gate-preview --outdir <dir> --checks <module> --out <file> [--site <name>]
  mockingbird-preview check-preview --result <file> --checks <module> [--timeout-seconds <n>]
  mockingbird-preview remove-preview --worker <name> (--pr <n> | --name <preview>)
  mockingbird-preview sweep --worker <name> [--retention-days 7] [--capacity 80]
    (--repository <owner/name> | --open-prs <n,n,...>)
  mockingbird-preview pr-section --repository <owner/name> --pr <n> [--state auto|<state>]
    [--site <name>]... [--results <dir>] [--attempted <sha>] [--run-url <url>]
  mockingbird-preview deployment --repository <owner/name> --environment <env>
    --state in_progress|success|failure|removed [--ref <sha>] [--url <url>] [--run-url <url>]`
