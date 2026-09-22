import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
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
import {
  FormbricksState,
  PROD_CLONE_SURVEYS,
  PROJECT,
  type ResponseRecord,
  type Settings,
  type Survey,
} from "./state.js"
import { validateResponseData } from "./validation.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { ResponseRecord, Settings, Survey } from "./state.js"
export {
  DEFAULT_SETTINGS,
  DEVELOPMENT_ENVIRONMENT_ID,
  PROD_CLONE_EXPORTED_AT,
  PROD_CLONE_SURVEYS,
  PRODUCTION_ENVIRONMENT_ID,
} from "./state.js"
export { validateResponseData } from "./validation.js"

export const FORMBRICKS_NAMESPACE = "formbricks"

/** The response as the API (and the webhook) renders it: `TResponse`. */
export type ApiResponse = Omit<ResponseRecord, "environmentId">

/** The body Formbricks' pipeline posts to a webhook (`app/api/(internal)/pipeline/route.ts`). */
export type FormbricksWebhook = {
  webhookId: string
  event: "responseCreated" | "responseFinished"
  data: ApiResponse & {
    survey: {
      title: string
      type: string
      status: string
      createdAt: string | null
      updatedAt: string | null
    }
  }
}

export type FormbricksAPIOptions = APIOptions & {
  /** Surveys every namespace starts with. Default: our production clone. */
  surveys?: readonly Survey[]
  settings?: Partial<Settings>
  /** Called for every pipeline event; the runtime signs and delivers it. */
  onWebhook?: (event: FormbricksWebhook) => void
}

type ErrorCode =
  | "not_found"
  | "bad_request"
  | "internal_server_error"
  | "not_authenticated"
  | "forbidden"
  | "too_many_requests"

/** The fork's error envelope (`app/lib/api/response.ts`), with its CORS/no-store headers. */
export const formbricksError = (
  status: number,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
) =>
  jsonRes(
    status,
    { code, message, details },
    { "cache-control": "private, no-store", "access-control-allow-origin": "*" },
  )

const CUID2 = /^[0-9a-z]+$/

const zodType = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value

/**
 * `ZResponseInputV2.safeParse` + `transformErrorToDetails`: zod's messages, keyed by path.
 * Unknown keys (and unknown `meta` keys) are stripped, as zod objects do.
 */
const responseInputIssues = (body: Record<string, unknown>): Record<string, string> => {
  const details: Record<string, string> = {}
  const expect = (path: string, value: unknown, type: string, optional = false) => {
    if (value === undefined) {
      if (!optional) details[path] = "Required"
      return false
    }
    if (zodType(value) !== type) {
      details[path] = `Expected ${type}, received ${zodType(value)}`
      return false
    }
    return true
  }
  if (expect("surveyId", body.surveyId, "string") && !CUID2.test(body.surveyId as string)) {
    details.surveyId = "Invalid cuid2"
  }
  expect("finished", body.finished, "boolean")
  if (expect("data", body.data, "object")) {
    for (const [key, value] of Object.entries(body.data as Record<string, unknown>)) {
      const ok =
        typeof value === "string" ||
        typeof value === "number" ||
        (Array.isArray(value) && value.every((v) => typeof v === "string")) ||
        (zodType(value) === "object" &&
          Object.values(value as object).every((v) => typeof v === "string"))
      if (!ok) details[`data.${key}`] = "Invalid input"
    }
  }
  for (const key of ["contactId", "displayId", "singleUseId", "endingId", "recaptchaToken"]) {
    if (body[key] !== undefined && body[key] !== null) expect(key, body[key], "string")
  }
  if (
    body.userId !== undefined &&
    body.userId !== null &&
    expect("userId", body.userId, "string")
  ) {
    if ((body.userId as string).length < 1) {
      details.userId = "String must contain at least 1 character(s)"
    }
  }
  if (body.language !== undefined) expect("language", body.language, "string")
  if (body.variables !== undefined) expect("variables", body.variables, "object")
  if (body.ttc !== undefined) expect("ttc", body.ttc, "object")
  if (body.meta !== undefined && expect("meta", body.meta, "object")) {
    const meta = body.meta as Record<string, unknown>
    for (const key of ["source", "url", "country", "action", "gevitiUserId", "cognitoSub"]) {
      if (meta[key] !== undefined) expect(`meta.${key}`, meta[key], "string")
    }
  }
  return details
}

