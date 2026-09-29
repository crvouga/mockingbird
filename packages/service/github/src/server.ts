/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type GitHubRuntime, type GitHubRuntimeOptions } from "./runtime.js"

export const DEFAULT_PORT = 8828
export type GitHubServerOptions = GitHubRuntimeOptions & { port?: number; host?: string }
export type GitHubServer = Listening & { runtime: GitHubRuntime }

/** Node-only HTTP entry for the GitHub runtime. */
export const createServer = async (options: GitHubServerOptions = {}): Promise<GitHubServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

export const serveTarget: ServeTarget = {
  name: "github",
  defaultPort: DEFAULT_PORT,
  create: (_values, common) =>
    createRuntime({
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    }),
  banner: () => ["GitHub WIP: repository observations with synthetic ancestry; no Git transport"],
}
