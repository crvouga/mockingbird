import {
  createRuntime as createServiceRuntime,
  jsonRes,
  type RuntimeOptions,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { GITHUB_NAMESPACE, GitHubAPI } from "./index.js"
import { presets } from "./presets.js"
import { validRef } from "./refs.js"
import { RefError, record, SeedError } from "./state.js"
export type GitHubRuntimeOptions = Pick<
  RuntimeOptions<GitHubAPI>,
  "sqlite" | "clock" | "seed" | "adminKey" | "onLog" | "journalSize" | "maxCheckpoints"
>
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
    create: ({ sqlite, namespace, clock }) => new GitHubAPI({ sqlite, namespace, now: clock.now }),
  })

  const fetch = runtime.fetch
  runtime.fetch = async (request) => {
    const response = await fetch(request)
    const links = response.headers.get("link")
    if (!links) return response
    const source = new URL(request.url)
    const prefix = /^\/ns\/([^/]+)(?:\/|$)/.exec(source.pathname)
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
        target.pathname = `/ns/${encodeURIComponent(namespace)}${target.pathname}`
        return `<${target.href}>`
      }),
    )
    return response
  }
  return runtime
}
