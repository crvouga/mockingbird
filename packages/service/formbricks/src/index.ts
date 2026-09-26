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
  CORPUS_SURVEYS,
  FormbricksState,
  type ResponseRecord,
  type Settings,
  type Survey,
  workspaceSettings,
} from "./state.js"
import { surveyElements, validateResponseData } from "./validation.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { Contact, ResponseRecord, Settings, Survey } from "./state.js"
export { CORPUS_SURVEYS, DEFAULT_SETTINGS, ENVIRONMENT_ID, WORKSPACE_ID } from "./state.js"
export { validateResponseData } from "./validation.js"

export const FORMBRICKS_NAMESPACE = "formbricks"

/** The response as the API (and the webhook) renders it: `TResponse`. */
export type ApiResponse = Omit<ResponseRecord, "workspaceId">

/** The body Formbricks' response pipeline posts to a webhook (`process-response-pipeline-job.ts`). */
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
  /** Surveys every namespace starts with. Default: the synthetic corpus (`CORPUS_SURVEYS`). */
  surveys?: readonly Survey[]
  settings?: Partial<Settings>
  /** Called for every pipeline event; the runtime signs and delivers it. */
  onWebhook?: (event: FormbricksWebhook) => void
}

type ErrorCode =
  | "not_found"
  | "bad_request"
  | "internal_server_error"
  | "unauthorized"
  | "not_authenticated"
  | "forbidden"
  | "too_many_requests"

/**
 * Formbricks' v1 error envelope (`apps/web/app/lib/api/response.ts`): `{code, message, details}`,
 * `Cache-Control: private, no-store`, and the CORS headers on the routes that pass `cors`.
 */
export const formbricksError = (
  status: number,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  cors = true,
) =>
  jsonRes(
    status,
    { code, message, details },
    {
      "cache-control": "private, no-store",
      ...(cors ? { "access-control-allow-origin": "*" } : {}),
    },
  )

const notFound = (resourceType: string, resourceId: string | null, cors = true) =>
  formbricksError(
    404,
    "not_found",
    `${resourceType} not found`,
    { resource_id: resourceId, resource_type: resourceType },
    cors,
  )

const CUID2 = /^[0-9a-z]+$/

/** Zod 4's name for the received type in `Invalid input: expected X, received Y`. */
const zodType = (value: unknown) =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "number" && Number.isNaN(value)
        ? "NaN"
        : typeof value

const AUTO_CAPTURED_META: Record<string, "string" | "number"> = {
  pagePath: "string",
  pageReferrer: "string",
  utmSource: "string",
  utmMedium: "string",
  utmCampaign: "string",
  utmTerm: "string",
  utmContent: "string",
  screenWidth: "number",
  screenHeight: "number",
  viewportWidth: "number",
  viewportHeight: "number",
  timezone: "string",
  locale: "string",
}

/**
 * `ZResponseInputV2.safeParse` + `transformErrorToDetails` (zod 4 messages, keyed by path, in
 * schema order). Unknown keys are stripped, as zod objects do; `userId` is not part of the v2
 * input at all (it is omitted, so it is ignored).
 */
