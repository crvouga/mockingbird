import { readdirSync } from "node:fs"
import { join } from "node:path"
import { REPO, root } from "../release/lib.ts"
import {
  github,
  githubPages,
  inspect,
  pool,
  type WorkflowRun,
  workflowRuns,
  yamlFile,
} from "./io.ts"
import { type HealthItem, report } from "./report.ts"

export function runHealth(id: string, run: WorkflowRun | undefined): HealthItem {
  if (!run) return { id, status: "unknown", message: "No run found on main." }
  if (run.status !== "completed")
    return { id, status: "pending", message: `Workflow is ${run.status}.`, url: run.html_url }
  return {
    id,
    status: run.conclusion === "success" ? "ok" : "fail",
    message: `${run.conclusion ?? "unknown conclusion"}; ${run.head_sha.slice(0, 12)}; ${run.updated_at}`,
    url: run.html_url,
    ...(run.conclusion !== "success"
      ? { remedy: "Open the run, diagnose the failing jobs, then retry the workflow." }
      : {}),
  }
}

/** Conservative stale windows for the daily/weekly/hour-step schedules used here. */
export function scheduleWindow(cron: string): number {
  const fields = cron.trim().split(/\s+/)
  const hours = /^\*\/(\d+)$/.exec(fields[1] ?? "")
  const days = fields[4] !== "*" ? 7 : fields[2] !== "*" ? 31 : 1
  return (hours ? Number(hours[1]) : days * 24) * 2 * 60 * 60 * 1000 + 60 * 60 * 1000
}

export async function runGitHubHealth() {
  const items: HealthItem[] = []
  items.push(
    await inspect("repository", async () => {
      const repo = await github<{ archived: boolean; disabled: boolean; default_branch: string }>(
        `repos/${REPO}`,
      )
      const problems = [
        repo.archived && "repository is archived",
        repo.disabled && "repository is disabled",
        repo.default_branch !== "main" && "default branch must be main",
      ].filter(Boolean)
      return {
        id: "repository",
        status: problems.length ? "fail" : "ok",
        message: problems.join("; ") || "Repository is active; default branch is main.",
        url: `https://github.com/${REPO}/settings`,
      }
    }),
  )
  items.push(
    await inspect("main-protection", async () => {
      const branch = await github<{ protected: boolean }>(`repos/${REPO}/branches/main`)
      return {
        id: "main-protection",
        status: branch.protected ? "ok" : "fail",
        message: branch.protected
          ? "main is protected by branch protection or a ruleset."
          : "main is unprotected.",
        url: `https://github.com/${REPO}/settings/rules`,
      }
    }),
  )
  items.push(
    await inspect("actions-permissions", async () => {
      const permissions = await github<{ enabled: boolean }>(`repos/${REPO}/actions/permissions`)
      return {
        id: "actions-permissions",
        status: permissions.enabled ? "ok" : "fail",
        message: permissions.enabled ? "GitHub Actions is enabled." : "GitHub Actions is disabled.",
        url: `https://github.com/${REPO}/settings/actions`,
      }
    }),
  )
  items.push(
    await inspect("actions-cache", async () => {
      const usage = await github<{
        active_caches_size_in_bytes: number
        active_caches_count: number
      }>(`repos/${REPO}/actions/cache/usage`)
      const gib = usage.active_caches_size_in_bytes / 1024 ** 3
      return {
        id: "actions-cache",
        status: gib >= 9 ? "fail" : "ok",
        message: `${gib.toFixed(2)} GiB in ${usage.active_caches_count} entries (repo budget 10 GiB).`,
        remedy: "Inspect Cache cleanup and main's cache retention.",
        url: `https://github.com/${REPO}/actions/caches`,
      }
    }),
  )
  const local = readdirSync(join(root, ".github/workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
  let workflows: Array<{ path: string; state: string }> = []
  items.push(
    await inspect("workflow-registration", async () => {
      workflows = await githubPages(`repos/${REPO}/actions/workflows?per_page=100`, "workflows")
      return {
        id: "workflow-registration",
        status: "ok",
        message: `${workflows.length} workflows registered on GitHub.`,
      }
    }),
  )
  items.push(
    ...(
      await pool(
        local,
        async (file) => {
          const rows: HealthItem[] = []
          const registered = workflows.find((w) => w.path === `.github/workflows/${file}`)
          rows.push({
            id: file,
            status: !registered ? "unknown" : registered.state === "active" ? "ok" : "fail",
            message: !registered
              ? "Workflow is not registered on GitHub (possibly not merged yet)."
              : `Workflow is ${registered.state}.`,
            url: `https://github.com/${REPO}/actions/workflows/${file}`,
          })
          const workflow = yamlFile(`.github/workflows/${file}`)
          const triggers = workflow.on as Record<string, unknown> | undefined
          if (triggers && ("push" in triggers || "schedule" in triggers)) {
            rows.push(
              await inspect(`${file}:latest`, async () =>
                runHealth(`${file}:latest`, (await workflowRuns(file))[0]),
              ),
            )
          } else
            rows.push({
              id: `${file}:latest`,
              status: "optional",
              message: "Pull-request/event/manual workflow; absence of a main run is expected.",
            })
          const schedules = triggers?.schedule as Array<{ cron: string }> | undefined
          if (schedules?.length)
            rows.push(
              await inspect(`${file}:schedule`, async () => {
                const result = await github<{ workflow_runs: WorkflowRun[] }>(
                  `repos/${REPO}/actions/workflows/${file}/runs?event=schedule&branch=main&per_page=1`,
                )
                const run = result.workflow_runs[0]
                const window = Math.max(...schedules.map(({ cron }) => scheduleWindow(cron)))
                if (!run || Date.now() - Date.parse(run.created_at) > window)
                  return {
                    id: `${file}:schedule`,
                    status: "fail",
                    message: "Scheduled runs are missing or overdue.",
                    remedy: "Enable the workflow and inspect its schedule and repository activity.",
                    url: `https://github.com/${REPO}/actions/workflows/${file}`,
                  }
                return runHealth(`${file}:schedule`, run)
              }),
            )
          return rows
        },
        4,
      )
    ).flat(),
  )
  return report("github", "GitHub automation and cache", items)
}
