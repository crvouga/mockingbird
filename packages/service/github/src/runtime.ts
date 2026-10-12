import {
  createRuntime as createServiceRuntime,
  jsonRes,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import type { GitHubAPIOptions } from "./index.js"
import { GITHUB_NAMESPACE, GitHubAPI } from "./index.js"
import { presets } from "./presets.js"
import { validRef } from "./refs.js"
import { RefError, record, SeedError } from "./state.js"
export type GitHubRuntimeOptions = Pick<
  RuntimeOptions<GitHubAPI>,
  | "sqlite"
  | "clock"
  | "seed"
  | "adminPrefix"
  | "adminKey"
  | "adminControls"
  | "onLog"
  | "journalSize"
  | "maxCheckpoints"
> &
  Pick<GitHubAPIOptions, "fixtures" | "baseUrl" | "tokens">
export type GitHubRuntime = ServiceRuntime<GitHubAPI>
export const createRuntime = (options: GitHubRuntimeOptions = {}): GitHubRuntime => {
  const runtime = createServiceRuntime<GitHubAPI>({
    ...options,
    name: GITHUB_NAMESPACE,
    document,
    presets,
    admin: (runtime) => ({
      "POST /github/refs/move": ({ body, namespace }) => {
        if (
          !record(body) ||
          typeof body.owner !== "string" ||
          typeof body.repo !== "string" ||
          typeof body.ref !== "string" ||
          !body.ref.startsWith("refs/heads/") ||
          !validRef(body.ref) ||
          typeof body.sha !== "string" ||
          !/^[a-fA-F0-9]{40}$/.test(body.sha)
        )
          return jsonRes(400, {
            code: "mockingbird_control_invalid",
            message: "Expected owner, repo, full branch ref and seeded 40-hex sha",
          })
        try {
          const reference = runtime
            .instance(namespace)
            .state.writeReference(
              body.owner,
              body.repo,
              body.ref,
              body.sha.toLowerCase(),
              false,
              false,
            )
          const checkpoint = runtime.checkpoint(namespace)
          return jsonRes(200, { reference, checkpoint: checkpoint.id, simulated: true })
        } catch (error) {
          if (error instanceof RefError)
            return jsonRes(error.status, {
              code: "mockingbird_control_invalid",
              message: error.message,
            })
          throw error
        }
      },
      "POST /github/repositories": ({ body, namespace }) => {
        try {
          const repo = runtime.instance(namespace).state.seed(body)
          runtime.checkpoint(namespace)
          return jsonRes(201, { repository: repo, simulated: true })
        } catch (error) {
          if (error instanceof SeedError)
            return jsonRes(error.status, {
              message: error.message,
              code: "mockingbird_seed_invalid",
            })
          throw error
        }
      },
    }),
    create: ({ sqlite, namespace, publicNamespace, adminPrefix, clock, rng }) =>
      new GitHubAPI({
        sqlite,
        namespace,
        publicNamespace,
        adminPrefix,
        now: clock.now,
        random: rng.next,
        ...(options.fixtures ? { fixtures: options.fixtures } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.tokens ? { tokens: options.tokens } : {}),
      }),
  })

  const fetch = runtime.fetch
  runtime.fetch = async (request) => {
    const response = await fetch(request)
    const links = response.headers.get("link")
    if (!links) return response
    const source = new URL(request.url)
    const adminPrefix = options.adminPrefix ?? "/__admin"
    const prefix = source.pathname.startsWith(`${adminPrefix}/ns/`)
      ? /^([^/]+)(?:\/|$)/.exec(source.pathname.slice(`${adminPrefix}/ns/`.length))
      : null
    const namespace =
      request.headers.get("x-mockingbird-namespace") ??
      (prefix?.[1] ? decodeURIComponent(prefix[1]) : undefined)
    if (!namespace) return response
    response.headers.set(
      "link",
      links.replace(/<([^>]+)>/g, (original, href: string) => {
        const target = new URL(href, source)
        if (target.origin !== source.origin || !target.pathname.startsWith("/repos/"))
          return original
        target.pathname = `${adminPrefix}/ns/${encodeURIComponent(namespace)}${target.pathname}`
        return `<${target.href}>`
      }),
    )
    return response
  }
  return runtime
}
