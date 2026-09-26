/// <reference types="node" />
import { readFile } from "node:fs/promises"
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { OAUTH_SCENARIOS, type OAuthScenario } from "./behavior.js"
import {
  createMultiRuntime,
  type OAuthMount,
  type OAuthMultiRuntime,
  type OAuthMultiRuntimeOptions,
} from "./multi.js"
import { createRuntime, type OAuthRuntime, type OAuthRuntimeOptions } from "./runtime.js"
export const DEFAULT_PORT = 8810
export type OAuthServerOptions = OAuthRuntimeOptions & { port?: number; host?: string }
export const createServer = async (
  options: OAuthServerOptions = {},
): Promise<Listening & { runtime: OAuthRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export type OAuthMultiServerOptions = OAuthMultiRuntimeOptions & { port?: number; host?: string }
export const createMultiServer = async (
  options: OAuthMultiServerOptions,
): Promise<Listening & { runtime: OAuthMultiRuntime }> => {
  const { port, host, ...rest } = options
  const runtime = createMultiRuntime(rest)
  return { ...(await listen(runtime, { port: port ?? 0, ...(host ? { host } : {}) })), runtime }
}
export const serveTarget: ServeTarget = {
  name: "oauth",
  defaultPort: DEFAULT_PORT,
  options: {
    provider: {
      type: "string",
      value: "<google|apple|microsoft|github|oidc>",
      description: "Provider wire profile (default oidc)",
    },
    scenario: {
      type: "string",
      value: "<name>",
      description: "Initial behavior scenario (GET /__admin/scenarios lists all)",
    },
    issuer: { type: "string", value: "<url>", description: "Public issuer URL" },
    mounts: {
      type: "string",
      value: "<file>",
      description: "JSON file with a mounts array; serves every provider on one listener",
    },
  },
  create: async (values, common) => {
    if (typeof values.mounts === "string") {
      const parsed = JSON.parse(await readFile(values.mounts, "utf8")) as { mounts?: OAuthMount[] }
      if (!Array.isArray(parsed.mounts))
        throw new Error("OAuth mounts file requires a mounts array")
      return createMultiRuntime({
        mounts: parsed.mounts,
        ...(common.seed !== undefined ? { seed: common.seed } : {}),
        ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      }) as unknown as OAuthRuntime
    }
    const provider = values.provider ?? "oidc"
    if (
      provider !== "google" &&
      provider !== "apple" &&
      provider !== "oidc" &&
      provider !== "microsoft" &&
      provider !== "github"
    )
      throw new Error("provider must be google, apple, microsoft, github or oidc")
    if (
      values.scenario !== undefined &&
      (typeof values.scenario !== "string" || !Object.hasOwn(OAUTH_SCENARIOS, values.scenario))
    )
      throw new Error("Unknown OAuth scenario")
    return createRuntime({
      provider,
      ...(typeof values.scenario === "string"
        ? { behavior: { preset: values.scenario as OAuthScenario } }
        : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(typeof values.issuer === "string" ? { issuer: values.issuer } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
    })
  },
  banner: () => [
    "Register clients: POST /__admin/clients; seed identities: POST /__admin/accounts",
    "Discovery: /.well-known/openid-configuration",
  ],
}
