#!/usr/bin/env bun
/**
 * Agentic PR-ready engine. Mechanical git/GitHub work for the /pr-ready command
 * (see .claude/commands/pr-ready.md); the agent only supplies judgment: commit
 * message, conflict resolution, PR title/body, and CI root-cause fixes.
 *
 *   bun scripts/pr-ready.ts <command> [flags]   # or: bun run pr:ready <command>
 *
 * Every command except `logs` prints exactly one JSON object on stdout.
 * `logs` prints a plain-text excerpt. Human/child noise never reaches stdout.
 *
 * Required check contexts mirror the job names in .github/workflows/ci.yml —
 * rename a job there and REQUIRED_CHECK_CONTEXTS must follow.
 */
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Operate on the repository of the current working directory: `bun run pr:ready`
// and `bun scripts/pr-ready.ts` both run from the repo root, and this keeps the
// engine usable against any checkout (e.g. a throwaway sandbox repo).
const root = process.cwd()

const BASE_DEFAULT = "main"
const RULESET_NAME = "Require CI on main"
const REQUIRED_CHECK_CONTEXTS = ["Commitlint", "Quality", "Test"]
const ACTIONS_INTEGRATION_ID = 15368

const EXIT = { ok: 0, fail: 1, usage: 2, conflicts: 3, pending: 4 } as const

const USAGE = `bun scripts/pr-ready.ts <command> [flags]

commands:
  status    snapshot: worktree, upstream, base, PR, checks
  context   compact commit/diff context for message generation
  commit    validate + stage + commit   (-m|--message-file, --amend, --path)
  publish   push the branch             (-u when new, --force-with-lease)
  sync      merge origin/<base>         (--continue after resolving conflicts)
  pr        view or create the PR       (--title, --body|--body-file, --ready)
  checks    poll PR checks to terminal  (--interval, --timeout, --once)
  logs      print a failing run log     (<check|run-url>, --name, --tail)
  ruleset   verify/apply merge gate     (--apply)

common flags:
  --base <branch>   base branch (default: origin/HEAD, else ${BASE_DEFAULT})`

// ---------------------------------------------------------------------------
// process + arg helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)

type RunOptions = { cwd?: string; env?: Record<string, string>; stdin?: string; raw?: boolean }

async function run(
  cmd: string[],
  opts?: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts?.stdin === undefined ? "ignore" : "pipe",
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  })
  if (opts?.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin)
    proc.stdin.end()
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return {
    code,
    stdout: opts?.raw ? stdout.replace(/\n+$/, "") : stdout.trim(),
    stderr: stderr.trim(),
  }
}

const git = (cmd: string[], opts?: RunOptions) => run(["git", ...cmd], opts)
const gh = (cmd: string[]) => run(["gh", ...cmd])

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function die(code: number, value: Record<string, unknown>): never {
  emit({ ok: false, ...value })
  process.exit(code)
}

function opt(...names: string[]): string | undefined {
  for (const name of names) {
    const i = argv.indexOf(name)
    if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1]
  }
  return undefined
}

function flag(name: string): boolean {
  return argv.includes(name)
}

async function removeFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// git / gh primitives
// ---------------------------------------------------------------------------

async function baseBranch(): Promise<string> {
  const explicit = opt("--base")
  if (explicit) return explicit
  const sym = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
  if (sym.code === 0 && sym.stdout) {
    const matched = sym.stdout.match(/refs\/remotes\/origin\/(.+)$/)
    const branch = matched?.[1]
    if (branch) return branch
  }
  return BASE_DEFAULT
}

async function currentBranch(): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout
}

async function headSha(): Promise<string> {
  return (await git(["rev-parse", "HEAD"])).stdout
}

async function ghAvailable(): Promise<boolean> {
  return (await gh(["auth", "status"])).code === 0
}

