import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { execute, type GraphQLError, parse, validate } from "graphql"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type GraphContext, type HealthieEvent, HealthieGraph } from "./graph.js"
import { healthieSchema, Upload } from "./schema.js"
import { HealthieState, type Settings, type UserRecord } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { HealthieEvent } from "./graph.js"
export { parseShareUsers } from "./graph.js"
export { HEALTHIE_SDL, healthieSchema, Upload } from "./schema.js"
export type {
  BillingItemRecord,
  DocumentRecord,
  FolderRecord,
  FormAnswerGroupRecord,
  LocationRecord,
  OfferingRecord,
  RequestedFormRecord,
  Settings,
  UserRecord,
} from "./state.js"
export { DEFAULT_SETTINGS, SEED } from "./state.js"

export const HEALTHIE_NAMESPACE = "healthie"

/** Healthie's error message for an unknown key (our consumer maps it to 401). */
export const INVALID_API_KEY = "API Key is Invalid"

export type HealthieAPIOptions = APIOptions & {
  /** Initial per-namespace settings (org API keys, sign-in namespace, URL lifetime). */
  settings?: Partial<Settings>
  /** The public namespace name, so file URLs carry `/ns/<name>` when it is not the default. */
  publicNamespace?: string
  /** Called for every event Healthie would post to a webhook; the runtime delivers it. */
  onEvent?: (event: HealthieEvent) => void
}

