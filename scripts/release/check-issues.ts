/**
 * One GitHub issue per failing release check (.github/workflows/ci.yml, the Report jobs), so a red
 * check on main is queued work rather than something to notice. Each issue is labelled `ci-failure`
 * and `agent-reported`, which puts it at the head of the /resolve-issues queue
 * (scripts/resolve-issues.ts QUEUE_KINDS), so an agent can pick it up and fix it forward.
 *
 * A check that runs turbo tasks (Static, the shards) files one issue per failing task, named after
 * it (`@crvouga/mockingbird-ui#test`), read from the turbo summary in the failed job's log; the
 * other checks, or a turbo job whose log names no task, file one issue for the check. For each:
 *   failing, issue open     comment with the new run (never a second issue)
 *   failing, issue closed   reopen it with the new run, so its history stays in one place
 *   failing, no issue       open one
 *   check passes            comment that it passes again and close every issue it filed
 * A check that was skipped or cancelled says nothing either way, so its issues are left alone. A
 * task issue stays open while its check still fails for another task: only a passing check proves
 * the task passes.
 *
 * An issue is found by the key hidden in its body (`<!-- release-check: shard @x#test -->`), not by
 * its title, so a person can retitle it freely.
 *
 *   NEEDS='{"static":{"result":"failure"}}' RUN_ID=1 bun scripts/release/check-issues.ts --dry-run
 *
 * In the workflow it reads NEEDS (`toJSON(needs)`), RUN_ID, RUN_ATTEMPT, GITHUB_REPOSITORY,
 * GITHUB_SHA and GITHUB_SERVER_URL, and talks to GitHub through `gh` (GH_TOKEN).
 */

export const LABEL = "ci-failure"
/** The /resolve-issues queue takes only `agent-reported` issues. */
export const QUEUE_LABEL = "agent-reported"
const TITLE_PREFIX = "Release check failing: "

type Check = {
  name: string
  /** The jobs in the run that make up this check. */
  jobs: RegExp
  /** How to run it locally. */
  locally: string
  /** It runs turbo tasks, and files an issue per failing task. */
  tasks?: boolean
  /** What its failure holds back. Default: the publish. */
  holds?: string
}

/** The Release workflow's checks and release jobs: their names in the run, and how to run each. */
export const CHECKS: Record<string, Check> = {
  changes: {
    name: "Changes",
    jobs: /^Changes$/,
    locally: "bun scripts/ci-plan.ts changes --all",
  },
  static: {
    name: "Static",
    jobs: /^Static$/,
    locally: "bun scripts/ci-plan.ts static",
    tasks: true,
  },
  shard: {
    name: "Shards",
    jobs: /^Shard \d+$/,
    locally: "bun run check",
    tasks: true,
  },
  smoke: {
    name: "Consumer smoke",
    jobs: /^Consumer smoke$/,
    locally: "bun run build && bun run release:smoke",
  },
  "npm-names": {
    name: "npm names",
    jobs: /^npm names$/,
    locally: "bun run release:npm-names",
  },
  "fleet-container": {
    name: "Fleet container",
    jobs: /^Fleet container \(/,
    locally: "bun run --cwd packages/examples/fleet-reference smoke (after building its image)",
  },
  parity: {
    name: "Live parity",
    jobs: /^Live parity( \/|$)/,
    locally: "bun run parity:remote -- <service>",
    holds: "nothing: live parity alone does not hold the publish",
  },
  release: {
    name: "Release prerequisites",
    jobs: /^Release prerequisites$/,
    locally: "bun run release:plan",
    holds: "every package the prerequisites publish, and those that pin them",
  },
  publish: {
    name: "Publish",
    jobs: /^Release shard /,
    locally: "bun run release:plan (then the failing shard's group with .github/actions/release)",
    holds: "the packages of the failing shard",
  },
  reconcile: {
    name: "Reconcile releases",
    jobs: /^Reconcile releases$/,
    locally: "bun run release:plan",
    holds: "the repairs of earlier releases (tags, GitHub releases)",
  },
}

export type Needs = Record<string, { result: string }>
export type KnownIssue = { number: number; title: string; state: string; body: string }
export type FailedJob = {
  name: string
  url: string
  /** The turbo tasks its log reports as failed, when it runs turbo. */
  tasks?: readonly string[]
}
export type Run = { url: string; sha: string; repository: string; server: string }
export type Action =
  | { kind: "open"; key: string; title: string; body: string }
  | { kind: "comment"; key: string; issue: number; body: string }
  | { kind: "reopen"; key: string; issue: number; body: string }
  | { kind: "close"; key: string; issue: number; body: string }

/** The key of a check's own issue, or of one of its failing tasks. */
export const keyOf = (check: string, task?: string) => (task ? `${check} ${task}` : check)
export const marker = (key: string) => `<!-- release-check: ${key} -->`
const MARKER = /<!-- release-check: ([^>]+?) -->/

export const titleOf = (check: string, task?: string) =>
  `${TITLE_PREFIX}${task ?? CHECKS[check]?.name ?? check}`

/** The key an issue was filed under: its marker, else (issues filed before markers) its title. */
function keyOfIssue(issue: KnownIssue): string | undefined {
  const found = MARKER.exec(issue.body)?.[1]
  if (found) return found
  for (const check of Object.keys(CHECKS)) if (issue.title === titleOf(check)) return check
  return undefined
}

const failed = (result: string) => result === "failure" || result === "timed_out"

/**
 * The turbo tasks a job's log reports as failed: turbo ends a failed run with
 * `Failed:    @scope/a#test, //#check:llms`. Actions prefixes each line with a timestamp.
 */
export function failedTasks(log: string): string[] {
  const tasks = new Set<string>()
  for (const raw of log.split("\n")) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes in the log.
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").replace(/^\S+Z\s/, "")
    const match = /^\s*Failed:\s+(.+?)\s*$/.exec(line)
    if (!match?.[1]) continue
    for (const task of match[1].split(/,\s*/)) if (task.includes("#")) tasks.add(task.trim())
  }
  return [...tasks].sort()
}

