#!/usr/bin/env bun
/**
 * Agentic PR-merge engine. Mechanical git/GitHub work for the /pr-merge command
 * (see .agents/commands/pr-merge.md); the agent only supplies judgment: commit
 * message, conflict resolution, PR title/body, and CI root-cause fixes.
 *
 *   bun scripts/pr-merge.ts <command> [flags]   # or: bun run pr:merge <command>
 *
 * Every command except `logs` prints exactly one JSON object on stdout.
 * `logs` prints a plain-text excerpt. Human/child noise never reaches stdout.
 *
 * Every check that runs on a PR is required. The contexts mirror the job names in
 * .github/workflows/ci.yml (rename a job there and REQUIRED_CHECKS must follow) plus the
 * GitGuardian app's check; each is pinned to the app that reports it.
 */
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Operate on the repository of the current working directory: `bun run pr:merge`
// and `bun scripts/pr-merge.ts` both run from the repo root, and this keeps the
// engine usable against any checkout (e.g. a throwaway sandbox repo).
const root = process.cwd()

const TRUNK_BRANCH = "main"
const RULESET_NAME = "Protect main"
const LEGACY_RULESET_NAMES = ["Require CI on main"]
const ACTIONS_INTEGRATION_ID = 15368
const GITGUARDIAN_INTEGRATION_ID = 46505
/** Release is left out: it only runs on pushes to main, never on a PR. */
const REQUIRED_CHECKS: RequiredStatusCheck[] = [
  { context: "Required", integration_id: ACTIONS_INTEGRATION_ID },
  { context: "Commitlint", integration_id: ACTIONS_INTEGRATION_ID },
  { context: "Check", integration_id: ACTIONS_INTEGRATION_ID },
  { context: "GitGuardian Security Checks", integration_id: GITGUARDIAN_INTEGRATION_ID },
]
const REQUIRED_CHECK_CONTEXTS = REQUIRED_CHECKS.map((check) => check.context)
const ALLOWED_MERGE_METHODS = ["merge"]

const EXIT = { ok: 0, fail: 1, usage: 2, conflicts: 3, pending: 4 } as const

const USAGE = `bun scripts/pr-merge.ts <command> [flags]

commands:
  advance   sync, publish, upsert PR, check, review comments, merge
            (--title, --body-file, --timeout, --comments-reviewed)
  status    snapshot: worktree, upstream, base, PR, checks
  context   compact commit/diff context for message generation
  commit    validate + stage + commit   (-m|--message-file, --amend, --path)
  publish   push the branch             (-u when new, --force-with-lease)
  sync      merge remote head and base (--continue after resolving conflicts)
  pr        view or create the PR       (--title, --body|--body-file, --ready)
  comments  unresolved review threads and recent PR comments
  reply     reply to a review thread   (--thread, --body|--body-file)
  resolve   mark an addressed thread resolved (--thread)
  checks    poll PR checks to terminal  (--interval, --timeout, --once)
  logs      print a failing check's log (<check|run-url>, --name, --tail); third-party
            checks (GitGuardian, …) print their check-run report
  rerun     re-run a failed check       (<check>, --name)
  guardian  GitGuardian incidents on the PR head   (list | ignore --incident <id>
            --reason test_credential|false_positive|low_risk; needs GITGUARDIAN_API_KEY)
  ruleset   verify/apply merge gate     (--apply)
  repo      verify/apply repo settings  (--apply)
  merge     land the PR once pushed, synced and every check green (--auto, --dry-run)

common flags:
  --base <branch>   trunk branch (${TRUNK_BRANCH}); any other value is rejected`

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
  return TRUNK_BRANCH
}