/** `YYYY-MM-DD HH:MM:SS +0000`: how Healthie formats `created_at` / `updated_at`. */
export const healthieTimestamp = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} +0000`

/** The API key an `Authorization` header carries: `Bearer <k>`, `Basic <k>` or the bare key. */
export const apiKeyOf = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")?.trim()
  if (!header) return undefined
  const match = /^(?:Bearer|Basic)\s+(.+)$/i.exec(header)
  const key = (match ? match[1] : header)?.trim()
  return key ? key : undefined
}

type GraphqlRequest = {
  query: string
  variables: Record<string, unknown>
  operationName: string | undefined
}

const graphqlError = (status: number, message: string) => jsonRes(status, { errors: [{ message }] })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Put `value` at a `variables.a.b.0` path (the GraphQL multipart request spec's `map`). */
const setPath = (target: Record<string, unknown>, path: string, value: unknown): boolean => {
  const segments = path.split(".")
  let cursor: unknown = target
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    if (Array.isArray(cursor)) {
      const at = Number(segment)
      if (!Number.isInteger(at)) return false
      if (last) cursor[at] = value
      else cursor = cursor[at]
    } else if (isRecord(cursor)) {
      if (last) cursor[segment] = value
      else {
        if (cursor[segment] === undefined || cursor[segment] === null) cursor[segment] = {}
        cursor = cursor[segment]
      }
    } else return false
  }
  return true
}

/**
 * Stateful mock of the Healthie GraphQL API (legacy surface).
 *
 * `POST /graphql` executes any document valid against the subset schema (see `HEALTHIE_SDL`)
 * with the reference `graphql` implementation, so selection sets, aliases (two
 * `updateBillingItem`s in one document), fragments, `__typename` and validation errors behave
 * as on Healthie. `Upload` variables arrive through the GraphQL multipart request spec, and the
 * bytes are served back from `document.expiring_url` / `user.avatar_url`.
 */
export class HealthieAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: HealthieState
  private readonly service: Service
  private readonly now: () => number
  private readonly publicNamespace: string | undefined
  private readonly onEvent: ((event: HealthieEvent) => void) | undefined
  private readonly storageNamespace: string

  constructor(options: HealthieAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? HEALTHIE_NAMESPACE
    this.storageNamespace = namespace
    this.now = options.now ?? (() => Date.now())
    this.publicNamespace = options.publicNamespace
    this.onEvent = options.onEvent
    this.state = new HealthieState(sqlite, namespace, {
      settings: options.settings ?? {},
      timestamp: () => healthieTimestamp(this.now()),
    })
    const handlers = defineOperations<SupportedOperationId>({
      Graphql: (context) => this.graphql(context),
      DownloadFile: (context) => this.download(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => new Response("Not Found", { status: 404 }),
      onError: (error) => {
        throw error
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

  /** The user behind an API key (org keys resolve to the org admin). */
  userForKey(key: string): UserRecord | undefined {
    return this.state.userForKey(key)
  }

  /** Publish a Healthie webhook event (admin routes and mutations call this). */
  emit(event: HealthieEvent): void {
    this.onEvent?.(event)
  }

  private fileSignature(fileId: string, expires: number): string {
    return opaqueToken(`healthie-file:${this.storageNamespace}:${fileId}:${expires}`, 32)
  }

  /** A signed, expiring download URL for a stored file, on the request's own origin. */
  fileUrl(origin: string, fileId: string, expiredAlready = false): string {
    const ttl = this.state.current().expiringUrlSeconds
    const expires = Math.floor(this.now() / 1000) + (expiredAlready ? -1 : ttl)
    const prefix =
      this.publicNamespace && this.publicNamespace !== "default"
        ? `/ns/${encodeURIComponent(this.publicNamespace)}`
        : ""
    return `${origin}${prefix}/files/${fileId}.${expires}.${this.fileSignature(fileId, expires)}`
  }

  private async readRequest(context: OperationContext): Promise<GraphqlRequest | string> {
    const body = context.body
    let raw: unknown
    const uploads: { path: string; upload: Upload }[] = []
    if (body.kind === "json") raw = body.value
    else if (
      body.kind === "bytes" &&
      (context.request.headers.get("content-type") ?? "").startsWith("multipart/form-data")
    ) {
      let form: FormData
      try {
        form = await new Response(body.value as BodyInit, {
          headers: { "content-type": context.request.headers.get("content-type") as string },
        }).formData()
      } catch {
        return "Invalid multipart request"
      }
      try {
        raw = JSON.parse(String(form.get("operations") ?? ""))
        const map = JSON.parse(String(form.get("map") ?? "{}")) as Record<string, string[]>
        for (const [part, paths] of Object.entries(map)) {
          const file = form.get(part)
          if (!(file instanceof Blob)) return `Missing file part ${part}`
          const upload = new Upload(
            file instanceof File ? file.name : part,
            file.type || "application/octet-stream",
            new Uint8Array(await file.arrayBuffer()),
          )
          for (const path of paths) uploads.push({ path, upload })
        }
      } catch {
        return "Invalid multipart request: operations and map must be JSON"
      }
    } else if (body.kind === "invalid") return "Invalid JSON body"
    else return "No query string was present"
    if (!isRecord(raw)) return "No query string was present"
    if (typeof raw.query !== "string" || raw.query.trim() === "") {
      return "No query string was present"
    }
    const request = {
      query: raw.query,
      variables: isRecord(raw.variables) ? { ...raw.variables } : {},
      operationName: typeof raw.operationName === "string" ? raw.operationName : undefined,
    }
    const holder: Record<string, unknown> = { variables: request.variables }
    for (const { path, upload } of uploads) {
      if (!setPath(holder, path, upload)) return `Cannot map a file to ${path}`
    }
    return request
  }

  private async graphql(context: OperationContext): Promise<Response> {
    const parsed = await this.readRequest(context)
    if (typeof parsed === "string") return graphqlError(400, parsed)
    const key = apiKeyOf(context.request)
    const effect = (name: string) => faultEffect(context.request, name) !== undefined
    if (effect("graphql_500")) return graphqlError(200, "Internal Server Error (500)")
    let viewer: UserRecord | undefined
    if (key !== undefined) {
      viewer = effect("invalid_api_key") ? undefined : this.state.userForKey(key)
      if (!viewer) return graphqlError(200, INVALID_API_KEY)
    }
    let documentAst: ReturnType<typeof parse>
    try {
      documentAst = parse(parsed.query)
    } catch (error) {
      return jsonRes(200, { errors: [(error as GraphQLError).toJSON()] })
    }
    const schema = healthieSchema()
    const invalid = validate(schema, documentAst)
    if (invalid.length > 0) return jsonRes(200, { errors: invalid.map((e) => e.toJSON()) })
    const origin = new URL(context.request.url).origin
    const touched: Record<string, string> = {}
    const expired = effect("expired_urls")
    const graphContext: GraphContext = {
      state: this.state,
      viewer,
      timestamp: () => healthieTimestamp(this.now()),
      fileUrl: (fileId) => this.fileUrl(origin, fileId, expired),
      emit: (event) => this.emit(event),
      touched,
      effects: {
        currentUserNull: effect("current_user_null"),
        validationMessages: effect("validation_messages"),
      },
    }
    const graph = new HealthieGraph(graphContext)
    const result = await execute({
      schema,
      document: documentAst,
      rootValue: { ...graph.root(), ...graph.mutations() },
      variableValues: parsed.variables,
      ...(parsed.operationName !== undefined ? { operationName: parsed.operationName } : {}),
    })
    const operation = documentAst.definitions.find(
      (d) =>
        d.kind === "OperationDefinition" &&
        (!parsed.operationName || d.name?.value === parsed.operationName),
    )
    const ids: Record<string, string> = { ...touched }
    if (operation?.kind === "OperationDefinition") {
      ids.operation = `${operation.operation}${operation.name ? ` ${operation.name.value}` : ""}`
    }
    if (viewer) ids.viewerId = viewer.id
    const body: Record<string, unknown> = {}
    if (result.errors && result.errors.length > 0)
      body.errors = result.errors.map((e) => e.toJSON())
    body.data = result.data ?? null
    return annotateResponse(jsonRes(200, body), { ids })
  }

  private download(context: OperationContext): Response {
    const token = context.params.fileToken ?? ""
    const [fileId, expiresText, signature] = token.split(".")
    const expires = Number(expiresText)
    if (
      !fileId ||
      !Number.isInteger(expires) ||
      signature !== this.fileSignature(fileId, expires)
    ) {
      return new Response("AccessDenied: Request signature does not match", {
        status: 403,
        headers: { "content-type": "text/plain" },
      })
    }
    if (Math.floor(this.now() / 1000) > expires || faultEffect(context.request, "expired_urls")) {
      return new Response("AccessDenied: Request has expired", {
        status: 403,
        headers: { "content-type": "text/plain" },
      })
    }
    const file = this.state.files.get(fileId)
    if (!file) {
      return new Response("NoSuchKey: The specified key does not exist.", {
        status: 404,
        headers: { "content-type": "text/plain" },
      })
    }
    const doc = this.state.documents.list({ where: (d) => d.file_id === fileId }).at(0)?.value
    if (doc) this.state.documents.update(doc.id, { ...doc, opens: doc.opens + 1 })
    return annotateResponse(
      new Response(fromBase64(file.base64) as BodyInit, {
        status: 200,
        headers: {
          "content-type": file.content_type,
          "content-length": String(file.size),
          "content-disposition": `inline; filename="${file.filename.replace(/"/g, "")}"`,
        },
      }),
      { ids: doc ? { documentId: doc.id, fileId } : { fileId } },
    )
  }
}

export type { HealthieRuntime, HealthieRuntimeOptions } from "./runtime.js"
export {
  createRuntime,
  DEFAULT_WEBHOOK_IP,
  HEALTHIE_EVENT_ROUTES,
  HEALTHIE_PRESETS,
  healthieEndpoints,
} from "./runtime.js"