const responseInputIssues = (body: Record<string, unknown>): Record<string, string> => {
  const details: Record<string, string> = {}
  const expect = (path: string, value: unknown, type: string, optional = false) => {
    if (value === undefined) {
      if (!optional) details[path] = `Invalid input: expected ${type}, received undefined`
      return false
    }
    const actual = zodType(value)
    if (actual !== type) {
      details[path] = `Invalid input: expected ${type}, received ${actual}`
      return false
    }
    return true
  }
  const nullish = (key: string, cuid = false) => {
    const value = body[key]
    if (value === undefined || value === null) return
    if (expect(key, value, "string") && cuid && !CUID2.test(value as string)) {
      details[key] = "Invalid cuid2"
    }
  }
  if (expect("surveyId", body.surveyId, "string") && !CUID2.test(body.surveyId as string)) {
    details.surveyId = "Invalid cuid2"
  }
  nullish("displayId")
  if (body.singleUseId !== null) expect("singleUseId", body.singleUseId, "string", true)
  nullish("pinAuthToken")
  nullish("recaptchaToken")
  expect("finished", body.finished, "boolean")
  nullish("endingId")
  expect("language", body.language, "string", true)
  if (zodType(body.data) !== "object") {
    details.data = `Invalid input: expected record, received ${zodType(body.data)}`
  } else {
    for (const [key, value] of Object.entries(body.data as Record<string, unknown>)) {
      const ok =
        value === undefined ||
        typeof value === "string" ||
        (typeof value === "number" && !Number.isNaN(value)) ||
        (Array.isArray(value) && value.every((v) => typeof v === "string")) ||
        (zodType(value) === "object" &&
          Object.values(value as object).every((v) => typeof v === "string"))
      if (!ok) details[`data.${key}`] = "Invalid input"
    }
  }
  if (body.variables !== undefined) {
    if (zodType(body.variables) !== "object") {
      details.variables = `Invalid input: expected record, received ${zodType(body.variables)}`
    } else {
      for (const [key, value] of Object.entries(body.variables as Record<string, unknown>)) {
        if (typeof value !== "string" && typeof value !== "number") {
          details[`variables.${key}`] = "Invalid input"
        }
      }
    }
  }
  if (body.ttc !== undefined) {
    if (zodType(body.ttc) !== "object") {
      details.ttc = `Invalid input: expected record, received ${zodType(body.ttc)}`
    } else {
      for (const [key, value] of Object.entries(body.ttc as Record<string, unknown>)) {
        expect(`ttc.${key}`, value, "number")
      }
    }
  }
  if (body.meta !== undefined && expect("meta", body.meta, "object")) {
    const meta = body.meta as Record<string, unknown>
    for (const [key, type] of Object.entries(AUTO_CAPTURED_META)) {
      expect(`meta.${key}`, meta[key], type, true)
    }
    for (const key of ["source", "url", "country", "action", "ipAddress"]) {
      expect(`meta.${key}`, meta[key], "string", true)
    }
    expect("meta.userAgent", meta.userAgent, "object", true)
  }
  nullish("contactId", true)
  return details
}

/** `normalizeResponseLanguage`: bare codes become region-tagged BCP-47 (a common subset). */
const CANONICAL_LANGUAGES: Record<string, string> = {
  da: "da-DK",
  de: "de-DE",
  en: "en-US",
  es: "es-ES",
  fi: "fi-FI",
  fr: "fr-FR",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  nl: "nl-NL",
  pl: "pl-PL",
  pt: "pt-BR",
  ru: "ru-RU",
  sv: "sv-SE",
  tr: "tr-TR",
  zh: "zh-Hans-CN",
}
const normalizeLanguage = (language: unknown): string | null => {
  if (typeof language !== "string") return null
  const trimmed = language.trim()
  if (!trimmed) return null
  return CANONICAL_LANGUAGES[trimmed.toLowerCase()] ?? trimmed
}

/** The keys the Embedded Data ingest contract keeps: element ids and declared hidden fields. */
const ingestData = (survey: Survey, data: Record<string, unknown>): Record<string, unknown> => {
  const elementIds = new Set(surveyElements(survey).map((e) => e.id))
  const hidden = survey.hiddenFields as { fieldIds?: unknown } | undefined
  const hiddenIds = new Set(Array.isArray(hidden?.fieldIds) ? (hidden.fieldIds as string[]) : [])
  return Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) => value !== undefined && (elementIds.has(key) || hiddenIds.has(key)),
    ),
  )
}

/** The fields of a survey the environment state ships to SDKs (`ZJsWorkspaceStateSurvey`). */
const ENVIRONMENT_SURVEY_FIELDS = [
  "id",
  "name",
  "welcomeCard",
  "questions",
  "blocks",
  "variables",
  "type",
  "showLanguageSwitch",
  "languages",
  "endings",
  "autoClose",
  "styling",
  "status",
  "segment",
  "recontactDays",
  "displayLimit",
  "displayOption",
  "hiddenFields",
  "embeddedFields",
  "triggers",
  "displayPercentage",
  "delay",
  "workspaceOverwrites",
  "isBackButtonHidden",
  "isAutoProgressingEnabled",
  "recaptcha",
]

/** `addLegacyProjectOverwrites`: `projectOverwrites` mirrors `workspaceOverwrites`. */
const withLegacyProjectOverwrites = <T extends Record<string, unknown>>(survey: T): T =>
  "workspaceOverwrites" in survey
    ? { ...survey, projectOverwrites: survey.workspaceOverwrites }
    : survey

type Block = {
  id?: string
  elements?: Record<string, unknown>[]
  buttonLabel?: unknown
  backButtonLabel?: unknown
}

const hasLabel = (label: unknown) =>
  typeof label === "object" &&
  label !== null &&
  Object.values(label).some((v) => typeof v === "string" && v !== "")