const WIDGET_SCRIPT = `/* Mockingbird Formbricks widget stub: a no-op window.formbricks. */
(function () {
  var noop = function () { return Promise.resolve(); };
  var api = {
    setup: noop, init: noop, setUserId: noop, setEmail: noop, setAttribute: noop,
    setAttributes: noop, setLanguage: noop, track: noop, logout: noop, reset: noop,
    registerRouteChange: noop
  };
  if (typeof window !== "undefined") { window.formbricks = window.formbricks || api; }
})();
`

/**
 * Stateful mock of Formbricks (our fork): environment state and response creation for the
 * client SDK / member app, the v1 management API, and the `responseFinished` webhook.
 */
export class FormbricksAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: FormbricksState
  private readonly service: Service
  private readonly now: () => number
  private readonly onWebhook: ((event: FormbricksWebhook) => void) | undefined

  constructor(options: FormbricksAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? FORMBRICKS_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.state = new FormbricksState(sqlite, namespace, {
      surveys: options.surveys ?? PROD_CLONE_SURVEYS,
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      GetEnvironmentState: (context) => this.environmentState(context),
      CreateClientResponse: (context) => this.createResponse(context),
      ListResponses: (context) => this.listResponses(context),
      GetResponse: (context) => {
        const record = this.state.responses.get(context.params.responseId ?? "")
        if (!record) {
          return formbricksError(404, "not_found", "Response not found", {
            resource_id: context.params.responseId ?? null,
            resource_type: "Response",
          })
        }
        return jsonRes(200, { data: this.render(record, context) })
      },
      ListSurveys: (context) => {
        const environmentId = context.url.searchParams.get("environmentId")
        const surveys = environmentId
          ? this.state.surveysOf(environmentId)
          : this.state.allSurveys()
        return jsonRes(200, { data: surveys.map((s) => this.wireSurvey(s)) })
      },
      GetSurvey: (context) => {
        const survey = this.state.surveys.get(context.params.surveyId ?? "")
        if (!survey) {
          return formbricksError(404, "not_found", "Survey not found", {
            resource_id: context.params.surveyId ?? null,
            resource_type: "Survey",
          })
        }
        return jsonRes(200, { data: this.wireSurvey(survey) })
      },
      CreateSurvey: (context) => this.createSurvey(context),
      GetWidgetScript: () =>
        new Response(WIDGET_SCRIPT, {
          status: 200,
          headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "public, max-age=3600",
            "access-control-allow-origin": "*",
          },
        }),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => formbricksError(404, "not_found", "Not found", {}),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        if (!context.operation.path.startsWith("/api/v1/management/")) return undefined
        const key = context.request.headers.get("x-api-key")?.trim()
        const keys = this.state.current().apiKeys
        if (!key || (keys.length > 0 && !keys.includes(key))) {
          return formbricksError(401, "not_authenticated", "Not authenticated", {
            "x-Api-Key": "Header not provided or API Key invalid",
          })
        }
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

  /** A survey as the API serves it (no internal `environmentId: null`). */
  private wireSurvey(survey: Survey): Survey {
    const { environmentId, ...rest } = survey
    return environmentId ? { ...rest, environmentId } : (rest as Survey)
  }

  render(record: ResponseRecord, context?: OperationContext): ApiResponse {
    const { environmentId: _environmentId, ...rest } = record
    const asString = context ? faultEffect(context.request, "data_as_string") !== undefined : false
    return asString ? { ...rest, data: JSON.stringify(rest.data) as never } : rest
  }

  private environmentState(context: OperationContext): Response {
    const environmentId = (context.params.environmentId ?? "").trim()
    if (!CUID2.test(environmentId) || environmentId.length < 2) {
      return formbricksError(400, "bad_request", "Invalid environment ID format")
    }
    if (!this.state.knownEnvironment(environmentId)) {
      return formbricksError(404, "not_found", "Environment not found", {
        resource_id: environmentId,
        resource_type: "Environment",
      })
    }
    const surveys = this.state
      .surveysOf(environmentId)
      .filter((s) => s.status === "inProgress")
      .map((s) => {
        const { environmentId: _e, ...wire } = s
        return wire
      })
    return jsonRes(
      200,
      {
        data: {
          data: { surveys, actionClasses: [], project: PROJECT },
          expiresAt: new Date(this.now() + 60 * 60 * 1000).toISOString(),
        },
      },
      {
        "cache-control":
          "public, s-maxage=60, max-age=60, stale-while-revalidate=60, stale-if-error=60",
        "access-control-allow-origin": "*",
      },
    )
  }

  private createResponse(context: OperationContext): Response {
    if (context.body.kind !== "json") {
      return formbricksError(400, "bad_request", "Invalid JSON in request body", {
        error: "request body is not valid JSON",
      })
    }
    const environmentId = context.params.environmentId ?? ""
    if (!CUID2.test(environmentId)) {
      return formbricksError(400, "bad_request", "Fields are missing or incorrectly formatted", {
        environmentId: "Invalid cuid2",
      })
    }
    const body =
      zodType(context.body.value) === "object"
        ? (context.body.value as Record<string, unknown>)
        : {}
    const issues = responseInputIssues(body)
    if (Object.keys(issues).length > 0) {
      return formbricksError(
        400,
        "bad_request",
        "Fields are missing or incorrectly formatted",
        issues,
      )
    }
    if (typeof body.contactId === "string") {
      return formbricksError(
        403,
        "forbidden",
        "User identification is only available for enterprise users.",
      )
    }
    const survey = this.state.surveys.get(body.surveyId as string)
    if (!survey) {
      return formbricksError(404, "not_found", "Survey not found", {
        resource_id: body.surveyId as string,
        resource_type: "Survey",
      })
    }
    if (!this.state.belongsTo(survey, environmentId)) {
      return formbricksError(400, "bad_request", "Survey is part of another environment", {
        "survey.environmentId": survey.environmentId ?? this.state.current().environments[0] ?? "",
        environmentId,
      })
    }
    const data = body.data as Record<string, unknown>
    const finished = body.finished as boolean
    const language = typeof body.language === "string" ? body.language : "en"
    const errors = validateResponseData(survey, data, finished)
    if (errors) {
      const details: Record<string, string> = {}
      for (const [elementId, messages] of Object.entries(errors)) {
        details[`response.data.${elementId}`] = messages.join("; ")
      }
      return formbricksError(400, "bad_request", "Validation failed", details)
    }
    const now = this.iso()
    const meta = (body.meta ?? {}) as Record<string, unknown>
    const userId = typeof body.userId === "string" ? body.userId : null
    const contact =
      userId && this.state.current().contactsEnabled
        ? this.state.contactFor(environmentId, userId)
        : null
    const record: ResponseRecord = {
      id: this.state.nextId(),
      createdAt: now,
      updatedAt: now,
      surveyId: survey.id,
      environmentId,
      displayId: typeof body.displayId === "string" ? body.displayId : null,
      contact,
      contactAttributes: contact ? { userId: contact.userId } : null,
      finished,
      endingId: typeof body.endingId === "string" ? body.endingId : null,
      data,
      variables: (body.variables ?? {}) as Record<string, unknown>,
      ttc: (body.ttc ?? {}) as Record<string, number>,
      tags: [],
      meta: Object.fromEntries(
        ["source", "url", "action", "gevitiUserId", "cognitoSub"]
          .filter((key) => typeof meta[key] === "string")
          .map((key) => [key, meta[key]]),
      ),
      singleUseId: typeof body.singleUseId === "string" ? body.singleUseId : null,
      language,
    }
    this.state.responses.insert(record.id, record)
    this.pipeline("responseCreated", record, survey)
    if (record.finished) this.pipeline("responseFinished", record, survey)
    const ids = { responseId: record.id, surveyId: survey.id }
    if (faultEffect(context.request, "missing_response_id") !== undefined) {
      return annotateResponse(jsonRes(200, { data: { quotaFull: false } }), { ids })
    }
    return annotateResponse(
      jsonRes(
        200,
        { data: { id: record.id, quotaFull: false } },
        { "cache-control": "private, no-store", "access-control-allow-origin": "*" },
      ),
      { ids },
    )
  }

  /** Emit a pipeline event for a stored response (also used by `/__admin/responses/:id/finish`). */
  pipeline(event: FormbricksWebhook["event"], record: ResponseRecord, survey: Survey): void {
    this.onWebhook?.({
      webhookId: this.state.current().webhookId,
      event,
      data: {
        ...this.render(record),
        survey: {
          title: survey.name,
          type: survey.type,
          status: survey.status,
          createdAt: typeof survey.createdAt === "string" ? survey.createdAt : null,
          updatedAt: typeof survey.updatedAt === "string" ? survey.updatedAt : null,
        },
      },
    })
  }

  private listResponses(context: OperationContext): Response {
    const surveyId = context.url.searchParams.get("surveyId")
    const limit = Number(context.url.searchParams.get("limit") ?? "") || undefined
    const skip = Number(context.url.searchParams.get("skip") ?? "") || 0
    const all = this.state.responses
      .list({ order: "newest", where: (r) => surveyId === null || r.surveyId === surveyId })
      .map((row) => row.value)
    const page = all.slice(skip, limit === undefined ? undefined : skip + limit)
    return jsonRes(200, { data: page.map((r) => this.render(r, context)) })
  }

  private createSurvey(context: OperationContext): Response {
    const body =
      context.body.kind === "json" && zodType(context.body.value) === "object"
        ? (context.body.value as Record<string, unknown>)
        : undefined
    if (!body) return formbricksError(400, "bad_request", "Malformed request body")
    const details: Record<string, string> = {}
    if (typeof body.environmentId !== "string" || !CUID2.test(body.environmentId)) {
      details.environmentId = body.environmentId === undefined ? "Required" : "Invalid cuid2"
    }
    if (typeof body.name !== "string" || body.name.length === 0) {
      details.name = body.name === undefined ? "Required" : "Invalid input"
    }
    for (const key of ["questions", "blocks"] as const) {
      if (body[key] !== undefined && !Array.isArray(body[key])) {
        details[key] = `Expected array, received ${zodType(body[key])}`
      }
    }
    if (Object.keys(details).length > 0) {
      return formbricksError(
        400,
        "bad_request",
        "Fields are missing or incorrectly formatted",
        details,
      )
    }
    const now = this.iso()
    const survey: Survey = {
      id: this.state.nextId(),
      createdAt: now,
      updatedAt: now,
      name: body.name as string,
      type: typeof body.type === "string" ? body.type : "link",
      status: typeof body.status === "string" ? body.status : "draft",
      environmentId: body.environmentId as string,
      welcomeCard: { enabled: false },
      questions: (body.questions as unknown[] | undefined) ?? [],
      blocks: (body.blocks as unknown[] | undefined) ?? [],
      endings: [],
      hiddenFields: { enabled: true, fieldIds: [] },
      variables: [],
      displayOption: "displayOnce",
      recontactDays: null,
      displayLimit: null,
      autoClose: null,
      delay: 0,
      displayPercentage: null,
      segment: null,
      triggers: [],
    }
    this.state.surveys.insert(survey.id, survey)
    return annotateResponse(jsonRes(200, { data: this.wireSurvey(survey) }), {
      ids: { surveyId: survey.id },
    })
  }

  responses(): ApiResponse[] {
    return this.state.responses.list({ order: "oldest" }).map((row) => this.render(row.value))
  }
}

export type { FormbricksRuntime, FormbricksRuntimeOptions } from "./runtime.js"
export {
  createRuntime,
  FORMBRICKS_PRESETS,
  formbricksCredential,
  WEBHOOK_PATH,
} from "./runtime.js"
