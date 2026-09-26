/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type LlamaCloudRuntime, type LlamaCloudRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-llamacloud serve` listens on when none is given. */
export const DEFAULT_PORT = 8805

export type LlamaCloudServerOptions = LlamaCloudRuntimeOptions & {
  /** Default `0`: the OS picks a free port. */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
}

export type LlamaCloudServer = Listening & { runtime: LlamaCloudRuntime }

/** Serve the LlamaCloud mock over `node:http`. */
export const createServer = async (
  options: LlamaCloudServerOptions = {},
): Promise<LlamaCloudServer> => {
  const { port, host, ...rest } = options
  const runtime = createRuntime(rest)
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/** How `serve` (and `serve --config`) builds the LlamaCloud mock from flags. */
export const serveTarget: ServeTarget = {
  name: "llamacloud",
  defaultPort: DEFAULT_PORT,
  options: {
    index: {
      type: "string",
      value: "<name[,name…]>",
      description:
        "Pipelines (indexes) to create in the Default project (the app's LLAMACLOUD_INDEX_NAME); default acme-member-kb-v1",
    },
    project: {
      type: "string",
      value: "<name>",
      description:
        "Project those pipelines live in (the app's LLAMACLOUD_PROJECT_NAME); default Default",
    },
    "api-key": {
      type: "string",
      value: "<key>",
      description: "Accept only this bearer key (default: any non-empty key)",
    },
  },
  create: (values, common) => {
    const index = text(values.index)
    const project = text(values.project)
    const key = text(values["api-key"])
    return createRuntime({
      ...(index
        ? {
            pipelines: index
              .split(",")
              .map((name) => name.trim())
              .filter(Boolean)
              .map((name) => ({ name, ...(project ? { projectName: project } : {}) })),
          }
        : project
          ? { pipelines: [{ name: "acme-member-kb-v1", projectName: project }] }
          : {}),
      ...(key ? { settings: { apiKeys: [key] } } : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: () => [
    "auth: Authorization: Bearer <LLAMACLOUD_API_KEY>",
    "backend: LLAMACLOUD_BASE_URL=<this>/api/v1; Python chat SDK: LLAMA_CLOUD_BASE_URL=<this>",
    "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<api key>: <ns>}",
  ],
}
