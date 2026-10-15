import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO, root } from "../release/lib.ts"
import { redactSecrets } from "../secrets/lib.ts"
import type { HealthItem } from "./report.ts"

/** Never include response bodies, credentials, command environments, or authentication URLs in reports. */
export function safeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+)[^\s"']+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/g, "[request URL]")
}

export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
    if (attempt >= 2 || ![429, 502, 503, 504].includes(response.status)) return response
    await response.body?.cancel()
    const seconds = Number(response.headers.get("retry-after"))
    await Bun.sleep(
      Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5000) : 500 * 2 ** attempt,
    )
  }
}

export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await request(url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  try {
    return (await response.json()) as T
  } catch {
    throw new Error("Response was not valid JSON")
  }
}

export async function command(args: string[], timeoutMs = 45_000): Promise<string> {
  const proc = Bun.spawn(args, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (code !== 0) {
      const status = /HTTP (\d+)/.exec(err)?.[1]
      throw new Error(
        `${args[0]} ${status ? `HTTP ${status}` : `exited ${code}`}; check authentication and repository access`,
      )
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

export async function github<T>(path: string): Promise<T> {
  return JSON.parse(await command(["gh", "api", path])) as T
}

export async function githubPages<T>(path: string, field?: string): Promise<T[]> {
  const pages = JSON.parse(
    await command(["gh", "api", "--paginate", "--slurp", path], 90_000),
  ) as unknown[]
  return pages.flatMap((page) => {
    const rows = field ? (page as Record<string, unknown>)[field] : page
    if (!Array.isArray(rows)) throw new Error("GitHub returned an unexpected paginated response")
    return rows as T[]
  })
}

export async function pool<T, R>(
  values: readonly T[],
  work: (value: T) => Promise<R>,
  concurrency = 8,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const next = index++
        if (next >= values.length) return
        results[next] = await work(values[next] as T)
      }
    }),
  )
  return results
}

export async function inspect(id: string, work: () => Promise<HealthItem>): Promise<HealthItem> {
  try {
    return await work()
  } catch (error) {
    return {
      id,
      status: "unknown",
      message: safeError(error),
      remedy: "Restore access or connectivity and rerun this check.",
    }
  }
}

export function yamlFile(path: string): Record<string, unknown> {
  return Bun.YAML.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>
}

export type WorkflowRun = {
  id: number
  head_sha: string
  status: string
  conclusion: string | null
  html_url: string
  created_at: string
  updated_at: string
  event: string
  display_title?: string
}
export async function workflowRuns(file: string, repo = REPO): Promise<WorkflowRun[]> {
  const value = await github<{ workflow_runs: WorkflowRun[] }>(
    `repos/${repo}/actions/workflows/${file}/runs?branch=main&per_page=20`,
  )
  return value.workflow_runs
}

export const MAIN_RAW = `https://raw.githubusercontent.com/${REPO}/main`
export const INFRA_REPO = "crvouga/workspace"
export const INFRA_RAW = `https://raw.githubusercontent.com/${INFRA_REPO}/main`
export const HOSTING_CONTRACT = `${INFRA_RAW}/llms.txt`
export const INVENTORY_URL = `${INFRA_RAW}/packages/infra/tofu/modules/inventory/inventory.tf.json`