function requireTrunk(base: string): void {
  if (base !== TRUNK_BRANCH) {
    die(EXIT.usage, { error: `base must be ${TRUNK_BRANCH} (trunk); got ${base}`, usage: USAGE })
  }
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

type RulesetRuleParameters = {
  strict_required_status_checks_policy?: boolean
  do_not_enforce_on_create?: boolean
  required_status_checks?: RequiredStatusCheck[]
  allowed_merge_methods?: string[]
  dismiss_stale_reviews_on_push?: boolean
  require_code_owner_review?: boolean
  require_last_push_approval?: boolean
  required_approving_review_count?: number
  required_review_thread_resolution?: boolean
}

type RulesetRule = { type: string; parameters?: RulesetRuleParameters }

type RulesetDetail = {
  id: number
  name: string
  enforcement?: string
  bypass_actors?: unknown[]
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

type CanonicalRule = { type: string; parameters?: RulesetRuleParameters }

type CanonicalRuleset = {
  name: string
  target: string
  enforcement: string
  bypass_actors: unknown[]
  conditions: { ref_name: { include: string[]; exclude: string[] } }
  rules: CanonicalRule[]
}

// Single source of truth for the trunk merge gate; `verify` and `--apply` both consume it,
// so verification can never drift from what is applied.
function canonicalRuleset(base: string): CanonicalRuleset {
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${base}`], exclude: [] } },
    rules: [
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ALLOWED_MERGE_METHODS,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: REQUIRED_CHECKS,
        },
      },
      { type: "deletion" },
      { type: "non_fast_forward" },
    ],
  }
}

// Compares only the fields we model — the API returns extra fields per rule, so blanket
// JSON equality would report permanent false drift.
function ruleDrift(found: RulesetRule, want: CanonicalRule): string[] {
  const drift: string[] = []
  const live = found.parameters ?? {}
  const expected = want.parameters ?? {}
  if (want.type === "required_status_checks") {
    // A context and the app that must report it: a same-named check from another app is drift.
    const key = (c: RequiredStatusCheck) => `${c.context}@${c.integration_id ?? "any"}`
    const contexts = (live.required_status_checks ?? []).map(key).sort()
    const wanted = (expected.required_status_checks ?? []).map(key).sort()
    if (JSON.stringify(contexts) !== JSON.stringify(wanted)) {
      drift.push(`contexts=[${contexts.join(",")}]`)
    }
    if (live.strict_required_status_checks_policy !== true) {
      drift.push("strict_required_status_checks_policy=false")
    }
    if (live.do_not_enforce_on_create !== false) {
      drift.push("do_not_enforce_on_create=true")
    }
  }
  if (want.type === "pull_request") {
    const allowed = [...(live.allowed_merge_methods ?? [])].sort()
    const wanted = [...(expected.allowed_merge_methods ?? [])].sort()
    if (JSON.stringify(allowed) !== JSON.stringify(wanted)) {
      drift.push(`allowed_merge_methods=[${allowed.join(",")}]`)
    }
    const booleanFields = [
      "dismiss_stale_reviews_on_push",
      "require_code_owner_review",
      "require_last_push_approval",
      "required_review_thread_resolution",
    ] as const
    for (const field of booleanFields) {
      if (live[field] !== expected[field]) {
        drift.push(`${field}=${live[field] ?? "missing"}`)
      }
    }
    if (live.required_approving_review_count !== expected.required_approving_review_count) {
      drift.push(
        `required_approving_review_count=${live.required_approving_review_count ?? "missing"}`,
      )
    }
  }
  return drift
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
  const want = canonicalRuleset(base)
  const drift: string[] = []
  if (detail.enforcement !== "active") drift.push(`enforcement=${detail.enforcement ?? "missing"}`)
  const bypass = (detail.bypass_actors ?? []).length
  if (bypass > 0) drift.push(`bypass_actors=${bypass}`)
  const include = detail.conditions?.ref_name?.include ?? []
  if (JSON.stringify([...include].sort()) !== JSON.stringify([`refs/heads/${base}`])) {
    drift.push(`include=[${include.join(",")}]`)
  }
  const liveRules = detail.rules ?? []
  for (const wantRule of want.rules) {
    const found = liveRules.find((entry) => entry.type === wantRule.type)
    if (!found) {
      drift.push(`missing rule ${wantRule.type}`)
      continue
    }
    drift.push(...ruleDrift(found, wantRule).map((entry) => `${wantRule.type}: ${entry}`))
  }
  const wantedTypes = want.rules.map((entry) => entry.type)
  for (const rule of liveRules) {
    if (!wantedTypes.includes(rule.type)) drift.push(`unexpected rule ${rule.type}`)
  }
  const requiredRule = liveRules.find((entry) => entry.type === "required_status_checks")
  const contexts = (requiredRule?.parameters?.required_status_checks ?? [])
    .map((c) => c.context)
    .sort()
  return {
    ok: drift.length === 0,
    rulesetId: existingId,
    requiredContexts: contexts,
    strict: requiredRule?.parameters?.strict_required_status_checks_policy === true,
    drift,
  } satisfies RulesetVerification
}

async function findRulesetId(slug: string): Promise<number | null> {
  const listed = await gh(["api", `repos/${slug}/rulesets`])
  if (listed.code !== 0) return null
  const summaries = JSON.parse(listed.stdout) as RulesetSummary[]
  return summaries.find((entry) => entry.name === RULESET_NAME)?.id ?? null
}

async function removeLegacyRulesets(slug: string): Promise<string[]> {
  const listed = await gh(["api", `repos/${slug}/rulesets`])
  if (listed.code !== 0) return []
  const summaries = JSON.parse(listed.stdout) as RulesetSummary[]
  const removed: string[] = []
  for (const summary of summaries) {
    if (!LEGACY_RULESET_NAMES.includes(summary.name)) continue
    const res = await gh(["api", "--method", "DELETE", `repos/${slug}/rulesets/${summary.id}`])
    if (res.code === 0) removed.push(summary.name)
  }
  return removed
}

// ---------------------------------------------------------------------------
// repo settings
// ---------------------------------------------------------------------------

const REPO_SETTINGS = {
  default_branch: TRUNK_BRANCH,
  allow_merge_commit: true,
  allow_squash_merge: false,
  allow_rebase_merge: false,
  allow_auto_merge: true,
  allow_update_branch: true,
  delete_branch_on_merge: true,
}

async function repoDrift(
  slug: string,
): Promise<{ drift: string[]; settings: Record<string, unknown> }> {
  const res = await gh(["api", `repos/${slug}`])
  if (res.code !== 0) throw new Error(res.stderr || "failed to read repo settings")
  const settings = JSON.parse(res.stdout) as Record<string, unknown>
  const drift: string[] = []
  for (const [key, want] of Object.entries(REPO_SETTINGS)) {
    const got = settings[key]
    if (got !== want) drift.push(`${key}=${String(got)} (want ${String(want)})`)
  }
  return { drift, settings }
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
  headRefOid?: string
}

type Check = { name: string; state: string; bucket: string; link: string; workflow?: string }

type CheckFetch = { ok: true; reported: boolean; checks: Check[] } | { ok: false; reason: string }

async function fetchChecks(branch: string): Promise<CheckFetch> {
  const res = await gh(["pr", "checks", branch, "--json", "name,state,bucket,link,workflow"])
  // gh exits nonzero for failing or pending checks even when --json returned valid data.
  if (res.stdout.startsWith("[")) {
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

/** A GitHub check run, as reported by any app (Actions or third-party, e.g. GitGuardian). */
type CheckRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  html_url: string | null
  details_url: string | null
  app?: { slug: string; name: string } | null
  check_suite?: { id: number } | null
  output?: { title: string | null; summary: string | null; text: string | null } | null
}

/** The newest check runs named `name` on the PR head commit. */
async function checkRunsByName(slug: string, sha: string, name: string): Promise<CheckRun[]> {
  const res = await gh([
    "api",
    `repos/${slug}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`,
  ])
  if (res.code !== 0) die(EXIT.fail, { step: "check-runs", output: res.stderr || res.stdout })
  return (JSON.parse(res.stdout) as { check_runs: CheckRun[] }).check_runs
}

async function prHeadSha(branch: string): Promise<string> {
  const pr = await readPr(branch)
  if (!pr?.headRefOid) die(EXIT.usage, { error: `no PR for ${branch}; run \`pr\` first` })
  return pr.headRefOid
}

