/**
 * One GitHub issue per failing release check (.github/workflows/ci.yml, the Report job), so a red
 * check on main is something to fix rather than something to notice.
 *
 * For each check the Release workflow ran:
 *   failed, no open issue   open one, labelled `ci-failure`
 *   failed, issue open      comment on it with the new run (never a second issue)
 *   passed, issue open      comment that it passes again, and close it
 * A check that was skipped or cancelled says nothing either way, so its issue is left alone.
 *
 * An issue is found by its title, which names the check: "Release check failing: Static".
 *
 *   NEEDS='{"static":{"result":"failure"}}' RUN_ID=1 bun scripts/release/check-issues.ts --dry-run
 *
 * In the workflow it reads NEEDS (`toJSON(needs)`), RUN_ID, RUN_ATTEMPT, GITHUB_REPOSITORY,
 * GITHUB_SHA and GITHUB_SERVER_URL, and talks to GitHub through `gh` (GH_TOKEN).
 */

export const LABEL = "ci-failure"
const TITLE_PREFIX = "Release check failing: "

/** The Release workflow's check jobs: their names in the run, and how to run each locally. */
export const CHECKS: Record<string, { name: string; jobs: RegExp; locally: string }> = {
  changes: {
    name: "Changes",
    jobs: /^Changes$/,
    locally: "bun scripts/ci-plan.ts changes --all",
  },
  static: {
    name: "Static",
    jobs: /^Static$/,
    locally: "bun scripts/ci-plan.ts static",
  },
  shard: {
    name: "Shards (build, typecheck, test, pack, portability)",
    jobs: /^Shard \d+$/,
    locally: "bun run check",
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
  },
}

export type Needs = Record<string, { result: string }>
export type OpenIssue = { number: number; title: string }
export type FailedJob = { name: string; url: string }
export type Run = { url: string; sha: string; repository: string; server: string }
export type Action =
  | { kind: "open"; check: string; title: string; body: string }
  | { kind: "comment"; check: string; issue: number; body: string }
  | { kind: "close"; check: string; issue: number; body: string }

export const titleOf = (check: string) => `${TITLE_PREFIX}${CHECKS[check]?.name ?? check}`

const failed = (result: string) => result === "failure" || result === "timed_out"

function where(run: Run, jobs: FailedJob[]): string {
  const commit = `[\`${run.sha.slice(0, 7)}\`](${run.server}/${run.repository}/commit/${run.sha})`
  const lines = [`Commit ${commit}, [Release run](${run.url}).`]
  if (jobs.length > 0) {
    lines.push("", "Failed jobs:", ...jobs.map((job) => `- [${job.name}](${job.url})`))
  }
  return lines.join("\n")
}

/** What to do about each check, given its result and the issues already open. */
export function plan(
  needs: Needs,
  open: readonly OpenIssue[],
  failedJobs: readonly FailedJob[],
  run: Run,
): Action[] {
  const actions: Action[] = []
  for (const [check, { result }] of Object.entries(needs)) {
    const spec = CHECKS[check]
    if (!spec) continue
    const title = titleOf(check)
    const issue = open.find((candidate) => candidate.title === title)
    if (failed(result)) {
      const jobs = failedJobs.filter((job) => spec.jobs.test(job.name))
      if (issue) {
        const body = `Still failing.\n\n${where(run, jobs)}`
        actions.push({ kind: "comment", check, issue: issue.number, body })
      } else {
        const body = [
          `The **${spec.name}** release check failed on \`main\`. Nothing is published from \`main\` until every release check passes${check === "parity" ? " (live parity alone does not hold the publish)" : ""}.`,
          "",
          where(run, jobs),
          "",
          `Run it locally: \`${spec.locally}\``,
          "",
          "This issue is kept by the Release workflow: it gets a comment on each run that still fails and closes itself when the check passes again.",
        ].join("\n")
        actions.push({ kind: "open", check, title, body })
      }
    } else if (result === "success" && issue) {
      const body = `Passing again.\n\n${where(run, [])}`
      actions.push({ kind: "close", check, issue: issue.number, body })
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

  let open: OpenIssue[] = []
  let failedJobs: FailedJob[] = []
  if (!dryRun) {
    open = JSON.parse(
      await gh([
        "issue",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--label",
        LABEL,
        "--limit",
        "200",
        "--json",
        "number,title",
      ]),
    ) as OpenIssue[]
    // Which jobs failed, for links straight to their logs. Best effort: the issue is what matters.
    try {
      const jobs = JSON.parse(
        await gh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
        ]),
      ) as { jobs: { name: string; html_url: string; conclusion: string | null }[] }[]
      failedJobs = jobs
        .flatMap((page) => page.jobs)
        .filter((job) => failed(job.conclusion ?? ""))
        .map((job) => ({ name: job.name, url: job.html_url }))
    } catch (error) {
      console.warn(
        `Could not list the run's jobs: ${error instanceof Error ? error.message : error}`,
      )
    }
  }

  const actions = plan(needs, open, failedJobs, run)
  if (actions.length === 0)
    console.log("No release check needs an issue opened, updated or closed.")
  for (const action of actions) {
    if (action.kind === "open") {
      console.log(`open: ${action.title}`)
      if (dryRun) continue
      // The label is created by issue-labels.yml from .github/labels.json; make sure of it here,
      // so the first failure after a fork or a rename still files.
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
        "An important workflow is failing on main",
      ])
      const args = ["issue", "create", "--repo", repository, "--title", action.title]
      console.log((await gh([...args, "--label", LABEL, "--body-file", "-"], action.body)).trim())
    } else {
      console.log(`${action.kind}: #${action.issue} (${CHECKS[action.check]?.name})`)
      if (dryRun) continue
      const issue = String(action.issue)
      await gh(["issue", "comment", issue, "--repo", repository, "--body-file", "-"], action.body)
      if (action.kind === "close") await gh(["issue", "close", issue, "--repo", repository])
    }
  }
}

if (import.meta.main) await main()
