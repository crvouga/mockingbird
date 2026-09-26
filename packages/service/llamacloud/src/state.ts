import { Collection, opaqueToken } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

export type ProjectRecord = {
  id: string
  name: string
  organization_id: string
  is_default: boolean
  created_at: string
  updated_at: string
}

export type PipelineRecord = {
  id: string
  name: string
  project_id: string
  pipeline_type: "MANAGED" | "PLAYGROUND"
  created_at: string
  updated_at: string
}

/** One document as LlamaCloud returns it. The mock does not chunk: a document is one node. */
export type DocumentRecord = {
  pipeline_id: string
  id: string
  text: string
  metadata: Record<string, unknown>
  excluded_embed_metadata_keys: string[]
  excluded_llm_metadata_keys: string[]
  page_positions: number[] | null
}

/** A node a scripted retrieval rule answers with. */
export type ScriptedNode = { text: string; score?: number; metadata?: Record<string, unknown> }

/**
 * `PUT /__admin/retrieval`: when a query contains `match.contains` (case-insensitive) — and,
 * if given, targets `match.pipeline` (id or name) — retrieval answers `nodes` verbatim
 * instead of ranking the stored documents.
 */
export type RetrievalRule = {
  match: { contains?: string; pipeline?: string }
  nodes: ScriptedNode[]
}

/** A pipeline to create at boot (and again after every reset). */
export type PipelineSeed = { name: string; projectName?: string }

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these bearer keys are accepted; empty means any non-empty key is. */
  apiKeys: string[]
  /** `dense_similarity_top_k` when a retrieve request omits it. */
  defaultTopK: number
}

export const DEFAULT_SETTINGS: Settings = { apiKeys: [], defaultTopK: 5 }

export const DEFAULT_PROJECT_NAME = "Default"
/** The member-app knowledge-base pipeline name (`LLAMACLOUD_INDEX_NAME` in dev). */
export const DEFAULT_PIPELINE_NAME = "acme-member-kb-v1"
export const DEFAULT_PIPELINES: readonly PipelineSeed[] = [
  { name: DEFAULT_PIPELINE_NAME, projectName: DEFAULT_PROJECT_NAME },
]

/** A stable UUID-shaped id derived from `input` (LlamaCloud ids are UUIDs). */
export const uuidFrom = (input: string): string => {
  const hex = [...opaqueToken(input, 32)].map((c) => (c.charCodeAt(0) % 16).toString(16)).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class LlamaCloudState {
  readonly projects: Collection<ProjectRecord>
  readonly pipelines: Collection<PipelineRecord>
  readonly documents: Collection<DocumentRecord>
  readonly rules: Collection<RetrievalRule>
  readonly settings: Collection<Settings>
  readonly organizationId: string

  constructor(
    sqlite: SqliteClient,
    private readonly namespace: string,
    private readonly seed: { pipelines: readonly PipelineSeed[]; settings: Partial<Settings> },
    private readonly iso: () => string,
  ) {
    this.projects = new Collection(sqlite, namespace, "projects")
    this.pipelines = new Collection(sqlite, namespace, "pipelines")
    this.documents = new Collection(sqlite, namespace, "documents")
    this.rules = new Collection(sqlite, namespace, "retrieval_rules")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.organizationId = uuidFrom(`llamacloud:org:${namespace}`)
    this.ensureSeeded()
  }

  /** Re-create the seeded projects, pipelines and settings after a reset. */
  ensureSeeded(): void {
    if (this.pipelines.count() === 0) {
      for (const seed of this.seed.pipelines) this.createPipeline(seed.name, seed.projectName)
    }
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** The project with this name, created on first use (the first one is the default). */
  ensureProject(name: string): ProjectRecord {
    const existing = this.projects.list({ where: (p) => p.name === name }).at(0)?.value
    if (existing) return existing
    const now = this.iso()
    const project: ProjectRecord = {
      id: uuidFrom(`llamacloud:project:${this.namespace}:${name}`),
      name,
      organization_id: this.organizationId,
      is_default: this.projects.count() === 0,
      created_at: now,
      updated_at: now,
    }
    this.projects.insert(project.id, project)
    return project
  }

  /** Create (or return) a managed pipeline in a project. */
  createPipeline(name: string, projectName = DEFAULT_PROJECT_NAME): PipelineRecord {
    const project = this.ensureProject(projectName)
    const existing = this.pipelines
      .list({ where: (p) => p.name === name && p.project_id === project.id })
      .at(0)?.value
    if (existing) return existing
    const now = this.iso()
    const pipeline: PipelineRecord = {
      id: uuidFrom(`llamacloud:pipeline:${this.namespace}:${project.id}:${name}`),
      name,
      project_id: project.id,
      pipeline_type: "MANAGED",
      created_at: now,
      updated_at: now,
    }
    this.pipelines.insert(pipeline.id, pipeline)
    return pipeline
  }

  /** A pipeline by id or by name (admin routes accept either). */
  findPipeline(idOrName: string): PipelineRecord | undefined {
    return (
      this.pipelines.get(idOrName) ??
      this.pipelines.list({ order: "oldest", where: (p) => p.name === idOrName }).at(0)?.value
    )
  }

  documentsOf(pipelineId: string): DocumentRecord[] {
    return this.documents
      .list({ order: "oldest", where: (d) => d.pipeline_id === pipelineId })
      .map((row) => row.value)
  }

  getDocument(pipelineId: string, id: string): DocumentRecord | undefined {
    return this.documents.get(`${pipelineId}/${id}`)
  }

  /** Replace a document with the same id in place, or append a new one. */
  putDocument(document: DocumentRecord): DocumentRecord {
    const key = `${document.pipeline_id}/${document.id}`
    if (!this.documents.update(key, document)) this.documents.insert(key, document)
    return document
  }

  deleteDocument(pipelineId: string, id: string): boolean {
    return this.documents.delete(`${pipelineId}/${id}`)
  }
}