async function readPr(branch: string): Promise<PrView | null> {
  const res = await gh([
    "pr",
    "view",
    branch,
    "--json",
    "number,url,state,title,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefName,headRefOid",
  ])
  if (res.code !== 0) return null
  return JSON.parse(res.stdout) as PrView
}

type ReviewThread = {
  id: string
  isResolved: boolean
  isOutdated: boolean
  comments: {
    nodes: {
      body: string
      url: string
      path: string | null
      line: number | null
      author: { login: string } | null
    }[]
  }
}

async function unresolvedThreads(slug: string, number: number): Promise<ReviewThread[]> {
  const [owner, name] = slug.split("/")
  const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
    repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated comments(last:3){nodes{body url path line author{login}}}}
    }}}
  }`
  const threads: ReviewThread[] = []
  let cursor: string | null = null
  while (true) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ]
    if (cursor) args.push("-F", `cursor=${cursor}`)
    const result = await gh(args)
    if (result.code !== 0)
      die(EXIT.fail, { step: "comments", output: result.stderr || result.stdout })
    const page = (
      JSON.parse(result.stdout) as {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null }
                nodes: ReviewThread[]
              }
            }
          }
        }
      }
    ).data.repository.pullRequest.reviewThreads
    threads.push(...page.nodes.filter((thread) => !thread.isResolved))
    if (!page.pageInfo.hasNextPage) return threads
    cursor = page.pageInfo.endCursor
  }
}

async function cmdComments(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const branch = await currentBranch()
  const pr = await readPr(branch)
  if (!pr) die(EXIT.usage, { error: `no PR for ${branch}; run \`pr\` first` })
  const [slug, details] = await Promise.all([
    repoSlug(),
    gh(["pr", "view", branch, "--json", "comments"]),
  ])
  if (details.code !== 0) die(EXIT.fail, { step: "comments", output: details.stderr })
  const threads = await unresolvedThreads(slug, pr.number)
  const comments = (
    JSON.parse(details.stdout) as {
      comments: {
        body: string
        url: string
        author: { login: string } | null
      }[]
    }
  ).comments
  emit({
    ok: true,
    number: pr.number,
    url: pr.url,
    unresolvedThreads: threads.map((thread) => ({
      id: thread.id,
      outdated: thread.isOutdated,
      comments: thread.comments.nodes.map((comment) => ({
        ...comment,
        body: comment.body.slice(0, 1000),
      })),
    })),
    recentComments: comments.slice(-10).map((comment) => ({
      ...comment,
      body: comment.body.slice(0, 1000),
    })),
  })
}