async function repoSlug(): Promise<string> {
  const res = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
  if (res.code !== 0 || !res.stdout) {
    throw new Error(res.stderr || "failed to resolve repository slug")
  }
  return res.stdout
}

async function remoteBranchExists(branch: string): Promise<boolean> {
  return (await git(["ls-remote", "--exit-code", "--heads", "origin", branch])).code === 0
}

async function mergeInProgress(): Promise<boolean> {
  const res = await git(["rev-parse", "--git-path", "MERGE_HEAD"])
  if (res.code !== 0 || !res.stdout) return false
  const path = res.stdout.startsWith("/") ? res.stdout : join(root, res.stdout)
  return await Bun.file(path).exists()
}

async function conflictFiles(): Promise<string[]> {
  const res = await git(["diff", "--name-only", "--diff-filter=U"])
  return res.stdout ? res.stdout.split("\n").filter(Boolean) : []
}

type Worktree = {
  dirty: boolean
  staged: boolean
  unstaged: boolean
  untracked: boolean
  files: string[]
}

async function worktreeStatus(): Promise<Worktree> {
  const res = await git(["status", "--porcelain"], { raw: true })
  const lines = res.stdout ? res.stdout.split("\n").filter(Boolean) : []
  let staged = false
  let unstaged = false
  let untracked = false
  const files: string[] = []
  for (const line of lines) {
    if (!line.startsWith("??")) {
      if (line.charAt(0) !== " ") staged = true
      if (line.charAt(1) !== " ") unstaged = true
    } else {
      untracked = true
    }
    if (files.length < 20) files.push(line.slice(3))
  }
  return { dirty: lines.length > 0, staged, unstaged, untracked, files }
}

// ---------------------------------------------------------------------------
// rulesets / required contexts
// ---------------------------------------------------------------------------

type RequiredStatusCheck = { context: string; integration_id?: number }

type RulesetRule = {
  type: string
  parameters?: {
    strict_required_status_checks_policy?: boolean
    do_not_enforce_on_create?: boolean
    required_status_checks?: RequiredStatusCheck[]
  }
}

type RulesetDetail = {
  id: number
  name: string
  enforcement?: string
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }
  rules?: RulesetRule[]
}

type RulesetSummary = { id: number; name: string }

async function requiredContexts(): Promise<string[]> {
  try {
    const slug = await repoSlug()
    const listed = await gh(["api", `repos/${slug}/rulesets`])
    if (listed.code !== 0) return [...REQUIRED_CHECK_CONTEXTS]
    const summaries = JSON.parse(listed.stdout) as RulesetSummary[]
    const base = await baseBranch()
    for (const summary of summaries) {
      const detailRes = await gh(["api", `repos/${slug}/rulesets/${summary.id}`])
      if (detailRes.code !== 0) continue
      const detail = JSON.parse(detailRes.stdout) as RulesetDetail
      const include = detail.conditions?.ref_name?.include ?? []
      const rule = detail.rules?.find((entry) => entry.type === "required_status_checks")
      if (rule && include.includes(`refs/heads/${base}`)) {
        const contexts = (rule.parameters?.required_status_checks ?? []).map((c) => c.context)
        if (contexts.length > 0) return contexts
      }
    }
    return [...REQUIRED_CHECK_CONTEXTS]
  } catch {
    return [...REQUIRED_CHECK_CONTEXTS]
  }
}

type RulesetVerification = {
  ok: boolean
  rulesetId: number | null
  requiredContexts: string[]
  strict: boolean
  drift: string[]
}

