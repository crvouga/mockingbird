import type { PullRequestFacts } from "./lifecycle.js"
import type { PreviewHttpFetch } from "./serving.js"

/**
 * The GitHub REST calls the preview workflow makes with the run's `GITHUB_TOKEN`: pull request
 * facts and bodies, open pull requests, branch heads, and Deployments in transient environments.
 */
export function createPreviewGitHub(options: {
  token: string
  /** `owner/name`. */
  repository: string
  apiUrl?: string
  fetch?: PreviewHttpFetch
}) {
  if (!options.token) throw new Error("A GitHub token is required (GITHUB_TOKEN)")
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository))
    throw new Error("The repository is owner/name")
  const base = `${(options.apiUrl ?? "https://api.github.com").replace(/\/$/, "")}/repos/${options.repository}`
  const call = async (
    operation: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> => {
    let response: Response
    try {
      response = await (options.fetch ?? ((input, request) => fetch(input, request)))(
        `${base}${path}`,
        {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        },
      )
    } catch {
      throw new Error(`GitHub ${operation} failed (network)`)
    }
    if (!response.ok) throw new Error(`GitHub ${operation} failed (HTTP ${response.status})`)
    return response.status === 204 ? undefined : response.json()
  }
  const record = (value: unknown) => (value ?? {}) as Record<string, unknown>

  const pullRequest = async (number: number) => {
    const pr = record(await call("get pull request", `/pulls/${number}`))
    const head = record(pr.head)
    const facts: PullRequestFacts = {
      state: pr.state === "closed" ? "closed" : "open",
      repository: String(record(record(pr.base).repo).full_name ?? ""),
      headRepository: String(record(head.repo).full_name ?? ""),
      head: String(head.sha ?? ""),
    }
    return { facts, body: typeof pr.body === "string" ? pr.body : "" }
  }
  const setPullRequestBody = async (number: number, body: string) => {
    await call("update pull request", `/pulls/${number}`, { method: "PATCH", body: { body } })
  }
  const openPullRequests = async (): Promise<number[]> => {
    const numbers: number[] = []
    for (let page = 1; page <= 100; page++) {
      const items = await call("list pull requests", `/pulls?state=open&per_page=100&page=${page}`)
      if (!Array.isArray(items)) throw new Error("GitHub list pull requests returned no list")
      for (const item of items) numbers.push(Number(record(item).number))
      if (items.length < 100) return numbers
    }
    throw new Error("GitHub list pull requests exceeded the page limit")
  }
  const branchHead = async (branch: string) =>
    String(
      record(record(await call("get branch", `/branches/${encodeURIComponent(branch)}`)).commit)
        .sha ?? "",
    )

  const deploymentsOf = async (environment: string): Promise<number[]> => {
    const items = await call(
      "list deployments",
      `/deployments?environment=${encodeURIComponent(environment)}&per_page=100`,
    )
    if (!Array.isArray(items)) throw new Error("GitHub list deployments returned no list")
    return items.map((item) => Number(record(item).id))
  }
  const status = async (
    id: number,
    state: "in_progress" | "success" | "failure" | "inactive",
    extra: { logUrl?: string; environmentUrl?: string } = {},
  ) => {
    await call("deployment status", `/deployments/${id}/statuses`, {
      method: "POST",
      body: {
        state,
        auto_inactive: false,
        ...(extra.logUrl ? { log_url: extra.logUrl } : {}),
        ...(extra.environmentUrl ? { environment_url: extra.environmentUrl } : {}),
      },
    })
  }
  /** Marks every deployment of `environment` inactive, then deletes it (GitHub refuses active ones). */
  const removeDeployments = async (environment: string, keep?: number) => {
    const removed: number[] = []
    for (const id of await deploymentsOf(environment)) {
      if (id === keep) continue
      await status(id, "inactive")
      await call("delete deployment", `/deployments/${id}`, { method: "DELETE" })
      removed.push(id)
    }
    return removed
  }
  /** A new deployment of `ref` in a transient environment, `in_progress`, earlier ones removed. */
  const startDeployment = async (input: { environment: string; ref: string; logUrl?: string }) => {
    const created = record(
      await call("create deployment", "/deployments", {
        method: "POST",
        body: {
          ref: input.ref,
          environment: input.environment,
          auto_merge: false,
          required_contexts: [],
          transient_environment: true,
          production_environment: false,
          description: "Preview",
        },
      }),
    )
    const id = Number(created.id)
    if (!Number.isSafeInteger(id)) throw new Error("GitHub create deployment returned no id")
    await status(id, "in_progress", input.logUrl ? { logUrl: input.logUrl } : {})
    await removeDeployments(input.environment, id)
    return id
  }
  /** Sets the newest deployment of `environment` to `success` or `failure`. */
  const finishDeployment = async (input: {
    environment: string
    state: "success" | "failure"
    logUrl?: string
    environmentUrl?: string
  }) => {
    const [id] = await deploymentsOf(input.environment)
    if (id === undefined) throw new Error(`No deployment of ${input.environment} to finish`)
    await status(id, input.state, {
      ...(input.logUrl ? { logUrl: input.logUrl } : {}),
      ...(input.environmentUrl ? { environmentUrl: input.environmentUrl } : {}),
    })
    return id
  }
  return {
    pullRequest,
    setPullRequestBody,
    openPullRequests,
    branchHead,
    startDeployment,
    finishDeployment,
    removeDeployments: (environment: string) => removeDeployments(environment),
  }
}

export type PreviewGitHub = ReturnType<typeof createPreviewGitHub>

/** The transient environment one site's Preview of one pull request deploys to. */
export const previewEnvironment = (site: string, preview: string) => `preview/${site}/${preview}`
