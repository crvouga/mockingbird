/**
 * A port of our backend's Plane client (`apps/backend/src/modules/bug-reports/adapters/
 * plane-http-client.ts`, `native-fetch-plane.adapter.ts`, `plane-response.ts`): the same URLs,
 * `X-API-Key` header, query parameters, retry policy (GETs only, at 0 / 2 / 8 s on 429, 5xx and
 * network failures; writes never retried), error messages, and response parsing (the zod
 * schemas are hand-ported: uuids, a non-negative integer `sequence_id`, an offset datetime
 * `created_at`, cursor envelopes or bare arrays). The only change is the base URL: the app
 * hardcodes `https://api.plane.so` (seam G-Y1).
 */
export type PlaneState = { id: string; name: string; group: string }
export type PlaneLabel = { id: string; name: string }
export type PlaneWorkItem = {
  id: string
  sequenceId: number
  name: string
  descriptionHtml: string
  stateId: string
  labelIds: string[]
  expandedLabels: PlaneLabel[]
  createdAt: Date
}
export type PlaneFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

const PLANE_REQUEST_TIMEOUT_MS = 10_000
export const PLANE_RETRY_DELAYS_MS = [0, 2_000, 8_000] as const
const PLANE_ERROR_DETAIL_LENGTH = 500
const PLANE_PAGE_SIZE = 100
const PLANE_MAX_PAGES = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OFFSET_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

class ParseError extends Error {}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const uuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !UUID.test(value.trim()))
    throw new ParseError(`${field}: invalid uuid`)
  return value.trim()
}
const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new ParseError(`${field}: required`)
  return value.trim()
}

export const parsePlaneState = (value: unknown): PlaneState => {
  if (!isRecord(value)) throw new ParseError("state: expected object")
  return {
    id: uuid(value.id, "id"),
    name: nonEmpty(value.name, "name"),
    group: nonEmpty(value.group, "group"),
  }
}

export const parsePlaneLabel = (value: unknown): PlaneLabel => {
  if (!isRecord(value)) throw new ParseError("label: expected object")
  return { id: uuid(value.id, "id"), name: nonEmpty(value.name, "name") }
}

export const parsePlaneWorkItem = (value: unknown): PlaneWorkItem => {
  if (!isRecord(value)) throw new ParseError("work item: expected object")
  const sequence = value.sequence_id
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) {
    throw new ParseError("sequence_id: expected a non-negative integer")
  }
  if (value.description_html != null && typeof value.description_html !== "string") {
    throw new ParseError("description_html: expected string")
  }
  const state =
    typeof value.state === "string" ? uuid(value.state, "state") : parsePlaneState(value.state).id
  const labels = (value.labels ?? []) as unknown[]
  if (!Array.isArray(labels)) throw new ParseError("labels: expected array")
  const parsedLabels = labels.map((label) =>
    typeof label === "string" ? uuid(label, "labels[]") : parsePlaneLabel(label),
  )
  if (typeof value.created_at !== "string" || !OFFSET_DATETIME.test(value.created_at)) {
    throw new ParseError("created_at: expected an offset datetime")
  }
  return {
    id: uuid(value.id, "id"),
    sequenceId: sequence,
    name: nonEmpty(value.name, "name"),
    descriptionHtml: (value.description_html as string | null | undefined) ?? "",
    stateId: state,
    labelIds: parsedLabels.map((label) => (typeof label === "string" ? label : label.id)),
    expandedLabels: parsedLabels.filter((l): l is PlaneLabel => typeof l !== "string"),
    createdAt: new Date(value.created_at),
  }
}

export const parsePlaneComment = (value: unknown) => {
  if (!isRecord(value) || typeof value.comment_html !== "string") throw new ParseError("comment")
  return { id: uuid(value.id, "id"), commentHtml: value.comment_html }
}

export const parsePlaneLink = (value: unknown) => {
  if (!isRecord(value) || typeof value.url !== "string") throw new ParseError("link")
  new URL(value.url)
  if (value.title != null && typeof value.title !== "string") throw new ParseError("title")
  return { id: uuid(value.id, "id"), url: value.url, title: (value.title as string | null) ?? null }
}

type ParsedPlanePage<T> = {
  results: T[]
  nextCursor: string | null
  nextPageResults: boolean | undefined
  totalCount: number | null
}