/** How to run one turbo task locally: `@scope/a#test` or a root task, `//#check:llms`. */
export function taskCommand(task: string): string {
  const at = task.lastIndexOf("#")
  const pkg = task.slice(0, at)
  const name = task.slice(at + 1)
  return pkg === "//"
    ? `bunx turbo run ${name} --filter=//`
    : `bunx turbo run ${name} --filter=${pkg}`
}

function where(run: Run, jobs: readonly FailedJob[]): string {
  const commit = `[\`${run.sha.slice(0, 7)}\`](${run.server}/${run.repository}/commit/${run.sha})`
  const lines = [`Commit ${commit}, [Release run](${run.url}).`]
  if (jobs.length > 0) {
    lines.push("", "Failed jobs:", ...jobs.map((job) => `- [${job.name}](${job.url})`))
  }
  return lines.join("\n")
}

function openingBody(check: string, task: string | undefined, run: Run, jobs: FailedJob[]) {
  const spec = CHECKS[check] as Check
  const what = task
    ? `The **${spec.name}** release check fails on \`main\` at the turbo task \`${task}\`.`
    : `The **${spec.name}** release check failed on \`main\`.`
  const holds = spec.holds
    ? `It holds back ${spec.holds}.`
    : "Nothing is published from `main` until every release check passes."
  return [
    marker(keyOf(check, task)),
    `${what} ${holds}`,
    "",
    where(run, jobs),
    "",
    `Run it locally: \`${task ? taskCommand(task) : spec.locally}\``,
    "",
    "Fix it forward: a branch from `main` and a pull request that makes the check pass. This issue is kept by the Release workflow: it gets a comment on each run that still fails, reopens if the check breaks again, and closes itself when the check passes on `main`.",
  ].join("\n")
}

/** What to do about each check, given its result, its failed jobs and the issues it filed. */
export function plan(
  needs: Needs,
  issues: readonly KnownIssue[],
  failedJobs: readonly FailedJob[],
  run: Run,
): Action[] {
  const actions: Action[] = []
  const filed = issues
    .map((issue) => ({ issue, key: keyOfIssue(issue) }))
    .filter((entry): entry is { issue: KnownIssue; key: string } => entry.key !== undefined)
  // The open issue for a key, else the newest closed one.
  const issueFor = (key: string) => {
    const mine = filed.filter((entry) => entry.key === key).map((entry) => entry.issue)
    return (
      mine.find((issue) => issue.state === "OPEN") ??
      mine.sort((a, b) => b.number - a.number).find((issue) => issue.state === "CLOSED")
    )
  }
  for (const [check, { result }] of Object.entries(needs)) {
    const spec = CHECKS[check]
    if (!spec) continue
    if (failed(result)) {
      const jobs = failedJobs.filter((job) => spec.jobs.test(job.name))
      const tasks = spec.tasks ? [...new Set(jobs.flatMap((job) => job.tasks ?? []))].sort() : []
      // A failed job whose log names no task (it timed out, its setup failed) is the check's own.
      const whole = tasks.length === 0 || jobs.some((job) => (job.tasks ?? []).length === 0)
      const targets: (string | undefined)[] = [...(whole ? [undefined] : []), ...tasks]
      for (const task of targets) {
        const key = keyOf(check, task)
        const issue = issueFor(key)
        if (issue?.state === "OPEN") {
          const body = `Still failing.\n\n${where(run, jobs)}`
          actions.push({ kind: "comment", key, issue: issue.number, body })
        } else if (issue) {
          const body = `Failing again.\n\n${where(run, jobs)}`
          actions.push({ kind: "reopen", key, issue: issue.number, body })
        } else {
          const body = openingBody(check, task, run, jobs)
          actions.push({ kind: "open", key, title: titleOf(check, task), body })
        }
      }
    } else if (result === "success") {
      for (const { issue, key } of filed) {
        if (issue.state !== "OPEN") continue
        if (key !== check && !key.startsWith(`${check} `)) continue
        const body = `Passing again.\n\n${where(run, [])}`
        actions.push({ kind: "close", key, issue: issue.number, body })
      }
    }
  }
  return actions
}

