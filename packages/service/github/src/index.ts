import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type GitHubSeedConfig,
  githubPlugin,
  materializeGitHubSeedConfig,
  ProviderExpansion,
  type ProviderOptions,
  seedGithub,
  selectOperations,
} from "@crvouga/mockingbird-http-provider"
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
import { syncFromExpanded, syncToExpanded } from "./expanded-state.js"
import { document } from "./generated/openapi.js"
import { type NativeOperationId, nativeOperationIds } from "./native-operations.js"
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
export type GitHubAPIOptions = APIOptions &
  Pick<ProviderOptions, "tokens" | "baseUrl" | "publicNamespace" | "adminPrefix" | "random"> & {
    fixtures?: GitHubSeedConfig
  }
export type GitHubFixtures = GitHubSeedConfig
export type PreparedGitHubFixtures = {
  fixtures: GitHubFixtures
  /** Only omitted keys that were generated; explicitly supplied keys are excluded. */
  generatedPrivateKeys: readonly {
    app_id: number
    slug: string
    name: string
    private_key: string
  }[]
}

/** Prepare synthetic GitHub App identities once, then reuse them across runtime resets. */
export async function prepareFixtures(fixtures: GitHubFixtures): Promise<PreparedGitHubFixtures> {
  const prepared = await materializeGitHubSeedConfig(fixtures)
  return { fixtures: prepared.config, generatedPrivateKeys: prepared.generatedPrivateKeys }
}
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
  private tail: Promise<unknown> = Promise.resolve()
  private readonly expansion: ProviderExpansion
  private readonly service: Service
  constructor(options: GitHubAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? GITHUB_NAMESPACE
    this.state = new GitHubState(this.sqlite, this.namespace, options.now ?? Date.now)
    this.pulls = new GitHubPulls(this.sqlite, this.namespace, this.state, options.now ?? Date.now)
    this.service = createService({
      document: selectOperations(document, nativeOperationIds),
      sqlite: this.sqlite,
      namespace: this.namespace,
      now: options.now,
      handlers: defineOperations<NativeOperationId>({
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
    this.expansion = new ProviderExpansion(
      githubPlugin,
      selectOperations(document, nativeOperationIds),
      {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
        ...(options.random ? { random: options.random } : {}),
        sqlite: this.sqlite,
        namespace: this.namespace,
        ...(options.publicNamespace !== undefined
          ? { publicNamespace: options.publicNamespace }
          : {}),
        ...(options.adminPrefix !== undefined ? { adminPrefix: options.adminPrefix } : {}),
        ...(options.now ? { now: options.now } : {}),
      },
    )
    if (options.fixtures) {
      this.expansion.configureFixtures(options.fixtures, seedGithub)
      syncFromExpanded(this.state, this.expansion)
    }
    this.app = new Hono().all("*", (c) => this.fetch(c.req.raw))
  }
  fetch(request: Request): Promise<Response> {
    const result = this.tail.then(
      () => this.handleFetch(request),
      () => this.handleFetch(request),
    )
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  private async handleFetch(request: Request): Promise<Response> {
    const version = request.headers.get("X-GitHub-Api-Version")
    if (version && version !== GITHUB_API_VERSION)
      return jsonRes(501, {
        message: "Mockingbird only models GitHub API 2026-03-10",
        code: "mockingbird_unsupported",
      })
    const expanded = this.expansion.handles(request)
    if (expanded) syncToExpanded(this.state, this.expansion)
    const response = expanded
      ? await this.expansion.fetch(request)
      : await this.service.fetch(request)
    if (expanded) syncFromExpanded(this.state, this.expansion)
    response.headers.set("x-github-api-version-selected", GITHUB_API_VERSION)
    return response
  }
  async reset(): Promise<void> {
    await this.tail
    await this.service.reset()
    await this.expansion.reset()
    syncFromExpanded(this.state, this.expansion)
  }
}
