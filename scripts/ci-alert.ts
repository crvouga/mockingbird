/**
 * Keep one GitHub issue per important workflow in step with its latest run on main.
 *
 *   failure  -> open `[ci-failure] <workflow> is failing on main`, or comment on the open one
 *   success  -> comment that it recovered and close the open issue
 *   anything else (cancelled, skipped, neutral) -> nothing
 *
 * Run by .github/workflows/ci-alerts.yml on `workflow_run`, which lists the watched workflows.
 * Reads the finished run from the environment the workflow sets and talks to GitHub through `gh`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const LABEL = "ci-failure"

export type Action = "report" | "resolve" | "ignore"

export function actionFor(conclusion: string): Action {
  if (["failure", "timed_out", "startup_failure"].includes(conclusion)) return "report"
  if (conclusion === "success") return "resolve"
  return "ignore"
}

export function issueTitle(workflow: string): string {
  return `[${LABEL}] ${workflow} is failing on main`
}

export interface Run {
  workflow: string
  conclusion: string
  url: string
  event: string
  sha: string
  attempt: string
}

export interface FailedJob {
  name: string
  url: string
  errors: string[]
}

const MAX_ERRORS_PER_JOB = 8
const MAX_ERROR_LENGTH = 600

export function failureReport(run: Run, jobs: FailedJob[]): string {
  const lines = [
    `**${run.workflow}** ${run.conclusion.replaceAll("_", " ")} on \`main\` at ${run.sha.slice(0, 7)} (${run.event}, attempt ${run.attempt}).`,
    "",
    `Run: ${run.url}`,
    "",
  ]
  if (jobs.length === 0) lines.push("No job reported a failure; open the run for details.")
  for (const job of jobs) {
    lines.push(`### [${job.name}](${job.url})`, "")
    const errors = job.errors.slice(0, MAX_ERRORS_PER_JOB)
    if (errors.length === 0) lines.push("_No error annotations; see the job log._", "")
    else {
      lines.push("```")
      for (const error of errors) {
        lines.push(error.length > MAX_ERROR_LENGTH ? `${error.slice(0, MAX_ERROR_LENGTH)}…` : error)
      }
      lines.push("```", "")
    }
  }
  return lines.join("\n").trimEnd()
}

export function newIssueBody(repo: string, run: Run, jobs: FailedJob[]): string {
  return [
    `Opened automatically by [ci-alerts.yml](https://github.com/${repo}/blob/main/.github/workflows/ci-alerts.yml) because a run of an important workflow failed on \`main\`. Each later failure adds a comment; the next successful run closes this issue.`,
    "",
    failureReport(run, jobs),
  ].join("\n")
}

export function recoveredComment(run: Run): string {
  return `**${run.workflow}** passed again on \`main\` at ${run.sha.slice(0, 7)} (${run.event}): ${run.url}`
}

function gh(args: string[], input?: string): string {
  const proc = Bun.spawnSync(["gh", ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`ci-alert: ${name} is not set`)
  return value
}

function failedJobs(repo: string, runId: string): FailedJob[] {
  const { jobs } = JSON.parse(gh(["run", "view", runId, "--repo", repo, "--json", "jobs"])) as {
    jobs: { name: string; url: string; conclusion: string; databaseId: number }[]
  }
  return jobs
    .filter((job) => actionFor(job.conclusion) === "report")
    .map((job) => {
      let errors: string[] = []
      try {
        const annotations = JSON.parse(
          gh(["api", `repos/${repo}/check-runs/${job.databaseId}/annotations`]),
        ) as { annotation_level: string; message: string }[]
        errors = annotations
          .filter((a) => a.annotation_level === "failure")
          .map((a) => a.message.trim())
      } catch {
        // The issue still links the job; missing annotations must not drop the report.
      }
      return { name: job.name, url: job.url, errors }
    })
}

function openIssue(repo: string, title: string): number | undefined {
  const issues = JSON.parse(
    gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      LABEL,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title",
    ]),
  ) as { number: number; title: string }[]
  return issues.find((issue) => issue.title === title)?.number
}

function ensureLabel(repo: string) {
  const labels = JSON.parse(
    readFileSync(join(import.meta.dir, "../.github/labels.json"), "utf8"),
  ) as { name: string; color: string; description: string }[]
  const label = labels.find((l) => l.name === LABEL)
  if (!label) throw new Error(`ci-alert: .github/labels.json has no ${LABEL} label`)
  gh([
    "label",
    "create",
    LABEL,
    "--repo",
    repo,
    "--force",
    "--color",
    label.color,
    "--description",
    label.description,
  ])
}

function main() {
  const repo = env("GITHUB_REPOSITORY")
  const run: Run = {
    workflow: env("RUN_WORKFLOW"),
    conclusion: env("RUN_CONCLUSION"),
    url: env("RUN_URL"),
    event: env("RUN_EVENT"),
    sha: env("RUN_SHA"),
    attempt: env("RUN_ATTEMPT"),
  }
  const action = actionFor(run.conclusion)
  const title = issueTitle(run.workflow)
  const existing = action === "ignore" ? undefined : openIssue(repo, title)

  if (action === "report") {
    const jobs = failedJobs(repo, env("RUN_ID"))
    if (existing) {
      gh(
        ["issue", "comment", String(existing), "--repo", repo, "--body-file", "-"],
        failureReport(run, jobs),
      )
      console.log(`ci-alert: commented on #${existing}`)
    } else {
      ensureLabel(repo)
      const url = gh(
        ["issue", "create", "--repo", repo, "--title", title, "--label", LABEL, "--body-file", "-"],
        newIssueBody(repo, run, jobs),
      )
      console.log(`ci-alert: opened ${url.trim()}`)
    }
  } else if (action === "resolve" && existing) {
    gh([
      "issue",
      "close",
      String(existing),
      "--repo",
      repo,
      "--reason",
      "completed",
      "--comment",
      recoveredComment(run),
    ])
    console.log(`ci-alert: closed #${existing}`)
  } else {
    console.log(`ci-alert: ${run.workflow} ${run.conclusion}, nothing to do`)
  }
}

if (import.meta.main) main()