async function verifyRuleset(slug: string, base: string, existingId: number | null) {
  if (existingId === null) {
    return {
      ok: false,
      rulesetId: null,
      requiredContexts: [],
      strict: false,
      drift: [`ruleset "${RULESET_NAME}" not found`],
    } satisfies RulesetVerification
  }
  const detailRes = await gh(["api", `repos/${slug}/rulesets/${existingId}`])
  if (detailRes.code !== 0) {
    return {
      ok: false,
      rulesetId: existingId,
      requiredContexts: [],
      strict: false,
      drift: [detailRes.stderr || "failed to read ruleset"],
    } satisfies RulesetVerification
  }
  const detail = JSON.parse(detailRes.stdout) as RulesetDetail
  const drift: string[] = []
  if (detail.enforcement !== "active") drift.push(`enforcement=${detail.enforcement ?? "missing"}`)
  const include = detail.conditions?.ref_name?.include ?? []
  if (!include.includes(`refs/heads/${base}`)) drift.push(`include=[${include.join(",")}]`)
  const rule = detail.rules?.find((entry) => entry.type === "required_status_checks")
  const contexts = (rule?.parameters?.required_status_checks ?? []).map((c) => c.context).sort()
  const expected = [...REQUIRED_CHECK_CONTEXTS].sort()
  if (JSON.stringify(contexts) !== JSON.stringify(expected)) {
    drift.push(`contexts=[${contexts.join(",")}]`)
  }
  const strict = rule?.parameters?.strict_required_status_checks_policy === true
  if (!strict) drift.push("strict_required_status_checks_policy=false")
  return {
    ok: drift.length === 0,
    rulesetId: existingId,
    requiredContexts: contexts,
    strict,
    drift,
  } satisfies RulesetVerification
}

async function findRulesetId(slug: string): Promise<number | null> {
  const listed = await gh(["api", `repos/${slug}/rulesets`])
  if (listed.code !== 0) return null
  const summaries = JSON.parse(listed.stdout) as RulesetSummary[]
  return summaries.find((entry) => entry.name === RULESET_NAME)?.id ?? null
}

// ---------------------------------------------------------------------------
// PR + checks
// ---------------------------------------------------------------------------

type PrView = {
  number: number
  url: string
  state: string
  title?: string
  isDraft?: boolean
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string
  baseRefName?: string
  headRefName?: string
}

type Check = { name: string; state: string; bucket: string; link: string; workflow?: string }

type CheckFetch = { ok: true; reported: boolean; checks: Check[] } | { ok: false; reason: string }

async function fetchChecks(branch: string): Promise<CheckFetch> {
  const res = await gh(["pr", "checks", branch, "--json", "name,state,bucket,link,workflow"])
  if (res.code === 0) {
    return { ok: true, reported: true, checks: JSON.parse(res.stdout) as Check[] }
  }
  if (/no checks reported/i.test(res.stderr) || /no checks reported/i.test(res.stdout)) {
    return { ok: true, reported: false, checks: [] }
  }
  return { ok: false, reason: res.stderr || res.stdout || "gh pr checks failed" }
}

type ChecksSummary = {
  total: number
  pass: number
  fail: number
  pending: number
  skipping: number
  cancel: number
  failing: { name: string; state: string; bucket: string; link: string }[]
  notRequired: string[]
}

function summarize(checks: Check[], required: string[]): ChecksSummary {
  const summary: ChecksSummary = {
    total: checks.length,
    pass: 0,
    fail: 0,
    pending: 0,
    skipping: 0,
    cancel: 0,
    failing: [],
    notRequired: [],
  }
  for (const check of checks) {
    switch (check.bucket) {
      case "pass":
        summary.pass++
        break
      case "skipping":
        summary.skipping++
        break
      case "fail":
        summary.fail++
        summary.failing.push({
          name: check.name,
          state: check.state,
          bucket: check.bucket,
          link: check.link,
        })
        break
      case "cancel":
        summary.cancel++
        summary.failing.push({
          name: check.name,
          state: check.state,
          bucket: check.bucket,
          link: check.link,
        })
        break
      case "pending":
        summary.pending++
        break
      default:
        break
    }
  }
  summary.notRequired = checks.map((c) => c.name).filter((name) => !required.includes(name))
  return summary
}