async function cmdReply(): Promise<void> {
  const id = opt("--thread")
  const body = opt("--body")
  const bodyFile = opt("--body-file")
  if (!id || (body === undefined) === (bodyFile === undefined)) {
    die(EXIT.usage, { error: "reply needs --thread and exactly one of --body/--body-file" })
  }
  const text = bodyFile ? (await Bun.file(bodyFile).text()).trim() : body
  if (!text) die(EXIT.usage, { error: "reply body is empty" })
  const query = `mutation($id:ID!,$body:String!){
    addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){
      comment{id url}
    }
  }`
  const result = await gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `id=${id}`,
    "-F",
    `body=${text}`,
  ])
  if (result.code !== 0) die(EXIT.fail, { step: "reply", output: result.stderr || result.stdout })
  emit({ ok: true, thread: id, reply: JSON.parse(result.stdout) })
}

async function cmdResolve(): Promise<void> {
  const id = opt("--thread")
  if (!id) die(EXIT.usage, { error: "resolve needs --thread" })
  const query = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`
  const result = await gh(["api", "graphql", "-f", `query=${query}`, "-F", `id=${id}`])
  if (result.code !== 0) die(EXIT.fail, { step: "resolve", output: result.stderr || result.stdout })
  emit({ ok: true, thread: id, result: JSON.parse(result.stdout) })
}

async function cmdAdvance(): Promise<void> {
  const branch = await currentBranch()
  const base = await baseBranch()
  requireTrunk(base)
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const worktree = await worktreeStatus()
  if (worktree.dirty || (await mergeInProgress())) {
    die(EXIT.usage, {
      step: "commit",
      worktree,
      error: "commit local work or resolve the merge first",
    })
  }

  async function step(name: string, args: string[] = []): Promise<Record<string, unknown>> {
    const result = await run(["bun", join(import.meta.dir, "pr-merge.ts"), name, ...args])
    let data: Record<string, unknown>
    try {
      data = JSON.parse(result.stdout) as Record<string, unknown>
    } catch {
      die(EXIT.fail, { step: name, error: result.stderr || result.stdout || "no JSON output" })
    }
    if (result.code !== 0) die(result.code, { step: name, ...data })
    return data
  }

  await step("sync")
  await step("publish")
  const existing = await readPr(branch)
  if (!existing) {
    const commits = await git(["log", "--no-merges", "--format=%s", `origin/${base}..HEAD`])
    const subjects = commits.stdout.split("\n").filter(Boolean)
    const title = opt("--title") ?? subjects[0]
    if (!title)
      die(EXIT.usage, { step: "pr", error: "no non-merge commit for PR title; pass --title" })
    const bodyFile = opt("--body-file")
    const body = `## Summary\n\n${subjects
      .slice(0, 5)
      .map((subject) => `- ${subject}`)
      .join("\n")}\n\n## Test plan\n\n- Automated PR checks\n`
    await step("pr", [
      "--title",
      title,
      ...(bodyFile ? ["--body-file", bodyFile] : ["--body", body]),
    ])
  } else if (existing.isDraft) {
    await step("pr", ["--ready"])
  }

  await step("checks", ["--timeout", opt("--timeout") ?? "1800"])
  const comments = await step("comments")
  const unresolved = comments.unresolvedThreads as unknown[]
  const recent = comments.recentComments as unknown[]
  if (unresolved.length > 0 || (recent.length > 0 && !flag("--comments-reviewed"))) {
    die(EXIT.fail, {
      step: "comments",
      error:
        "address review threads and review recent comments; then rerun with --comments-reviewed",
      ...comments,
    })
  }
  const merged = await step("merge")
  emit({ ok: true, branch, base, pr: comments.url, ...merged })
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
    trunk: TRUNK_BRANCH,
    trunkOk: base === TRUNK_BRANCH,
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

  const msgPath = join(tmpdir(), `pr-merge-commit-msg-${process.pid}.txt`)
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
  requireTrunk(base)
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
      error: "worktree not clean; commit first (bun scripts/pr-merge.ts commit …)",
    })
  }

  const fetched = await git(["fetch", "origin"])
  if (fetched.code !== 0) {
    die(EXIT.fail, { step: "fetch", output: fetched.stderr || fetched.stdout })
  }

  let remoteMerged = false
  if (await remoteBranchExists(await currentBranch())) {
    const branch = await currentBranch()
    const remoteAhead = await git(["rev-list", "--count", `HEAD..origin/${branch}`])
    if (Number(remoteAhead.stdout) > 0) {
      const merged = await git([
        "merge",
        "--no-edit",
        "-m",
        "chore: sync remote branch",
        `origin/${branch}`,
      ])
      const conflicts = await conflictFiles()
      if (conflicts.length > 0) {
        die(EXIT.conflicts, {
          step: "merge-remote",
          branch,
          conflicts,
          hint: "resolve both intents, git add <files>, re-run sync --continue",
        })
      }
      if (merged.code !== 0)
        die(EXIT.fail, { step: "merge-remote", output: merged.stderr || merged.stdout })
      remoteMerged = true
    }
  }

  const count = await git(["rev-list", "--count", `HEAD..origin/${base}`])
  const behindBase = count.code === 0 ? Number(count.stdout) || 0 : 0
  if (behindBase === 0) {
    emit({
      ok: true,
      alreadyUpToDate: !remoteMerged,
      remoteMerged,
      sha: await headSha(),
      behindBase: 0,
      pushNeeded: remoteMerged,
    })
    return
  }

  const merged = await git(["merge", "--no-edit", "-m", `chore: sync ${base}`, `origin/${base}`])
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
    remoteMerged,
    base,
    mergeCommit: await headSha(),
    pushNeeded: true,
  })
}

