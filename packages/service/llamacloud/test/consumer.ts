/**
 * Ports of our two LlamaCloud consumers, driven by the acceptance tests so "the mock works"
 * means "our consumers' own logic reaches the right outcome":
 *
 * 1. `LlamaCloudKnowledgeAdapter` — `apps/backend/src/modules/chatbot/adapters/
 *    llamacloud-knowledge.adapter.ts` (chat tools `search_health_knowledge` / `search_faq`
 *    and the EMR chatbot-admin knowledge CRUD): the same requests, headers, pipeline
 *    resolution, field fallbacks and "non-2xx is logged and returns null" behaviour. The base
 *    URL is injectable (seam G-L1).
 * 2. `PythonLlamaCloudClient` — the Python chat service's `app/core/rag/llamacloud_client.py`
 *    over the HTTP calls `llama_cloud_services` 0.6.88 makes (read from
 *    the installed wheel, see README "Python chat SDK: verified call sequence"):
 *    `LlamaCloudIndex(name, project_name=…)` → `GET /api/v1/projects?project_name=` then
 *    `GET /api/v1/pipelines?project_id=&pipeline_name=&pipeline_type=MANAGED`;
 *    `.as_retriever(similarity_top_k=)` → `GET /api/v1/pipelines/{id}` then
 *    `GET /api/v1/projects/{project_id}`; `.aretrieve(q)` →
 *    `POST /api/v1/pipelines/{id}/retrieve {query, dense_similarity_top_k}`.
 */
export type Fetch = (request: Request) => Promise<Response>

const DEFAULT_TOP_K = 5
const DEFAULT_PROJECT = "Default"
const DOCUMENT_EXTENSIONS = [".pdf", ".docx", ".doc", ".txt", ".md", ".csv"]

const slugToFileName = (slug: string) => `${slug}.md`

const stripExtension = (name: string): string => {
  const lower = name.toLowerCase()
  for (const ext of DOCUMENT_EXTENSIONS) {
    if (lower.endsWith(ext)) return name.slice(0, -ext.length)
  }
  return name
}

type LlamaCloudPipeline = { id: string; name: string; project_id: string }

type LlamaCloudDocument = {
  id: string
  metadata?: {
    file_name?: string
    title?: string
    slug?: string
    contentType?: string
    sourceUrl?: string
    updatedAt?: string
  } & Record<string, unknown>
  text?: string
}

export type KnowledgeSearchHit = {
  title: string
  content: string
  score: number
  sourceId: string | undefined
}

export type KnowledgeDocumentSummary = { id: string; fileName: string; sizeChars: number }

export type KnowledgeArticle = {
  id: string
  title: string
  content: string
  contentType: "biomarker" | "supplement" | "condition" | "general" | "faq"
  sourceUrl: string | null
  updatedAt: string
}

const VALID_CONTENT_TYPES: readonly string[] = [
  "biomarker",
  "supplement",
  "condition",
  "general",
  "faq",
]

const isValidContentType = (value: unknown): value is KnowledgeArticle["contentType"] =>
  typeof value === "string" && VALID_CONTENT_TYPES.includes(value)

const stripTitleHeader = (text: string, title: string): string => {
  const expected = `# ${title}\n\n`
  return text.startsWith(expected) ? text.slice(expected.length) : text
}

export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)

type LlamaCloudRetrieveResponse = {
  retrieval_nodes?: Array<{
    score?: number
    node?: {
      text?: string
      metadata?: { file_name?: string; document_id?: string } & Record<string, unknown>
    }
  }>
}

export type AdapterConfig = {
  apiKey: string | null
  indexName: string | null
  projectName?: string
}

/** The backend adapter. `logs` collects what it would log (errors are asserted on). */
export class LlamaCloudKnowledgeAdapter {
  readonly logs: string[] = []
  private readonly apiKey: string | null
  private readonly indexName: string | null
  private readonly projectName: string
  private cachedPipelineId: string | null = null

  constructor(
    private readonly baseUrl: string,
    config: AdapterConfig,
    private readonly send: Fetch,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.apiKey = config.apiKey
    this.indexName = config.indexName
    this.projectName = config.projectName ?? DEFAULT_PROJECT
    if (!this.apiKey || !this.indexName) this.logs.push("warn: LlamaCloud not configured")
  }

  async search(query: string, topK = DEFAULT_TOP_K): Promise<KnowledgeSearchHit[]> {
    const pipelineId = await this.resolvePipelineId()
    if (!pipelineId) return []
    const response = await this.fetch<LlamaCloudRetrieveResponse>(
      `/pipelines/${pipelineId}/retrieve`,
      { method: "POST", body: JSON.stringify({ query, dense_similarity_top_k: topK }) },
    )
    const nodes = response?.retrieval_nodes ?? []
    return nodes
      .filter((n) => typeof n.node?.text === "string")
      .map((n) => {
        const fileName = n.node?.metadata?.file_name
        return {
          title: fileName ? stripExtension(fileName) : "Knowledge Article",
          content: n.node?.text as string,
          score: typeof n.score === "number" ? n.score : 0,
          sourceId: (n.node?.metadata?.document_id as string | undefined) ?? undefined,
        }
      })
  }