function pendingList(checks: Check[]): { name: string; bucket: string; link: string }[] {
  return checks
    .filter((check) => check.bucket === "pending")
    .map((check) => ({ name: check.name, bucket: check.bucket, link: check.link }))
}

async function readPr(branch: string): Promise<PrView | null> {
  const res = await gh([
    "pr",
    "view",
    branch,
    "--json",
    "number,url,state,title,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefName",
  ])
  if (res.code !== 0) return null
  return JSON.parse(res.stdout) as PrView
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdStatus(): Promise<void> {
  const branch = await currentBranch()
  const base = await baseBranch()
  const worktree = await worktreeStatus()
  const upstreamRes = await git(["rev-parse", "--abbrev-ref", "@{u}"])
  const upstream = upstreamRes.code === 0 && upstreamRes.stdout ? upstreamRes.stdout : null

  let ahead = 0
  let behindUpstream = 0
  if (upstream) {
    const counts = await git(["rev-list", "--left-right", "--count", "@{u}...HEAD"])
    if (counts.code === 0) {
      const [behind, forward] = counts.stdout.split(/\s+/)
      behindUpstream = Number(behind) || 0
      ahead = Number(forward) || 0
    }
  }

  let behindBase = 0
  if ((await git(["fetch", "--quiet", "origin", base])).code === 0) {
    const count = await git(["rev-list", "--count", `HEAD..origin/${base}`])
    if (count.code === 0) behindBase = Number(count.stdout) || 0
  }

  const hasGh = await ghAvailable()
  const required = hasGh ? await requiredContexts() : [...REQUIRED_CHECK_CONTEXTS]

  let pr: PrView | null = null
  let checks: ChecksSummary | null = null
  if (hasGh) {
    pr = await readPr(branch)
    if (pr) {
      const fetched = await fetchChecks(branch)
      if (fetched.ok) checks = summarize(fetched.checks, required)
    }
  }

  emit({
    ok: true,
    branch,
    base,
    worktree,
    upstream,
    remoteBranchExists: await remoteBranchExists(branch),
    ahead,
    behindBase,
    behindUpstream,
    mergeInProgress: await mergeInProgress(),
    conflicts: await conflictFiles(),
    pr,
    checks,
    requiredContexts: required,
  })
}

async function cmdContext(): Promise<void> {
  const branch = await currentBranch()
  const base = await baseBranch()

  const commitsRes = await git(["log", "--oneline", `origin/${base}..HEAD`])
  let commits = commitsRes.code === 0 ? commitsRes.stdout.split("\n").filter(Boolean) : []
  if (commitsRes.code !== 0) {
    const fallback = await git(["log", "--oneline", `${base}..HEAD`])
    if (fallback.code === 0) commits = fallback.stdout.split("\n").filter(Boolean)
  }

  const stat = await git(["diff", "--stat", `origin/${base}...HEAD`])
  const names = await git(["diff", "--name-status", `origin/${base}...HEAD`])
  const worktree = await worktreeStatus()

  emit({
    ok: true,
    branch,
    base,
    commits,
    diffstat: stat.code === 0 ? stat.stdout : "",
    files: names.code === 0 ? names.stdout.split("\n").filter(Boolean) : [],
    uncommitted: worktree.files,
  })
}

async function cmdCommit(): Promise<void> {
  const message = opt("--message", "-m")
  const messageFile = opt("--message-file")
  if ((message === undefined) === (messageFile === undefined)) {
    die(EXIT.usage, {
      error: "commit needs exactly one of --message/-m or --message-file",
      usage: USAGE,
    })
  }
  const amend = flag("--amend")
  const paths: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--path" && argv[i + 1] !== undefined) paths.push(argv[i + 1])
  }

  const text =
    messageFile !== undefined ? (await Bun.file(messageFile).text()).trim() : (message ?? "")
  if (!text) die(EXIT.usage, { error: "empty commit message", usage: USAGE })

  const msgPath = join(tmpdir(), `pr-ready-commit-msg-${process.pid}.txt`)
  await Bun.write(msgPath, `${text}\n`)

  const lint = await run(["bunx", "--no", "--", "commitlint", "--edit", msgPath])
  if (lint.code !== 0) {
    await removeFile(msgPath)
    die(EXIT.fail, {
      step: "commitlint",
      message: text,
      output: lint.stderr || lint.stdout,
      hint: "Conventional Commits: <type>(scope): <description>, header <= 120 chars",
    })
  }

  const staged =
    paths.length === 0 ? await git(["add", "--all"]) : await git(["add", "--", ...paths])
  if (staged.code !== 0) {
    await removeFile(msgPath)
    die(EXIT.fail, { step: "stage", output: staged.stderr || staged.stdout })
  }

  if (!amend && (await git(["diff", "--cached", "--quiet"])).code === 0) {
    await removeFile(msgPath)
    emit({ ok: true, committed: false, reason: "nothing-to-commit" })
    return
  }

  const args = ["commit", "-F", msgPath]
  if (amend) args.push("--amend")
  const committed = await git(args)
  await removeFile(msgPath)
  if (committed.code !== 0) {
    die(EXIT.fail, { step: "commit", output: committed.stderr || committed.stdout })
  }

  emit({
    ok: true,
    committed: true,
    amended: amend,
    sha: await headSha(),
    subject: (await git(["log", "-1", "--pretty=%s"])).stdout,
  })
}