async function cmdPr(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const branch = await currentBranch()
  const base = await baseBranch()
  requireTrunk(base)

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
    tempBody = join(tmpdir(), `pr-merge-pr-body-${process.pid}.md`)
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
    // A third-party app's check (GitGuardian, …) has no Actions log: its findings are the
    // check run's own report.
    if (!runId) return printCheckRunReport(branch, target)
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

async function printCheckRunReport(branch: string, name: string): Promise<void> {
  const slug = await repoSlug()
  const runs = await checkRunsByName(slug, await prHeadSha(branch), name)
  if (runs.length === 0) die(EXIT.usage, { error: "no check run on the PR head", name })
  const lines: string[] = []
  for (const run of runs) {
    lines.push(
      `# ${run.name} (${run.app?.name ?? "unknown app"}): ${run.conclusion ?? run.status}`,
      `details: ${run.details_url ?? run.html_url ?? "none"}`,
      "",
      run.output?.title ?? "",
      run.output?.summary ?? "",
      run.output?.text ?? "",
    )
  }
  const tail = Number(opt("--tail") ?? 120)
  const all = lines.join("\n").split("\n")
  const shown =
    all.length > tail ? [...all.slice(0, tail), `… ${all.length - tail} more lines omitted`] : all
  process.stdout.write(`${shown.join("\n")}\n`)
}

async function cmdRerun(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const name = opt("--name") ?? argv[1]
  if (!name) die(EXIT.usage, { error: "rerun needs a check name", usage: USAGE })
  const branch = await currentBranch()
  const fetched = await fetchChecks(branch)
  if (!fetched.ok) die(EXIT.fail, { step: "rerun", output: fetched.reason })
  const match = fetched.checks.find((check) => check.name === name)
  if (!match) {
    die(EXIT.usage, { error: "unknown check", available: fetched.checks.map((c) => c.name) })
  }

  const runId = match.link.match(/\/actions\/runs\/(\d+)/)?.[1]
  if (runId) {
    const rerun = await gh(["run", "rerun", runId, "--failed"])
    if (rerun.code !== 0) die(EXIT.fail, { step: "rerun", output: rerun.stderr || rerun.stdout })
    emit({ ok: true, name, via: "actions", runId })
    return
  }

  // A third-party app's check: ask GitHub to re-request its check suite, which the app re-runs.
  const slug = await repoSlug()
  const runs = await checkRunsByName(slug, await prHeadSha(branch), name)
  const suiteId = runs[0]?.check_suite?.id
  if (!suiteId) die(EXIT.fail, { step: "rerun", error: "check run has no check suite", name })
  const rerequest = await gh([
    "api",
    "--method",
    "POST",
    `repos/${slug}/check-suites/${suiteId}/rerequest`,
  ])
  if (rerequest.code !== 0) {
    die(EXIT.fail, {
      step: "rerun",
      output: rerequest.stderr || rerequest.stdout,
      hint: `re-run it from the app instead: ${runs[0]?.details_url ?? match.link}`,
    })
  }
  emit({ ok: true, name, via: "check-suite", app: runs[0]?.app?.slug ?? null, suiteId })
}

// ---------------------------------------------------------------------------
// GitGuardian
// ---------------------------------------------------------------------------

const GITGUARDIAN_CHECK = "GitGuardian Security Checks"
const GITGUARDIAN_KEY_ENV = "GITGUARDIAN_API_KEY"
const GITGUARDIAN_IGNORE_REASONS = ["test_credential", "false_positive", "low_risk"]

type GuardianIncident = {
  id: string
  url: string
  status: string
  detector: string
  commit: string
  file: string
  line: number | null
}

/**
 * Incidents from the GitGuardian check run's report: one Markdown table row per finding,
 * `| [id](incident url) | status | detector | commit | file | [View secret](…#diff-…R<line>) |`.
 */
function parseGuardianIncidents(text: string): GuardianIncident[] {
  const incidents: GuardianIncident[] = []
  for (const line of text.split("\n")) {
    const row = line.match(
      /^\|\s*\[(\d+)\]\((https?:\/\/[^)\s]+)\)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([0-9a-f]{7,40})\s*\|\s*([^|]*?)\s*\|\s*(.*)$/,
    )
    if (!row) continue
    const [, id, url, status, detector, commit, file, rest] = row
    const lineNumber = rest?.match(/#diff-[0-9a-f]+R(\d+)/)?.[1]
    incidents.push({
      id: id as string,
      url: url as string,
      status: status as string,
      detector: detector as string,
      commit: commit as string,
      file: file as string,
      line: lineNumber ? Number(lineNumber) : null,
    })
  }
  return incidents
}

async function cmdGuardian(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const sub = argv[1] && !argv[1].startsWith("-") ? argv[1] : "list"
  if (sub === "ignore") return guardianIgnore()
  if (sub !== "list") die(EXIT.usage, { error: `unknown guardian command: ${sub}`, usage: USAGE })

  const branch = await currentBranch()
  const slug = await repoSlug()
  const runs = await checkRunsByName(slug, await prHeadSha(branch), GITGUARDIAN_CHECK)
  const run = runs[0]
  if (!run) {
    emit({ ok: true, check: null, incidents: [] })
    return
  }
  const incidents = parseGuardianIncidents(run.output?.text ?? "")
  // Whether each flagged commit is already on the remote: a pushed commit cannot be scrubbed
  // without a force-push, so its incident must be resolved in GitGuardian instead.
  const withPushed = await Promise.all(
    incidents.map(async (incident) => {
      const contains = await git(["branch", "-r", "--contains", incident.commit])
      return { ...incident, pushed: contains.code === 0 && contains.stdout.length > 0 }
    }),
  )
  emit({
    ok: run.conclusion !== "failure",
    check: { conclusion: run.conclusion ?? run.status, details: run.details_url },
    incidents: withPushed,
    canIgnore: Boolean(process.env[GITGUARDIAN_KEY_ENV]),
  })
  process.exit(run.conclusion === "failure" ? EXIT.fail : EXIT.ok)
}

/** Resolve one incident as not a leak, through GitGuardian's public API. */
async function guardianIgnore(): Promise<void> {
  const id = opt("--incident")
  const reason = opt("--reason")
  if (!id || !/^\d+$/.test(id) || !reason || !GITGUARDIAN_IGNORE_REASONS.includes(reason)) {
    die(EXIT.usage, {
      error: `guardian ignore needs --incident <id> and --reason <${GITGUARDIAN_IGNORE_REASONS.join("|")}>`,
      usage: USAGE,
    })
  }
  const key = process.env[GITGUARDIAN_KEY_ENV]
  if (!key) {
    die(EXIT.fail, {
      step: "guardian-auth",
      error: `${GITGUARDIAN_KEY_ENV} is not set`,
      vault: `secret/personal/dev key ${GITGUARDIAN_KEY_ENV} (a GitGuardian API token with incidents:write)`,
      run: "bun scripts/vault-run.ts -- bun scripts/pr-merge.ts guardian ignore --incident <id> --reason <reason>",
    })
  }
  const api = "https://api.gitguardian.com"
  const response = await fetch(`${api}/v1/incidents/secrets/${id}/ignore`, {
    method: "POST",
    headers: { authorization: `Token ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ignore_reason: reason }),
  })
  const body = await response.text()
  if (!response.ok) {
    die(EXIT.fail, { step: "guardian-ignore", status: response.status, output: body.slice(0, 500) })
  }
  emit({ ok: true, incident: id, reason, status: response.status })
}

async function cmdRuleset(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const base = await baseBranch()
  const slug = await repoSlug()
  const existingId = await findRulesetId(slug)

  if (flag("--apply")) {
    const removedLegacyRulesets = await removeLegacyRulesets(slug)
    const path =
      existingId === null ? `repos/${slug}/rulesets` : `repos/${slug}/rulesets/${existingId}`
    const method = existingId === null ? "POST" : "PUT"
    const applied = await run(["gh", "api", "--method", method, path, "--input", "-"], {
      stdin: JSON.stringify(canonicalRuleset(base)),
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
    emit({ ...verification, applied: true, removedLegacyRulesets })
    process.exit(verification.ok ? EXIT.ok : EXIT.fail)
  }

  const verification = await verifyRuleset(slug, base, existingId)
  emit(verification)
  process.exit(verification.ok ? EXIT.ok : EXIT.fail)
}

async function cmdRepo(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const slug = await repoSlug()
  const apply = flag("--apply")
  if (apply) {
    const written = await run(["gh", "api", "--method", "PATCH", `repos/${slug}`, "--input", "-"], {
      stdin: JSON.stringify(REPO_SETTINGS),
    })
    if (written.code !== 0) {
      die(EXIT.fail, {
        step: "repo-apply",
        output: written.stderr || written.stdout,
        hint: "repo settings writes require admin",
      })
    }
  }
  const { drift, settings: state } = await repoDrift(slug)
  const settings: Record<string, unknown> = {}
  for (const key of Object.keys(REPO_SETTINGS)) settings[key] = state[key]
  emit({ ok: drift.length === 0, slug, settings, drift, applied: apply })
  process.exit(drift.length === 0 ? EXIT.ok : EXIT.fail)
}

/** mergeStateStatus values GitHub reports for a PR it will merge right now. */
const MERGEABLE_STATES = ["CLEAN", "HAS_HOOKS"]

/**
 * Everything that keeps the PR from landing. `pending` means wait (checks still running, or
 * GitHub still computing mergeability); `blockers` need work first. Every reported check counts,
 * required or not: a failing third-party check (GitGuardian, …) blocks just like CI does.
 */
async function mergeReadiness(branch: string, base: string, pr: PrView) {
  const blockers: string[] = []
  const pending: { name: string; bucket: string; link: string }[] = []

  if (pr.state !== "OPEN") blockers.push(`PR is ${pr.state}`)
  if (pr.isDraft) blockers.push("PR is a draft (run `pr --ready`)")
  if (pr.reviewDecision === "CHANGES_REQUESTED") blockers.push("review requests changes")
  const threads = await unresolvedThreads(await repoSlug(), pr.number)
  if (threads.length > 0)
    blockers.push(`${threads.length} unresolved review thread(s) (run comments)`)
  const worktree = await worktreeStatus()
  if (worktree.dirty) blockers.push("worktree not clean (commit, then publish)")
  const counts = await git(["rev-list", "--left-right", "--count", "@{u}...HEAD"])
  const [behindUpstream, ahead] = counts.stdout.split(/\s+/).map((n) => Number(n) || 0)
  if (counts.code !== 0) blockers.push("branch has no upstream (run `publish`)")
  else if (ahead || behindUpstream) {
    blockers.push(`local and remote branch differ (ahead ${ahead}, behind ${behindUpstream})`)
  }
  if ((await git(["fetch", "--quiet", "origin", base])).code === 0) {
    const behind = await git(["rev-list", "--count", `HEAD..origin/${base}`])
    if (Number(behind.stdout) > 0) blockers.push(`behind origin/${base} (run \`sync\`)`)
  }

  const fetched = await fetchChecks(branch)
  if (!fetched.ok) blockers.push(`checks unavailable: ${fetched.reason}`)
  else if (!fetched.reported)
    pending.push({ name: "(no checks reported yet)", bucket: "pending", link: "" })
  else {
    pending.push(...pendingList(fetched.checks))
    for (const check of fetched.checks) {
      if (check.bucket === "fail" || check.bucket === "cancel") {
        blockers.push(`check "${check.name}" is ${check.bucket} (${check.link})`)
      }
    }
  }

  const state = pr.mergeStateStatus ?? "UNKNOWN"
  if (blockers.length === 0 && pending.length === 0 && !MERGEABLE_STATES.includes(state)) {
    if (state === "UNKNOWN") pending.push({ name: "(mergeability)", bucket: "pending", link: "" })
    else blockers.push(`GitHub reports mergeStateStatus ${state}`)
  }
  return { blockers, pending, mergeStateStatus: state }
}

async function cmdMerge(): Promise<void> {
  if (!(await ghAvailable())) die(EXIT.usage, { error: "gh not authenticated" })
  const branch = await currentBranch()
  const base = await baseBranch()
  requireTrunk(base)
  const existing = await readPr(branch)
  if (!existing) die(EXIT.usage, { error: `no PR for ${branch}; run \`pr\` first` })

  const { blockers, pending, mergeStateStatus } = await mergeReadiness(branch, base, existing)
  if (blockers.length > 0)
    die(EXIT.fail, { step: "merge-gate", blockers, pending, mergeStateStatus })
  if (pending.length > 0) die(EXIT.pending, { step: "merge-gate", pending, mergeStateStatus })
  if (flag("--dry-run")) {
    emit({ ok: true, ready: true, number: existing.number, url: existing.url, mergeStateStatus })
    return
  }

  const auto = flag("--auto")
  const args = ["pr", "merge", branch, "--merge"]
  if (auto) args.push("--auto")
  const merged = await gh(args)
  if (merged.code !== 0) {
    die(EXIT.fail, { step: "merge", output: merged.stderr || merged.stdout })
  }

  // Merging is asynchronous on GitHub's side; wait briefly for the PR to report MERGED.
  let pr = await readPr(branch)
  for (let i = 0; i < 15 && pr?.state !== "MERGED"; i++) {
    await Bun.sleep(2000)
    pr = await readPr(branch)
  }
  const state = pr?.state ?? existing.state
  emit({
    ok: state === "MERGED",
    merged: state === "MERGED",
    method: "merge",
    auto,
    number: pr?.number ?? existing.number,
    url: pr?.url ?? existing.url,
    state,
    mergeStateStatus: pr?.mergeStateStatus ?? null,
  })
  process.exit(state === "MERGED" ? EXIT.ok : EXIT.pending)
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const first = argv[0]
  const command = first && !first.startsWith("-") ? first : "status"
  switch (command) {
    case "advance":
      return cmdAdvance()
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
    case "comments":
      return cmdComments()
    case "reply":
      return cmdReply()
    case "resolve":
      return cmdResolve()
    case "checks":
      return cmdChecks()
    case "logs":
      return cmdLogs()
    case "rerun":
      return cmdRerun()
    case "guardian":
      return cmdGuardian()
    case "ruleset":
      return cmdRuleset()
    case "repo":
      return cmdRepo()
    case "merge":
      return cmdMerge()
    default:
      die(EXIT.usage, { error: `unknown command: ${command}`, usage: USAGE })
  }
}

await main()
