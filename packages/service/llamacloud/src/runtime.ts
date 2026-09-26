import {
  type AdminRoutes,
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { document } from "./generated/openapi.js"
import { LLAMACLOUD_NAMESPACE, LlamaCloudAPI } from "./index.js"
import type { PipelineSeed, RetrievalRule, ScriptedNode, Settings } from "./state.js"

/**
 * Every named LlamaCloud misbehaviour our consumers branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const LLAMACLOUD_PRESETS: Record<string, FaultPreset> = {
  index_missing: {
    description:
      "Pipeline search answers []: the backend logs 'pipeline not found' and every knowledge call returns empty; the SDK raises 'Unknown index name'",
    rules: [{ operationId: "SearchPipelines", effect: "index_missing" }],
  },
  retrieval_empty: {
    description: "Retrieval answers no nodes (the chat tools report no knowledge found)",
    rules: [{ operationId: "RunSearch", effect: "retrieval_empty" }],
  },
  documents_unexpected_shape: {
    description:
      "Document list answers an object instead of an array (the backend treats it as empty)",
    rules: [{ operationId: "ListPipelineDocuments", effect: "documents_unexpected_shape" }],
  },
  unauthorized: {
    description:
      "Every call answers 401 Invalid API key (non-2xx: the backend logs and returns null)",
    rules: [{ pathPrefix: "/api/v1", status: 401, body: { detail: "Invalid API key" } }],
  },
  rate_limited: {
    description: "Every call answers 429",
    rules: [{ pathPrefix: "/api/v1", status: 429, body: { detail: "Rate limit exceeded" } }],
  },
  server_error: {
    description: "Every call answers 500 (the SDK retries 5xx with backoff; the backend does not)",
    rules: [{ pathPrefix: "/api/v1", status: 500, body: { detail: "Internal Server Error" } }],
  },
  slow_retrieval: {
    description: "Retrieval takes 3 s (override with latencyMs)",
    rules: [{ operationId: "RunSearch", latencyMs: 3_000 }],
  },
}

export type LlamaCloudRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  pipelines?: readonly PipelineSeed[]
  settings?: Partial<Settings>
}

export type LlamaCloudRuntime = ServiceRuntime<LlamaCloudAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseRule = (value: unknown): RetrievalRule | string => {
  if (!isRecord(value))
    return "a rule is {match: {contains?, pipeline?}, nodes: [{text, score?, metadata?}]}"
  const match = value.match ?? {}
  if (!isRecord(match)) return "match must be an object"
  if (match.contains !== undefined && typeof match.contains !== "string")
    return "match.contains must be a string"
  if (match.pipeline !== undefined && typeof match.pipeline !== "string")
    return "match.pipeline must be a pipeline id or name"
  if (!Array.isArray(value.nodes)) return "nodes must be a list"
  const nodes: ScriptedNode[] = []
  for (const node of value.nodes) {
    if (!isRecord(node) || typeof node.text !== "string") return "each node needs text"
    if (node.score !== undefined && typeof node.score !== "number") return "node.score: number"
    if (node.metadata !== undefined && !isRecord(node.metadata)) return "node.metadata: object"
    nodes.push({
      text: node.text,
      ...(typeof node.score === "number" ? { score: node.score } : {}),
      ...(isRecord(node.metadata) ? { metadata: node.metadata } : {}),
    })
  }
  return {
    match: {
      ...(typeof match.contains === "string" ? { contains: match.contains } : {}),
      ...(typeof match.pipeline === "string" ? { pipeline: match.pipeline } : {}),
    },
    nodes,
  }
}

const adminRoutes = (runtime: ServiceRuntime<LlamaCloudAPI>): AdminRoutes => ({
  "GET /pipelines": ({ namespace }) => {
    const state = runtime.instance(namespace).state
    return json(200, {
      projects: state.projects.list({ order: "oldest" }).map((row) => row.value),
      pipelines: state.pipelines.list({ order: "oldest" }).map((row) => row.value),
    })
  },
  "PUT /pipelines": ({ body, namespace }) => {
    if (!isRecord(body) || typeof body.name !== "string" || body.name.length === 0) {
      return adminError(400, 'expected {"name": "<index name>", "projectName"?: "Default"}')
    }
    const project = typeof body.projectName === "string" ? body.projectName : undefined
    return json(200, runtime.instance(namespace).state.createPipeline(body.name, project))
  },
  "GET /pipelines/:pipeline/documents": ({ params, namespace }) => {
    const docs = runtime.instance(namespace).documents(params.pipeline as string)
    return docs ? json(200, { documents: docs }) : adminError(404, `no pipeline ${params.pipeline}`)
  },
  "GET /retrieval": ({ namespace }) => json(200, { rules: runtime.instance(namespace).rules() }),
  "PUT /retrieval": ({ body, namespace }) => {
    const api = runtime.instance(namespace)
    if (isRecord(body) && Array.isArray(body.rules)) {
      const parsed = body.rules.map(parseRule)
      const bad = parsed.find((rule) => typeof rule === "string")
      if (typeof bad === "string") return adminError(400, bad)
      api.clearRules()
      for (const rule of [...(parsed as RetrievalRule[])].reverse()) api.addRule(rule)
      return json(200, { rules: api.rules() })
    }
    const rule = parseRule(body)
    if (typeof rule === "string") return adminError(400, rule)
    api.addRule(rule)
    return json(200, { rules: api.rules() })
  },
  "DELETE /retrieval": ({ namespace }) => {
    runtime.instance(namespace).clearRules()
    return json(200, { rules: [] })
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.apiKeys !== undefined) {
      if (!Array.isArray(body.apiKeys)) return adminError(400, "apiKeys: string[]")
      patch.apiKeys = body.apiKeys.map(String)
    }
    if (body.defaultTopK !== undefined) {
      if (typeof body.defaultTopK !== "number" || body.defaultTopK < 1)
        return adminError(400, "defaultTopK: positive number")
      patch.defaultTopK = body.defaultTopK
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The LlamaCloud mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by API key
 * (`PUT /__admin/credentials {"credentials": {"<LLAMACLOUD_API_KEY>": "<namespace>"}}`),
 * clock control, fault presets and a request journal (metadata only: never queries or text).
 */
export const createRuntime = (options: LlamaCloudRuntimeOptions = {}): LlamaCloudRuntime =>
  createServiceRuntime<LlamaCloudAPI>({
    name: LLAMACLOUD_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: bearerToken,
    presets: LLAMACLOUD_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new LlamaCloudAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.pipelines ? { pipelines: options.pipelines } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