/** `transformBlocksToQuestions` (without logic): block labels land on the block's last element. */
const blocksToQuestions = (blocks: Block[]): Record<string, unknown>[] =>
  blocks.flatMap((block) => {
    const elements = Array.isArray(block?.elements)
      ? block.elements.filter((e) => typeof e === "object" && e !== null)
      : []
    return elements.map((raw, index) => {
      const element = { ...raw }
      if (element.type === "cta" && element.ctaButtonLabel) {
        element.buttonLabel = element.ctaButtonLabel
      }
      if (index === elements.length - 1) {
        if (hasLabel(block.buttonLabel)) element.buttonLabel = block.buttonLabel
        if (hasLabel(block.backButtonLabel)) element.backButtonLabel = block.backButtonLabel
      }
      return element
    })
  })

/** `transformQuestionsToBlocks` (without logic): one block per question. */
const questionsToBlocks = (questions: Record<string, unknown>[], nextId: () => string) =>
  questions.map((question, index) => {
    const { logic, logicFallback, buttonLabel, backButtonLabel, ...element } = question
    return {
      id: nextId(),
      name: `Block ${index + 1}`,
      elements: [element],
      ...(buttonLabel !== undefined ? { buttonLabel } : {}),
      ...(backButtonLabel !== undefined ? { backButtonLabel } : {}),
      ...(logic !== undefined ? { logic } : {}),
      ...(logicFallback !== undefined ? { logicFallback } : {}),
    }
  })

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
 * Stateful mock of open-source Formbricks: the client environment state and response creation
 * the JS SDK uses, the v1 management API, and the response pipeline's webhooks.
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
      surveys: options.surveys ?? CORPUS_SURVEYS,
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      GetEnvironmentState: (context) => this.environmentState(context),
      CreateClientResponse: (context) => this.createResponse(context),
      ListResponses: (context) => this.listResponses(context),
      GetResponse: (context) => {
        const id = context.params.responseId ?? ""
        const record = this.state.responses.get(id)
        if (!record) return notFound("Response", id, false)
        return jsonRes(200, { data: this.render(record, context) })
      },
      ListSurveys: (context) => this.listSurveys(context),
      GetSurvey: (context) => {
        const id = context.params.surveyId ?? ""
        const survey = this.state.surveys.get(id)
        if (!survey) return notFound("Survey", id, false)
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
      notFound: () => formbricksError(404, "not_found", "Not found", {}, false),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        if (!context.operation.path.startsWith("/api/v1/management/")) return undefined
        const key = context.request.headers.get("x-api-key")?.trim()
        const keys = this.state.current().apiKeys
        if (!key || (keys.length > 0 && !keys.includes(key))) {
          return formbricksError(
            401,
            "not_authenticated",
            "Not authenticated",
            { "x-Api-Key": "Header not provided or API Key invalid" },
            false,
          )
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

  /**
   * A survey as the v1 management API serves it: `questions` derived from `blocks`, the owning
   * `workspaceId` and its legacy `environmentId`, and `projectOverwrites`. Shared corpus surveys
   * are reported under the first configured workspace.
   */
  wireSurvey(survey: Survey): Survey {
    const { workspaceId: stored, ...rest } = survey
    const workspaceId = stored ?? this.state.current().workspaces[0]
    const blocks = Array.isArray(rest.blocks) ? (rest.blocks as Block[]) : []
    const questions = blocks.length > 0 ? blocksToQuestions(blocks) : rest.questions
    return withLegacyProjectOverwrites({
      ...rest,
      ...(questions !== undefined ? { questions } : {}),
      ...(workspaceId
        ? { workspaceId, environmentId: this.state.legacyEnvironmentId(workspaceId) }
        : {}),
    }) as Survey
  }

  render(record: ResponseRecord, context?: OperationContext): ApiResponse {
    const { workspaceId: _workspaceId, ...rest } = record
    const asString = context ? faultEffect(context.request, "data_as_string") !== undefined : false
    return asString ? { ...rest, data: JSON.stringify(rest.data) as never } : rest
  }

  private environmentState(context: OperationContext): Response {
    const id = (context.params.workspaceId ?? "").trim()
    if (!CUID2.test(id)) {
      return formbricksError(400, "bad_request", "Invalid ID format")
    }
    const workspaceId = this.state.resolveWorkspace(id)
    if (!workspaceId) return notFound("Workspace", id, false)
    const surveys = this.state
      .surveysOf(workspaceId)
      .filter((s) => s.type === "app" && s.status === "inProgress")
      .map((s) =>
        withLegacyProjectOverwrites(
          Object.fromEntries(ENVIRONMENT_SURVEY_FIELDS.filter((k) => k in s).map((k) => [k, s[k]])),
        ),
      )
    const workspace = workspaceSettings(workspaceId)
    return jsonRes(
      200,
      {
        data: {
          data: { surveys, actionClasses: [], workspace, project: workspace },
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
    const rawId = context.params.workspaceId ?? ""
    const workspaceId = this.state.resolveWorkspace(rawId)
    if (!workspaceId) return notFound("Workspace", rawId, false)
    if (context.body.kind !== "json") {
      return formbricksError(400, "bad_request", "Invalid JSON in request body", {
        error: "request body is not valid JSON",
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
    const contactId = typeof body.contactId === "string" ? body.contactId : null
    if (contactId && !this.state.current().contactsEnabled) {
      return formbricksError(
        403,
        "forbidden",
        "User identification is only available for enterprise users.",
      )
    }
    const survey = this.state.surveys.get(body.surveyId as string)
    if (!survey) return notFound("Survey", body.surveyId as string)
    const data = ingestData(survey, body.data as Record<string, unknown>)
    if (!this.state.belongsTo(survey, workspaceId)) {
      return formbricksError(400, "bad_request", "Survey is part of another workspace", {
        workspaceId,
      })
    }
    if (survey.status !== "inProgress") {
      return formbricksError(403, "forbidden", "Survey is not accepting submissions", {
        surveyId: survey.id,
      })
    }
    const errors = validateResponseData(
      survey,
      data,
      typeof body.language === "string" ? body.language : "en",
    )
    if (errors) {
      const details: Record<string, string> = {}
      for (const [elementId, messages] of Object.entries(errors)) {
        details[`response.data.${elementId}`] = messages.join("; ")
      }
      return formbricksError(400, "bad_request", "Validation failed", details)
    }
    const now = this.iso()
    const finished = body.finished as boolean
    const input = (body.meta ?? {}) as Record<string, unknown>
    const contact = contactId ? this.state.contactOf(contactId, workspaceId) : undefined
    const ttcIn = (body.ttc ?? {}) as Record<string, number>
    const ttc = Object.fromEntries(
      Object.entries(ttcIn).map(([k, v]) => [k, Math.max(v, 0)] as const),
    )
    if (finished && body.ttc !== undefined) {
      ttc._total = Object.values(ttc).reduce((a, b) => a + b, 0)
    }
    const country =
      context.request.headers.get("cf-ipcountry") ??
      context.request.headers.get("cloudfront-viewer-country") ??
      undefined
    const meta: Record<string, unknown> = {
      ...Object.fromEntries(Object.keys(AUTO_CAPTURED_META).map((k) => [k, input[k]])),
      source: input.source,
      url: input.url,
      userAgent: { device: "desktop" },
      country,
      action: input.action,
    }
    const record: ResponseRecord = {
      id: this.state.nextId(),
      createdAt: now,
      updatedAt: now,
      surveyId: survey.id,
      workspaceId,
      displayId: typeof body.displayId === "string" ? body.displayId : null,
      contact: contact
        ? {
            id: contact.id,
            ...(contact.attributes.userId !== undefined
              ? { userId: contact.attributes.userId }
              : {}),
          }
        : null,
      contactAttributes: contact ? contact.attributes : null,
      finished,
      endingId: typeof body.endingId === "string" ? body.endingId : null,
      data,
      variables: (body.variables ?? {}) as Record<string, unknown>,
      ttc,
      tags: [],
      meta: Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)),
      singleUseId: typeof body.singleUseId === "string" ? body.singleUseId : null,
      language: normalizeLanguage(body.language),
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

  /** Emit a pipeline event (`responseCreated` / `responseFinished`) for a stored response. */
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
    const params = context.url.searchParams
    const surveyId = params.get("surveyId")
    if (surveyId && !this.state.surveys.get(surveyId)) return notFound("Survey", surveyId)
    const limit = params.get("limit") ? Number(params.get("limit")) : undefined
    const skip = params.get("skip") ? Number(params.get("skip")) : 0
    const all = this.state.responses
      .list({ order: "newest", where: (r) => !surveyId || r.surveyId === surveyId })
      .map((row) => row.value)
    const page = all.slice(skip, limit === undefined ? undefined : skip + limit)
    return jsonRes(200, { data: page.map((r) => this.render(r, context)) })
  }

  /** `getSurveys(workspaceIds, limit, offset)`: newest `updatedAt` first. */
  private listSurveys(context: OperationContext): Response {
    const params = context.url.searchParams
    const limit = params.has("limit") ? Number(params.get("limit")) : undefined
    const offset = params.has("offset") ? Number(params.get("offset")) : 0
    const surveys = this.state
      .allSurveys()
      .map((survey, index) => ({ survey, index }))
      .sort((a, b) => {
        const byDate = String(b.survey.updatedAt ?? "").localeCompare(
          String(a.survey.updatedAt ?? ""),
        )
        return byDate !== 0 ? byDate : b.index - a.index
      })
      .map(({ survey }) => survey)
    const page = surveys.slice(offset, limit === undefined ? undefined : offset + limit)
    return jsonRes(200, { data: page.map((s) => this.wireSurvey(s)) })
  }

  private createSurvey(context: OperationContext): Response {
    const body =
      context.body.kind === "json" && zodType(context.body.value) === "object"
        ? (context.body.value as Record<string, unknown>)
        : undefined
    if (!body) {
      return formbricksError(
        400,
        "bad_request",
        "Malformed JSON input, please check your request body",
        {},
        false,
      )
    }
    // `resolveBodyIds`: `workspaceId`, or the legacy `environmentId`.
    const rawId = body.workspaceId ?? body.environmentId
    if (!rawId) {
      return formbricksError(400, "bad_request", "workspaceId must be provided", {}, false)
    }
    if (typeof rawId !== "string") {
      return formbricksError(400, "bad_request", "workspaceId must be a string", {}, false)
    }
    const workspaceId = this.state.resolveWorkspace(rawId)
    if (!workspaceId) return notFound("Workspace", rawId, false)
    const details: Record<string, string> = {}
    if (typeof body.name !== "string") {
      details.name = `Invalid input: expected string, received ${zodType(body.name)}`
    }
    // A light stand-in for the survey schema: items are objects, blocks carry an elements array.
    for (const key of ["questions", "blocks"] as const) {
      const list = body[key]
      if (list === undefined) continue
      if (!Array.isArray(list)) {
        details[key] = `Invalid input: expected array, received ${zodType(list)}`
        continue
      }
      for (const [index, item] of list.entries()) {
        if (zodType(item) !== "object") {
          details[`${key}.${index}`] = `Invalid input: expected object, received ${zodType(item)}`
        } else if (key === "blocks" && !Array.isArray((item as Block).elements)) {
          details[`blocks.${index}.elements`] =
            `Invalid input: expected array, received ${zodType((item as Block).elements)}`
        }
      }
    }
    if (body.type !== undefined && body.type !== "app" && body.type !== "link") {
      details.type = 'Invalid option: expected one of "link"|"app"'
    }
    if (Object.keys(details).length > 0) {
      return formbricksError(
        400,
        "bad_request",
        "Fields are missing or incorrectly formatted",
        details,
      )
    }
    const questions = (body.questions as Record<string, unknown>[] | undefined) ?? []
    let blocks = (body.blocks as unknown[] | undefined) ?? []
    if (questions.length > 0 && blocks.length > 0) {
      return formbricksError(
        400,
        "bad_request",
        "Cannot provide both questions and blocks. Please provide only one of these fields.",
        {},
        false,
      )
    }
    if (questions.length === 0 && blocks.length === 0) {
      return formbricksError(
        400,
        "bad_request",
        "Must provide either questions or blocks. Both cannot be empty.",
        {},
        false,
      )
    }
    if (questions.length > 0) blocks = questionsToBlocks(questions, () => this.state.nextId())
    const now = this.iso()
    const survey: Survey = {
      id: this.state.nextId(),
      createdAt: now,
      updatedAt: now,
      name: body.name as string,
      type: typeof body.type === "string" ? body.type : "link",
      status: typeof body.status === "string" ? body.status : "draft",
      workspaceId,
      welcomeCard: { enabled: false },
      questions: [],
      blocks,
      endings: [],
      hiddenFields: { enabled: true, fieldIds: [] },
      variables: [],
      languages: [],
      displayOption: "displayOnce",
      recontactDays: null,
      displayLimit: null,
      autoClose: null,
      delay: 0,
      displayPercentage: null,
      segment: null,
      triggers: [],
      workspaceOverwrites: null,
      isAutoProgressingEnabled: false,
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