async function cmdPublish(): Promise<void> {
  const branch = await currentBranch()
  const base = await baseBranch()
  if (branch === base) {
    die(EXIT.usage, { error: "refusing to publish the base branch" })
  }

  const upstreamRes = await git(["rev-parse", "--abbrev-ref", "@{u}"])
  const upstream = upstreamRes.code === 0 && upstreamRes.stdout ? upstreamRes.stdout : null
  const exists = await remoteBranchExists(branch)
  const args = ["push"]
  if (!upstream || !exists) {
    args.push("-u", "origin", "HEAD")
  } else if (flag("--force-with-lease")) {
    args.push("--force-with-lease")
  }

  const pushed = await git(args)
  if (pushed.code !== 0) {
    die(EXIT.fail, { step: "push", output: pushed.stderr || pushed.stdout })
  }

  const combined = `${pushed.stdout}\n${pushed.stderr}`
  emit({
    ok: true,
    branch,
    upstream: `origin/${branch}`,
    remoteBranchExists: true,
    pushed: !/Everything up-to-date/i.test(combined),
    sha: await headSha(),
  })
}

async function cmdSync(): Promise<void> {
  const base = await baseBranch()
  const merging = await mergeInProgress()

  if (flag("--continue")) {
    if (!merging) die(EXIT.usage, { error: "no merge in progress to continue" })
    const conflicts = await conflictFiles()
    if (conflicts.length > 0) {
      die(EXIT.conflicts, {
        step: "sync",
        conflicts,
        hint: "resolve, git add <files>, re-run sync --continue",
      })
    }
    const merged = await git(["-c", "core.editor=true", "merge", "--continue"], {
      env: { GIT_EDITOR: "true" },
    })
    if (merged.code !== 0) {
      die(EXIT.fail, { step: "merge-continue", output: merged.stderr || merged.stdout })
    }
    emit({ ok: true, continued: true, sha: await headSha(), conflicts: [] })
    return
  }

  const worktree = await worktreeStatus()
  if (merging) {
    die(EXIT.usage, {
      error: "a merge is in progress; resolve conflicts then re-run sync --continue",
    })
  }
  if (worktree.dirty) {
    die(EXIT.usage, {
      error: "worktree not clean; commit first (bun scripts/pr-ready.ts commit …)",
    })
  }

  const fetched = await git(["fetch", "origin", base])
  if (fetched.code !== 0) {
    die(EXIT.fail, { step: "fetch", output: fetched.stderr || fetched.stdout })
  }

  const count = await git(["rev-list", "--count", `HEAD..origin/${base}`])
  const behindBase = count.code === 0 ? Number(count.stdout) || 0 : 0
  if (behindBase === 0) {
    emit({ ok: true, alreadyUpToDate: true, sha: await headSha(), behindBase: 0 })
    return
  }

  const merged = await git(["merge", "--no-edit", `origin/${base}`])
  const conflicts = await conflictFiles()
  if (conflicts.length > 0) {
    die(EXIT.conflicts, {
      step: "merge",
      base,
      behindBase,
      conflicts,
      hint: "resolve both intents, git add <files>, re-run sync --continue",
    })
  }
  if (merged.code !== 0) {
    die(EXIT.fail, { step: "merge", output: merged.stderr || merged.stdout })
  }

  emit({
    ok: true,
    merged: true,
    base,
    mergeCommit: await headSha(),
    pushNeeded: true,
  })
}