export const parsePlanePage = <T>(
  value: unknown,
  parseItem: (item: unknown) => T,
): ParsedPlanePage<T> => {
  if (Array.isArray(value)) {
    return {
      results: value.map(parseItem),
      nextCursor: null,
      nextPageResults: false,
      totalCount: value.length,
    }
  }
  if (!isRecord(value) || !Array.isArray(value.results))
    throw new ParseError("page: expected results")
  const cursor = typeof value.next_cursor === "string" ? value.next_cursor : null
  return {
    results: value.results.map(parseItem),
    nextCursor: cursor?.trim() || null,
    nextPageResults:
      typeof value.next_page_results === "boolean" ? value.next_page_results : undefined,
    totalCount:
      (typeof value.total_count === "number" ? value.total_count : undefined) ??
      (typeof value.total_results === "number" ? value.total_results : undefined) ??
      null,
  }
}

export type PlaneConnection = { accessToken: string; workspaceSlug: string; projectId: string }

type PlaneRequestOptions = {
  method: "GET" | "POST" | "PATCH"
  path: string
  query?: Record<string, string>
  body?: unknown
}

const isTransientStatus = (status: number) => status === 429 || status >= 500

/** `PlaneHttpClient`, with the base URL injected. */
export class PlaneHttpClient {
  readonly warnings: string[] = []

