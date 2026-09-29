import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  createService,
  defineOperations,
  jsonRes,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { GitHubPulls, pullHandlers } from "./pulls.js"
import { refHandlers } from "./refs.js"

export type { PullRequest } from "./pulls.js"

import { GitHubState } from "./state.js"

export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { GitHubRuntime, GitHubRuntimeOptions } from "./runtime.js"
export { createRuntime } from "./runtime.js"
export type { Commit, Repository } from "./state.js"
export const GITHUB_NAMESPACE = "github"
export const GITHUB_API_VERSION = "2026-03-10"
export type GitHubAPIOptions = APIOptions
const missing = () =>
  jsonRes(404, {
    message: "Not Found",
    documentation_url: "https://docs.github.com/rest/repos/repos#get-a-repository",
    status: "404",
  })
export class GitHubAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly namespace: string
  readonly state: GitHubState
  readonly pulls: GitHubPulls
  private readonly service: Service
  constructor(options: GitHubAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? GITHUB_NAMESPACE
    this.state = new GitHubState(this.sqlite, this.namespace, options.now ?? Date.now)
    this.pulls = new GitHubPulls(this.sqlite, this.namespace, this.state, options.now ?? Date.now)
    this.service = createService({
      document,
      sqlite: this.sqlite,
      namespace: this.namespace,
      now: options.now,
      handlers: defineOperations<SupportedOperationId>({
        ...refHandlers(this.state),
        ...pullHandlers(this.state, this.pulls),
        "repos/get": async ({ params }) => {
          const repo = this.state.repository(params.owner ?? "", params.repo ?? "")
          return repo ? jsonRes(200, repo) : missing()
        },
      }),
      onError: (error) => {
        throw error
      },
      notFound: missing,
      unsupported: (_request, operation) =>
        jsonRes(501, {
          message: `Mockingbird: ${operation.operationId} is not implemented`,
          code: "mockingbird_unsupported",
        }),
    })
    this.app = new Hono().all("*", (c) => this.fetch(c.req.raw))
  }
  async fetch(request: Request): Promise<Response> {
    const version = request.headers.get("X-GitHub-Api-Version")
    if (version && version !== GITHUB_API_VERSION)
      return jsonRes(501, {
        message: "Mockingbird only models GitHub API 2026-03-10",
        code: "mockingbird_unsupported",
      })
    const response = await this.service.fetch(request)
    response.headers.set("x-github-api-version-selected", GITHUB_API_VERSION)
    return response
  }
  async reset(): Promise<void> {
    await this.service.reset()
  }
}