async function cmdPr(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const branch = await currentBranch()
  const base = await baseBranch()

  const existing = await readPr(branch)
  if (existing) {
    let pr = existing
    if (flag("--ready") && existing.isDraft) {
      const ready = await gh(["pr", "ready", branch])
      if (ready.code === 0) pr = { ...existing, isDraft: false }
    }
    emit({ ok: true, created: false, ...pr })
    return
  }

  const title = opt("--title")
  const body = opt("--body")
  const bodyFile = opt("--body-file")
  if (!title || (body === undefined) === (bodyFile === undefined)) {
    die(EXIT.usage, {
      error: `no PR for ${branch}; supply --title and exactly one of --body/--body-file`,
      usage: USAGE,
    })
  }
  if (!(await remoteBranchExists(branch))) {
    die(EXIT.usage, { error: "branch not on origin; run publish first" })
  }

  let bodyPath = bodyFile
  let tempBody: string | null = null
  if (bodyPath === undefined) {
    tempBody = join(tmpdir(), `pr-ready-pr-body-${process.pid}.md`)
    await Bun.write(tempBody, body ?? "")
    bodyPath = tempBody
  }

  const created = await gh([
    "pr",
    "create",
    "--base",
    base,
    "--head",
    branch,
    "--title",
    title,
    "--body-file",
    bodyPath,
  ])
  if (tempBody) await removeFile(tempBody)
  if (created.code !== 0) {
    die(EXIT.fail, { step: "pr-create", output: created.stderr || created.stdout })
  }

  const pr = await readPr(branch)
  emit({
    ok: true,
    created: true,
    number: pr?.number ?? null,
    url: pr?.url ?? created.stdout,
    baseRefName: pr?.baseRefName ?? base,
    headRefName: pr?.headRefName ?? branch,
  })
}

async function cmdChecks(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const branch = await currentBranch()
  const interval = Number(opt("--interval") ?? 20)
  const timeout = Number(opt("--timeout") ?? 1800)
  const once = flag("--once")

  if ((await gh(["pr", "view", branch, "--json", "number"])).code !== 0) {
    die(EXIT.usage, { error: "no PR; run `pr` first" })
  }

  const required = await requiredContexts()
  const started = Date.now()

  while (true) {
    const fetched = await fetchChecks(branch)
    if (!fetched.ok) die(EXIT.fail, { step: "checks", output: fetched.reason })
    const { checks } = fetched
    const summary = summarize(checks, required)
    const pending = fetched.reported ? pendingList(checks) : []

    if (fetched.reported && summary.pending === 0) {
      if (summary.fail + summary.cancel === 0) {
        emit({
          ok: true,
          total: summary.total,
          pass: summary.pass,
          skipping: summary.skipping,
          notRequired: summary.notRequired,
          checks: checks.map((check) => ({
            name: check.name,
            bucket: check.bucket,
            link: check.link,
          })),
        })
        return
      }
      die(EXIT.fail, {
        failing: summary.failing,
        pass: summary.pass,
        pending: 0,
        notRequired: summary.notRequired,
      })
    }

    if (once) die(EXIT.pending, { pending, timedOut: false })
    if ((Date.now() - started) / 1000 >= timeout) {
      die(EXIT.pending, { pending, timedOut: true })
    }
    await Bun.sleep(interval * 1000)
  }
}