async function gh(args: string[], input?: string): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${stderr.trim() || code}`)
  return stdout
}

const warn = (what: string, error: unknown) =>
  console.warn(`${what}: ${error instanceof Error ? error.message : error}`)

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run")
  const env = (name: string, fallback?: string) => {
    const value = Bun.env[name] ?? fallback
    if (value === undefined) throw new Error(`${name} is not set`)
    return value
  }
  const needs = JSON.parse(env("NEEDS")) as Needs
  const repository = env("GITHUB_REPOSITORY", dryRun ? "owner/repo" : undefined)
  const server = env("GITHUB_SERVER_URL", "https://github.com")
  const runId = env("RUN_ID")
  const attempt = env("RUN_ATTEMPT", "1")
  const run: Run = {
    url: `${server}/${repository}/actions/runs/${runId}/attempts/${attempt}`,
    sha: env("GITHUB_SHA", dryRun ? "0000000" : undefined),
    repository,
    server,
  }

  let issues: KnownIssue[] = []
  const failedJobs: FailedJob[] = []
  if (!dryRun) {
    // Closed ones too, so a check that breaks again reopens its issue instead of filing another.
    issues = JSON.parse(
      await gh([
        "issue",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--label",
        LABEL,
        "--limit",
        "500",
        "--json",
        "number,title,state,body",
      ]),
    ) as KnownIssue[]
    // Which jobs failed, for links straight to their logs, and which turbo tasks failed in them.
    // Best effort: without them each check still files its own issue.
    try {
      const pages = JSON.parse(
        await gh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
        ]),
      ) as { jobs: { id: number; name: string; html_url: string; conclusion: string | null }[] }[]
      const turboJobs = Object.values(CHECKS).filter((spec) => spec.tasks)
      for (const job of pages.flatMap((page) => page.jobs)) {
        if (!failed(job.conclusion ?? "")) continue
        const entry: FailedJob = { name: job.name, url: job.html_url }
        if (turboJobs.some((spec) => spec.jobs.test(job.name)))
          try {
            entry.tasks = failedTasks(
              await gh(["api", `repos/${repository}/actions/jobs/${job.id}/logs`]),
            )
          } catch (error) {
            warn(`Could not read the log of ${job.name}`, error)
          }
        failedJobs.push(entry)
      }
    } catch (error) {
      warn("Could not list the run's jobs", error)
    }
  }

  const actions = plan(needs, issues, failedJobs, run)
  if (actions.length === 0)
    console.log("No release check needs an issue opened, updated or closed.")
  let labelled = false
  for (const action of actions) {
    if (action.kind === "open") {
      console.log(`open: ${action.title}`)
      if (dryRun) continue
      // The labels come from .github/labels.json (issue-labels.yml); make sure of `ci-failure`
      // here, so the first failure after a fork or a rename still files.
      if (!labelled) {
        await gh([
          "label",
          "create",
          LABEL,
          "--repo",
          repository,
          "--force",
          "--color",
          "b60205",
          "--description",
          "A release check is failing on main; opened and closed by the Release workflow",
        ])
        labelled = true
      }
      const args = ["issue", "create", "--repo", repository, "--title", action.title]
      const labels = ["--label", LABEL, "--label", QUEUE_LABEL]
      console.log((await gh([...args, ...labels, "--body-file", "-"], action.body)).trim())
    } else {
      console.log(`${action.kind}: #${action.issue} (${action.key})`)
      if (dryRun) continue
      const issue = String(action.issue)
      if (action.kind === "reopen") await gh(["issue", "reopen", issue, "--repo", repository])
      await gh(["issue", "comment", issue, "--repo", repository, "--body-file", "-"], action.body)
      if (action.kind === "close") await gh(["issue", "close", issue, "--repo", repository])
    }
  }
}

if (import.meta.main) await main()