  async listDocuments(): Promise<KnowledgeDocumentSummary[]> {
    const pipelineId = await this.resolvePipelineId()
    if (!pipelineId) return []
    const docs = await this.fetch<LlamaCloudDocument[]>(`/pipelines/${pipelineId}/documents`)
    if (!Array.isArray(docs)) return []
    return docs.map((d) => ({
      id: d.id,
      fileName: d.metadata?.file_name ?? d.id,
      sizeChars: typeof d.text === "string" ? d.text.length : 0,
    }))
  }

  async upsertMarkdown(slug: string, title: string, body: string): Promise<string> {
    const pipelineId = await this.resolvePipelineId()
    if (!pipelineId) throw new Error("llamacloud_not_configured")
    const text = `# ${title}\n\n${body}`.trim()
    await this.fetch(`/pipelines/${pipelineId}/documents`, {
      method: "PUT",
      body: JSON.stringify([
        { id: slug, text, metadata: { file_name: slugToFileName(slug), title, slug } },
      ]),
    })
    return slug
  }

  async deleteDocument(documentId: string): Promise<void> {
    const pipelineId = await this.resolvePipelineId()
    if (!pipelineId) return
    await this.fetch(`/pipelines/${pipelineId}/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
    })
  }

  async listArticles(filterContentType?: string): Promise<KnowledgeArticle[]> {
    const pipelineId = await this.resolvePipelineId()
    if (!pipelineId) return []
    const docs = await this.fetch<LlamaCloudDocument[]>(`/pipelines/${pipelineId}/documents`)
    if (!Array.isArray(docs)) return []
    const articles = docs.map((d) => this.toArticle(d))
    return filterContentType
      ? articles.filter((a) => a.contentType === filterContentType)
      : articles
  }

  async getArticle(id: string): Promise<KnowledgeArticle | null> {
    const pipelineId = await this.resolvePipelineId()
    if (!pipelineId) return null
    const docs = await this.fetch<LlamaCloudDocument[]>(`/pipelines/${pipelineId}/documents`)
    if (!Array.isArray(docs)) return null
    const match = docs.find((d) => d.id === id)
    return match ? this.toArticle(match) : null
  }

  async createArticle(
    input: Omit<KnowledgeArticle, "id" | "updatedAt">,
  ): Promise<KnowledgeArticle> {
    const id = slugify(input.title) || `article-${this.clock()}`
    return this.upsertArticle(id, input)
  }

  async updateArticle(
    id: string,
    input: Partial<Omit<KnowledgeArticle, "id" | "updatedAt">>,
  ): Promise<KnowledgeArticle> {
    const existing = await this.getArticle(id)
    if (!existing) throw new Error("article_not_found")
    return this.upsertArticle(id, {
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      contentType: input.contentType ?? existing.contentType,
      sourceUrl: input.sourceUrl !== undefined ? input.sourceUrl : existing.sourceUrl,
    })
  }

  private async upsertArticle(
    id: string,
    input: Omit<KnowledgeArticle, "id" | "updatedAt">,
  ): Promise<KnowledgeArticle> {
    const pipelineId = await this.resolvePipelineId()
    if (!pipelineId) throw new Error("llamacloud_not_configured")
    const updatedAt = new Date(this.clock()).toISOString()
    const text = `# ${input.title}\n\n${input.content}`.trim()
    await this.fetch(`/pipelines/${pipelineId}/documents`, {
      method: "PUT",
      body: JSON.stringify([
        {
          id,
          text,
          metadata: {
            file_name: `${id}.md`,
            slug: id,
            title: input.title,
            contentType: input.contentType,
            sourceUrl: input.sourceUrl ?? null,
            updatedAt,
          },
        },
      ]),
    })
    return { id, ...input, updatedAt }
  }

  private toArticle(doc: LlamaCloudDocument): KnowledgeArticle {
    const metaTitle = (doc.metadata?.title as string | undefined) ?? null
    const fileName = doc.metadata?.file_name ?? doc.id
    const title = metaTitle ?? fileName.replace(/\.md$/, "")
    const rawText = typeof doc.text === "string" ? doc.text : ""
    const contentTypeRaw = doc.metadata?.contentType
    return {
      id: doc.id,
      title,
      content: stripTitleHeader(rawText, title),
      contentType: isValidContentType(contentTypeRaw) ? contentTypeRaw : "general",
      sourceUrl: (doc.metadata?.sourceUrl as string | null | undefined) ?? null,
      updatedAt: (doc.metadata?.updatedAt as string | undefined) ?? new Date(0).toISOString(),
    }
  }

  async resolvePipelineId(): Promise<string | null> {
    if (this.cachedPipelineId) return this.cachedPipelineId
    if (!this.apiKey || !this.indexName) return null
    const pipelines = await this.fetch<LlamaCloudPipeline[]>(
      `/pipelines?project_name=${encodeURIComponent(this.projectName)}`,
    )
    if (!Array.isArray(pipelines)) {
      this.logs.push("error: LlamaCloud /pipelines returned unexpected shape")
      return null
    }
    const match = pipelines.find((p) => p.name === this.indexName)
    if (!match) {
      this.logs.push(
        `error: LlamaCloud pipeline "${this.indexName}" not found in project "${this.projectName}"`,
      )
      return null
    }
    this.cachedPipelineId = match.id
    return match.id
  }

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    if (!this.apiKey) return null
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    }
    const response = await this.send(new Request(`${this.baseUrl}${path}`, { ...init, headers }))
    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable>")
      this.logs.push(
        `error: LlamaCloud ${init.method ?? "GET"} ${path} returned ${response.status}: ${body.slice(0, 500)}`,
      )
      return null
    }
    if (response.status === 204) return null
    return (await response.json()) as T
  }
}