  constructor(
    private readonly baseUrl: string,
    private readonly connection: PlaneConnection,
    private readonly fetchImpl: PlaneFetch,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async requestJson(options: PlaneRequestOptions): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${options.path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    const maximumAttempts = options.method === "GET" ? PLANE_RETRY_DELAYS_MS.length : 1
    const retrySuffix = maximumAttempts > 1 ? " after retries" : ""
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const retryDelay = PLANE_RETRY_DELAYS_MS[attempt]
      if (retryDelay === undefined) break
      if (retryDelay > 0) await this.sleep(retryDelay)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), PLANE_REQUEST_TIMEOUT_MS)
      let response: Response
      let responseText: string
      try {
        response = await this.fetchImpl(url, {
          method: options.method,
          headers: {
            Accept: "application/json",
            "X-API-Key": this.connection.accessToken,
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        })
        responseText = await response.text()
      } catch (error: unknown) {
        if (attempt === maximumAttempts - 1) {
          throw new Error(
            `Plane ${options.method} ${options.path} failed${retrySuffix}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        this.warnings.push(
          `Plane ${options.method} ${options.path} network failure on attempt ${attempt + 1}`,
        )
        continue
      } finally {
        clearTimeout(timeout)
      }
      if (isTransientStatus(response.status)) {
        if (attempt === maximumAttempts - 1) {
          throw new Error(
            `Plane ${options.method} ${options.path} failed with HTTP ${response.status}${retrySuffix}`,
          )
        }
        this.warnings.push(
          `Plane ${options.method} ${options.path} returned transient HTTP ${response.status} on attempt ${attempt + 1}`,
        )
        continue
      }
      if (!response.ok) {
        const detail = responseText.trim().slice(0, PLANE_ERROR_DETAIL_LENGTH)
        throw new Error(
          `Plane ${options.method} ${options.path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        )
      }
      if (!responseText.trim()) return null
      try {
        return JSON.parse(responseText) as unknown
      } catch (error: unknown) {
        throw new Error(
          `Plane ${options.method} ${options.path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    throw new Error(`Plane ${options.method} ${options.path} exhausted its retry budget`)
  }
}

/** `NativeFetchPlaneAdapter`: the PlanePort our bug-report services call. */
export class PlaneConsumer {
  readonly http: PlaneHttpClient

  constructor(
    baseUrl: string,
    private readonly connection: PlaneConnection,
    fetchImpl: PlaneFetch,
    sleep: (ms: number) => Promise<void> = async () => {},
  ) {
    this.http = new PlaneHttpClient(baseUrl, connection, fetchImpl, sleep)
  }

  private get projectBasePath() {
    return `/api/v1/workspaces/${encodeURIComponent(this.connection.workspaceSlug)}/projects/${encodeURIComponent(this.connection.projectId)}`
  }

  async listWorkItems(options: { cursor?: string; perPage?: number; orderBy?: string } = {}) {
    const perPage = options.perPage ?? PLANE_PAGE_SIZE
    const page = parsePlanePage(
      await this.http.requestJson({
        method: "GET",
        path: `${this.projectBasePath}/work-items/`,
        query: {
          per_page: String(perPage),
          order_by: options.orderBy ?? "-created_at",
          ...(options.cursor ? { cursor: options.cursor } : {}),
        },
      }),
      parsePlaneWorkItem,
    )
    if (page.nextPageResults === true && page.nextCursor === null) {
      throw new Error("Plane work-item pagination indicated another page without a cursor")
    }
    return {
      results: page.results,
      nextCursor: page.nextPageResults === false ? null : page.nextCursor,
      totalCount: page.totalCount,
    }
  }

  async getWorkItem(workItemId: string) {
    const id = uuid(workItemId, "workItemId")
    return parsePlaneWorkItem(
      await this.http.requestJson({
        method: "GET",
        path: `${this.projectBasePath}/work-items/${encodeURIComponent(id)}/`,
      }),
    )
  }

  async createWorkItem(input: {
    name: string
    descriptionHtml?: string
    stateId?: string
    labelIds?: string[]
  }) {
    return parsePlaneWorkItem(
      await this.http.requestJson({
        method: "POST",
        path: `${this.projectBasePath}/work-items/`,
        body: {
          name: nonEmpty(input.name, "name"),
          ...(input.descriptionHtml === undefined
            ? {}
            : { description_html: input.descriptionHtml }),
          ...(input.stateId === undefined ? {} : { state: uuid(input.stateId, "stateId") }),
          ...(input.labelIds === undefined
            ? {}
            : { labels: input.labelIds.map((l) => uuid(l, "labelIds[]")) }),
        },
      }),
    )
  }

  async patchWorkItemState(workItemId: string, stateId: string) {
    return this.patchWorkItem(uuid(workItemId, "workItemId"), { state: uuid(stateId, "stateId") })
  }

  async createComment(workItemId: string, commentHtml: string) {
    const id = uuid(workItemId, "workItemId")
    return parsePlaneComment(
      await this.http.requestJson({
        method: "POST",
        path: `${this.projectBasePath}/work-items/${encodeURIComponent(id)}/comments/`,
        body: { comment_html: nonEmpty(commentHtml, "commentHtml") },
      }),
    )
  }

  async listStates() {
    return this.listAll(`${this.projectBasePath}/states/`, parsePlaneState)
  }

  async listLabels() {
    return this.listAll(`${this.projectBasePath}/labels/`, parsePlaneLabel)
  }

  async createLabel(name: string) {
    return parsePlaneLabel(
      await this.http.requestJson({
        method: "POST",
        path: `${this.projectBasePath}/labels/`,
        body: { name: nonEmpty(name, "name") },
      }),
    )
  }

  async addLabelsToWorkItem(workItemId: string, labelIds: string[]) {
    const id = uuid(workItemId, "workItemId")
    if (labelIds.length === 0) throw new ParseError("labelIds: at least one")
    const parsed = labelIds.map((l) => uuid(l, "labelIds[]"))
    const workItem = await this.getWorkItem(id)
    const merged = [...new Set([...workItem.labelIds, ...parsed])]
    if (merged.length === workItem.labelIds.length) return workItem
    return this.patchWorkItem(id, { labels: merged })
  }

  async createWorkItemLink(workItemId: string, input: { url: string; title?: string }) {
    const id = uuid(workItemId, "workItemId")
    new URL(input.url)
    return parsePlaneLink(
      await this.http.requestJson({
        method: "POST",
        path: `${this.projectBasePath}/work-items/${encodeURIComponent(id)}/links/`,
        body: input,
      }),
    )
  }

  private async patchWorkItem(workItemId: string, patch: { state?: string; labels?: string[] }) {
    return parsePlaneWorkItem(
      await this.http.requestJson({
        method: "PATCH",
        path: `${this.projectBasePath}/work-items/${encodeURIComponent(workItemId)}/`,
        body: patch,
      }),
    )
  }

  private async listAll<T>(path: string, parseItem: (value: unknown) => T): Promise<T[]> {
    const results: T[] = []
    let cursor: string | null = null
    const seenCursors = new Set<string>()
    for (let pageNumber = 0; pageNumber < PLANE_MAX_PAGES; pageNumber++) {
      const page: ParsedPlanePage<T> = parsePlanePage(
        await this.http.requestJson({
          method: "GET",
          path,
          query: { per_page: String(PLANE_PAGE_SIZE), ...(cursor ? { cursor } : {}) },
        }),
        parseItem,
      )
      results.push(...page.results)
      if (page.nextPageResults === false) return results
      if (page.nextCursor) {
        if (seenCursors.has(page.nextCursor))
          throw new Error(`Plane pagination repeated cursor for ${path}`)
        seenCursors.add(page.nextCursor)
        cursor = page.nextCursor
        continue
      }
      if (page.nextPageResults === true) {
        throw new Error(`Plane pagination indicated another page without a cursor for ${path}`)
      }
      return results
    }
    throw new Error(`Plane pagination exceeded ${PLANE_MAX_PAGES} pages for ${path}`)
  }
}
