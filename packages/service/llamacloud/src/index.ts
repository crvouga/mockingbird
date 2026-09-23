import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { documentNode, matchRule, rank, scriptedNode } from "./retrieval.js"
import {
  DEFAULT_PIPELINES,
  type DocumentRecord,
  LlamaCloudState,
  type PipelineRecord,
  type PipelineSeed,
  type ProjectRecord,
  type RetrievalRule,
  type Settings,
  uuidFrom,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { rank, terms } from "./retrieval.js"
export type {
  DocumentRecord,
  PipelineRecord,
  PipelineSeed,
  ProjectRecord,
  RetrievalRule,
  ScriptedNode,
  Settings,
} from "./state.js"
export {
  DEFAULT_PIPELINE_NAME,
  DEFAULT_PIPELINES,
  DEFAULT_PROJECT_NAME,
  DEFAULT_SETTINGS,
  uuidFrom,
} from "./state.js"

export const LLAMACLOUD_NAMESPACE = "llamacloud"

export type LlamaCloudAPIOptions = APIOptions & {
  /** Pipelines every namespace starts with. Default: {@link DEFAULT_PIPELINES}. */
  pipelines?: readonly PipelineSeed[]
  /** Initial per-namespace settings (accepted API keys, default top-k). */
  settings?: Partial<Settings>
}

const detail = (status: number, message: string) => jsonRes(status, { detail: message })

/** FastAPI's 422 body, one entry per issue. */
const validationFailed = (issues: { path: string; message: string }[]) =>
  jsonRes(422, {
    detail: issues.map((issue) => ({
      loc: ["body", ...issue.path.split(".").filter(Boolean)].map((part) =>
        /^\d+$/.test(part) ? Number(part) : part,
      ),
      msg: issue.message,
      type: "value_error",
    })),
  })

const projectBody = (project: ProjectRecord) => ({
  id: project.id,
  name: project.name,
  organization_id: project.organization_id,
  is_default: project.is_default,
  ad_hoc_eval_dataset_id: null,
  created_at: project.created_at,
  updated_at: project.updated_at,
})

const pipelineBody = (pipeline: PipelineRecord) => ({
  id: pipeline.id,
  name: pipeline.name,
  project_id: pipeline.project_id,
  pipeline_type: pipeline.pipeline_type,
  embedding_config: {
    type: "MANAGED_OPENAI_EMBEDDING",
    component: { model_name: "openai-text-embedding-3-small" },
  },
  status: "CREATED",
  created_at: pipeline.created_at,
  updated_at: pipeline.updated_at,
})

const documentBody = (doc: DocumentRecord) => ({
  id: doc.id,
  text: doc.text,
  metadata: doc.metadata,
  excluded_embed_metadata_keys: doc.excluded_embed_metadata_keys,
  excluded_llm_metadata_keys: doc.excluded_llm_metadata_keys,
  page_positions: doc.page_positions,
  status_metadata: null,
})

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Stateful mock of the LlamaCloud platform API: projects, pipelines, pipeline documents and
 * retrieval. Answers both the backend's plain-`fetch` adapter and the official Python SDK
 * (`LlamaCloudIndex(name, project_name=…).as_retriever().aretrieve(query)`).
 */
export class LlamaCloudAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: LlamaCloudState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: LlamaCloudAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? LLAMACLOUD_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new LlamaCloudState(
      sqlite,
      namespace,
      { pipelines: options.pipelines ?? DEFAULT_PIPELINES, settings: options.settings ?? {} },
      () => this.iso(),
    )
    const handlers = defineOperations<SupportedOperationId>({
      ListProjects: (context) => this.listProjects(context),
      GetProject: (context) => this.getProject(context),
      SearchPipelines: (context) => this.searchPipelines(context),
      GetPipeline: (context) =>
        this.withPipeline(context, (pipeline) => jsonRes(200, pipelineBody(pipeline))),
      RunSearch: (context) => this.withPipeline(context, (p) => this.retrieve(context, p)),
      ListPipelineDocuments: (context) =>
        this.withPipeline(context, (p) => this.listDocuments(context, p)),
      CreateBatchPipelineDocuments: (context) =>
        this.withPipeline(context, (p) => this.putDocuments(context, p)),
      UpsertBatchPipelineDocuments: (context) =>
        this.withPipeline(context, (p) => this.putDocuments(context, p)),
      GetPipelineDocument: (context) =>
        this.withPipeline(context, (p) => {
          const doc = this.state.getDocument(p.id, context.params.document_id ?? "")
          return doc
            ? annotateResponse(jsonRes(200, documentBody(doc)), {
                ids: { pipelineId: p.id, documentId: doc.id },
              })
            : detail(404, "Document not found")
        }),
      DeletePipelineDocument: (context) =>
        this.withPipeline(context, (p) => {
          const id = context.params.document_id ?? ""
          if (!this.state.deleteDocument(p.id, id)) return detail(404, "Document not found")
          return annotateResponse(new Response(null, { status: 204 }), {
            ids: { pipelineId: p.id, documentId: id },
          })
        }),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => detail(404, "Not Found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const token = bearerToken(context.request)
        if (!token) return detail(401, "Not authenticated")
        const keys = this.state.current().apiKeys
        if (keys.length > 0 && !keys.includes(token)) return detail(401, "Invalid API key")
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private withPipeline(
    context: OperationContext,
    handle: (pipeline: PipelineRecord) => Response | Promise<Response>,
  ): Response | Promise<Response> {
    const pipeline = this.state.pipelines.get(context.params.pipeline_id ?? "")
    return pipeline ? handle(pipeline) : detail(404, "Pipeline not found")
  }

  private listProjects(context: OperationContext): Response {
    const name = text(context.query.project_name)
    const org = text(context.query.organization_id)
    const projects = this.state.projects
      .list({ order: "oldest" })
      .map((row) => row.value)
      .filter((p) => name === undefined || p.name === name)
      .filter((p) => org === undefined || p.organization_id === org)
    return jsonRes(200, projects.map(projectBody))
  }

  private getProject(context: OperationContext): Response {
    const project = this.state.projects.get(context.params.project_id ?? "")
    return project ? jsonRes(200, projectBody(project)) : detail(404, "Project not found")
  }

  private searchPipelines(context: OperationContext): Response {
    if (faultEffect(context.request, "index_missing") !== undefined) return jsonRes(200, [])
    const projectId = text(context.query.project_id)
    const projectName = text(context.query.project_name)
    const name = text(context.query.pipeline_name)
    const type = text(context.query.pipeline_type)
    const org = text(context.query.organization_id)
    const byName =
      projectName === undefined
        ? undefined
        : this.state.projects
            .list()
            .filter((row) => row.value.name === projectName)
            .map((row) => row.id)
    const pipelines = this.state.pipelines
      .list({ order: "oldest" })
      .map((row) => row.value)
      .filter((p) => projectId === undefined || p.project_id === projectId)
      .filter((p) => byName === undefined || byName.includes(p.project_id))
      .filter((p) => name === undefined || p.name === name)
      .filter((p) => type === undefined || p.pipeline_type === type)
      .filter(() => org === undefined || org === this.state.organizationId)
    return jsonRes(200, pipelines.map(pipelineBody))
  }

  private retrieve(context: OperationContext, pipeline: PipelineRecord): Response {
    const issues = bodyIssues(context)
    if (issues.length > 0) return validationFailed(issues)
    const body = context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
    const query = String(body.query)
    const topK =
      typeof body.dense_similarity_top_k === "number"
        ? body.dense_similarity_top_k
        : this.state.current().defaultTopK
    const ids = { pipelineId: pipeline.id }
    const empty = faultEffect(context.request, "retrieval_empty") !== undefined
    const rule = empty
      ? undefined
      : matchRule(
          this.state.rules.list({ order: "newest" }).map((row) => row.value),
          query,
          pipeline,
        )
    const nodes = empty
      ? []
      : rule
        ? rule.nodes.slice(0, topK).map(scriptedNode)
        : rank(query, this.state.documentsOf(pipeline.id), topK).map((ranked) =>
            documentNode(pipeline.id, ranked),
          )
    return annotateResponse(
      jsonRes(200, {
        pipeline_id: pipeline.id,
        retrieval_nodes: nodes,
        image_nodes: [],
        page_figure_nodes: [],
        retrieval_latency: {},
        metadata: {},
        inferred_search_filters: null,
        class_name: "base_component",
      }),
      { ids },
    )
  }

  private listDocuments(context: OperationContext, pipeline: PipelineRecord): Response {
    if (faultEffect(context.request, "documents_unexpected_shape") !== undefined) {
      return jsonRes(200, { documents: this.state.documentsOf(pipeline.id).map(documentBody) })
    }
    const skip = Number(context.query.skip ?? 0)
    const limit = context.query.limit === undefined ? undefined : Number(context.query.limit)
    if (!Number.isInteger(skip) || skip < 0 || (limit !== undefined && !(limit >= 1))) {
      return jsonRes(422, {
        detail: [{ loc: ["query", "skip"], msg: "invalid pagination", type: "value_error" }],
      })
    }
    const docs = this.state.documentsOf(pipeline.id)
    const page = docs.slice(skip, limit === undefined ? undefined : skip + limit)
    return annotateResponse(jsonRes(200, page.map(documentBody)), {
      ids: { pipelineId: pipeline.id },
    })
  }

  private putDocuments(context: OperationContext, pipeline: PipelineRecord): Response {
    const issues = bodyIssues(context)
    if (issues.length > 0) return validationFailed(issues)
    const batch = (context.body.kind === "json" ? context.body.value : []) as Record<
      string,
      unknown
    >[]
    const stored = batch.map((item) =>
      this.state.putDocument({
        pipeline_id: pipeline.id,
        id:
          text(item.id) ??
          uuidFrom(`llamacloud:document:${pipeline.id}:${this.state.documents.nextSequence()}`),
        text: String(item.text ?? ""),
        metadata: { ...(item.metadata as Record<string, unknown>) },
        excluded_embed_metadata_keys: strings(item.excluded_embed_metadata_keys),
        excluded_llm_metadata_keys: strings(item.excluded_llm_metadata_keys),
        page_positions: Array.isArray(item.page_positions)
          ? item.page_positions.filter((n): n is number => typeof n === "number")
          : null,
      }),
    )
    return annotateResponse(jsonRes(200, stored.map(documentBody)), {
      ids: { pipelineId: pipeline.id, documentId: stored.map((d) => d.id).join(",") },
    })
  }

  /** Every document in a pipeline (by id or name), for admin inspection. */
  documents(pipeline: string): DocumentRecord[] | undefined {
    const found = this.state.findPipeline(pipeline)
    return found ? this.state.documentsOf(found.id) : undefined
  }

  /** Add a scripted retrieval rule; the most recently added matching rule wins. */
  addRule(rule: RetrievalRule): void {
    this.state.rules.insert(`rule_${this.state.rules.nextSequence()}`, rule)
  }

  rules(): RetrievalRule[] {
    return this.state.rules.list({ order: "newest" }).map((row) => row.value)
  }

  clearRules(): void {
    for (const row of this.state.rules.list()) this.state.rules.delete(row.id)
  }
}

export type { LlamaCloudRuntime, LlamaCloudRuntimeOptions } from "./runtime.js"
export { createRuntime, LLAMACLOUD_PRESETS } from "./runtime.js"