/** A retrieved source as the Python chat client builds it (`RAGSource`). */
export type RAGSource = {
  content: string
  score: number
  metadata: Record<string, unknown>
  source_id: string | null
  title: string | null
  url: string | null
}

export type RAGResult = { query: string; sources: RAGSource[]; total_retrieved: number }

type SdkProject = { id: string; name: string; organization_id: string }
type SdkPipeline = { id: string; name: string; project_id: string; embedding_config: unknown }

/**
 * `LlamaCloudClient` from the Python chat service over `llama_cloud_services`' wire calls.
 * Initialization failures (no project, unknown index, non-2xx) degrade to empty results, as
 * the Python client's `try/except` does. `base_url` is `LLAMA_CLOUD_BASE_URL`.
 */
export class PythonLlamaCloudClient {
  readonly calls: string[] = []
  initializationError: string | null = null
  private pipeline: SdkPipeline | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly config: {
      indexName: string
      apiKey: string
      projectName?: string
      denseTopK?: number
    },
    private readonly send: Fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push(`${method} ${path.split("?")[0]}`)
    const response = await this.send(
      new Request(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "X-Fern-Language": "Python",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`ApiError: status_code: ${response.status}, body: ${await response.text()}`)
    }
    return (await response.json()) as T
  }

  /** `resolve_project_and_pipeline` by name, then the retriever's re-resolution by id. */
  async initialize(): Promise<boolean> {
    if (this.pipeline) return true
    try {
      const projectName = this.config.projectName ?? "default"
      const projects = await this.call<SdkProject[]>(
        "GET",
        `/api/v1/projects?project_name=${encodeURIComponent(projectName)}`,
      )
      if (projects.length === 0) throw new Error(`No project found with name ${projectName}`)
      if (projects.length > 1) throw new Error(`Multiple projects found with name ${projectName}`)
      const project = projects[0] as SdkProject
      const pipelines = await this.call<SdkPipeline[]>(
        "GET",
        `/api/v1/pipelines?project_id=${project.id}&pipeline_name=${encodeURIComponent(this.config.indexName)}&pipeline_type=MANAGED`,
      )
      if (pipelines.length === 0) throw new Error(`Unknown index name ${this.config.indexName}`)
      if (pipelines.length > 1) throw new Error(`Multiple pipelines found`)
      const resolved = pipelines[0] as SdkPipeline
      // as_retriever(): LlamaCloudRetriever(project_id=…, pipeline_id=…) resolves both again.
      const byId = await this.call<SdkPipeline>("GET", `/api/v1/pipelines/${resolved.id}`)
      await this.call<SdkProject>("GET", `/api/v1/projects/${byId.project_id}`)
      if (typeof byId.embedding_config !== "object") throw new Error("pipeline validation failed")
      this.pipeline = byId
      this.initializationError = null
      return true
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  async retrieve(query: string): Promise<RAGResult> {
    if (!(await this.initialize()) || !this.pipeline) {
      return { query, sources: [], total_retrieved: 0 }
    }
    try {
      const results = await this.call<{
        retrieval_nodes: {
          node: { id_?: string; text?: string; metadata?: Record<string, unknown> }
          score?: number | null
        }[]
        metadata?: Record<string, string>
      }>("POST", `/api/v1/pipelines/${this.pipeline.id}/retrieve`, {
        query,
        dense_similarity_top_k: this.config.denseTopK ?? 5,
      })
      const sources = results.retrieval_nodes.map((res) => {
        const metadata = { ...(res.node.metadata ?? {}), ...(results.metadata ?? {}) }
        return {
          content: res.node.text ?? "",
          score: Number(res.score ?? 0),
          metadata,
          source_id: res.node.id_ ?? null,
          title: (metadata.title as string | undefined) || (metadata.file_name as string) || null,
          url: (metadata.url as string | undefined) || (metadata.source as string) || null,
        }
      })
      return { query, sources, total_retrieved: sources.length }
    } catch {
      return { query, sources: [], total_retrieved: 0 }
    }
  }
}