async function cmdLogs(): Promise<void> {
  const target = opt("--name") ?? argv[1]
  if (!target) die(EXIT.usage, { error: "logs needs a check name or run URL", usage: USAGE })

  let runId: string | null = null
  const urlMatch = target.match(/\/actions\/runs\/(\d+)/)
  if (urlMatch?.[1]) {
    runId = urlMatch[1]
  } else {
    const branch = await currentBranch()
    const listed = await gh(["pr", "checks", branch, "--json", "name,link"])
    if (listed.code !== 0) {
      die(EXIT.fail, { step: "logs", output: listed.stderr || listed.stdout })
    }
    const checks = JSON.parse(listed.stdout) as { name: string; link: string }[]
    const match = checks.find((check) => check.name === target)
    if (!match) {
      die(EXIT.usage, { error: "unknown check", available: checks.map((c) => c.name) })
    }
    runId = match.link.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null
    if (!runId) die(EXIT.usage, { error: "check has no actions run link", name: target })
  }

  const view = await gh(["run", "view", runId, "--log-failed"])
  if (view.code !== 0) {
    die(EXIT.fail, { step: "logs", output: view.stderr || view.stdout })
  }

  const lines = view.stdout.split("\n")
  const tail = Number(opt("--tail") ?? 120)
  const shown =
    lines.length > tail
      ? [`… ${lines.length - tail} earlier lines omitted`, ...lines.slice(-tail)]
      : lines
  process.stdout.write(`${shown.join("\n")}\n`)
}

async function cmdRuleset(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const base = await baseBranch()
  const slug = await repoSlug()
  const existingId = await findRulesetId(slug)

  if (flag("--apply")) {
    const desired = {
      name: RULESET_NAME,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: [`refs/heads/${base}`], exclude: [] } },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: false,
            required_status_checks: REQUIRED_CHECK_CONTEXTS.map((context) => ({
              context,
              integration_id: ACTIONS_INTEGRATION_ID,
            })),
          },
        },
      ],
    }
    const path =
      existingId === null ? `repos/${slug}/rulesets` : `repos/${slug}/rulesets/${existingId}`
    const method = existingId === null ? "POST" : "PUT"
    const applied = await run(["gh", "api", "--method", method, path, "--input", "-"], {
      stdin: JSON.stringify(desired),
    })
    if (applied.code !== 0) {
      die(EXIT.fail, {
        step: "ruleset-apply",
        output: applied.stderr || applied.stdout,
        hint: "ruleset writes require repo admin",
      })
    }
    const nextId = await findRulesetId(slug)
    const verification = await verifyRuleset(slug, base, nextId)
    emit({ ...verification, applied: true })
    process.exit(verification.ok ? EXIT.ok : EXIT.fail)
  }

  const verification = await verifyRuleset(slug, base, existingId)
  emit(verification)
  process.exit(verification.ok ? EXIT.ok : EXIT.fail)
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const first = argv[0]
  const command = first && !first.startsWith("-") ? first : "status"
  switch (command) {
    case "status":
      return cmdStatus()
    case "context":
      return cmdContext()
    case "commit":
      return cmdCommit()
    case "publish":
      return cmdPublish()
    case "sync":
      return cmdSync()
    case "pr":
      return cmdPr()
    case "checks":
      return cmdChecks()
    case "logs":
      return cmdLogs()
    case "ruleset":
      return cmdRuleset()
    default:
      die(EXIT.usage, { error: `unknown command: ${command}`, usage: USAGE })
  }
}

await main()
