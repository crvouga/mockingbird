import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bootSqlite,
  createService,
  defineOperations,
  faultEffects,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { decodePostHogBody, tokenFromBody } from "./body.js"
import {
  adminView,
  type Evaluation,
  evaluateFlag,
  type FlagRecord,
  type FlagSpec,
  type FlagSubject,
  flagDetail,
  fromFilters,
  legacyMaps,
  restView,
} from "./flags.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type CapturedEvent, PostHogState, type Settings } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export { decodePostHogBody, tokenFromBody } from "./body.js"
export { ACME_FLAG_STATE } from "./flag-state-fixture.js"
export type {
  Evaluation,
  FlagOverride,
  FlagRecord,
  FlagSpec,
  FlagSubject,
  FlagValue,
} from "./flags.js"
export { evaluateFlag, parseFlagSpec, payloadString } from "./flags.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { FlagStateFile, ImportOptions } from "./import.js"
export { specsFromState, valueForState } from "./import.js"
export type { CapturedEvent, QueryResult, Settings } from "./state.js"

export const POSTHOG_NAMESPACE = "posthog"

export type PostHogAPIOptions = APIOptions & {
  /** Flags every namespace starts with (and returns to on reset), keyed by flag key. */
  flags?: Record<string, FlagSpec>
  /** Initial per-namespace settings (session recording, canned HogQL results). */
  settings?: Partial<Settings>
}

/** Filter for {@link PostHogAPI.events} (`GET /__admin/events`). */
export type EventQuery = {
  distinct_id?: string
  event?: string
  /** Mock-clock epoch ms; events received before it are skipped. */
  since?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const error = (status: number, type: string, code: string, detail: string, attr?: string) =>
  jsonRes(status, { type, code, detail, attr: attr ?? null })

const invalidApiKey = () =>
  error(
    401,
    "authentication_error",
    "invalid_api_key",
    "Project API key invalid. You can find your project API key in your PostHog project settings.",
  )

const malformed = (detail = "Malformed request data") =>
  error(400, "validation_error", "invalid_payload", detail)

/** The remote config a project serves (`/array/{token}/config`, `config=true`). */
const remoteConfig = (token: string, settings: Settings) => ({
  token,
  supportedCompression: ["gzip", "gzip-js"],
  // Always true: when false, posthog-react-native skips flag loading altogether.
  hasFeatureFlags: true,
  captureDeadClicks: false,
  capturePerformance: false,
  autocapture_opt_out: false,
  autocaptureExceptions: false,
  analytics: { endpoint: "/i/v0/e/" },
  elementsChainAsString: true,
  errorTracking: { autocaptureExceptions: false, suppressionRules: [] },
  sessionRecording: settings.sessionRecording
    ? { endpoint: "/s/", consoleLogRecordingEnabled: false, recorderVersion: "v2" }
    : false,
  heatmaps: false,
  surveys: false,
  defaultIdentifiedOnly: true,
  siteApps: [],
})

/** Property names whose values are free text (messages, bodies, stacks); never stored. */
const FREE_TEXT = /message|body|text|content|prompt|stack|trace|html|comment|note|exception_list/i
/** The only properties an `$exception` keeps: never the message or stack. */
const EXCEPTION_KEEP = new Set(["$lib", "$lib_version", "$exception_level", "$session_id"])

const scrubRecord = (properties: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(properties).filter(([key]) => !FREE_TEXT.test(key) && key !== "token"),
  )

/** Properties as stored: `$exception` keeps only metadata; free text is dropped everywhere. */
export const scrubProperties = (
  event: string,
  properties: Record<string, unknown>,
): Record<string, unknown> => {
  if (event === "$exception") {
    return Object.fromEntries(Object.entries(properties).filter(([key]) => EXCEPTION_KEEP.has(key)))
  }
  const kept = scrubRecord(properties)
  for (const nested of ["$set", "$set_once"]) {
    if (isRecord(kept[nested])) kept[nested] = scrubRecord(kept[nested])
  }
  return kept
}

/**
 * Stateful mock of PostHog: remote flag evaluation, remote config, capture, and the
 * management API slice our tooling uses.
 *
 * Every body envelope a PostHog client sends (gzip, gzip-js, base64 `data=` forms) is decoded
 * before routing, and `/path/` and `/path` are the same route, so each SDK hits the same
 * operation.
 */
export class PostHogAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: PostHogState
  private readonly service: Service
  private readonly now: () => number
  /** Fault effects of the original request, keyed by the rewritten one the router sees. */
  private readonly effects = new WeakMap<Request, string[]>()
  /** Rewritten requests whose original body could not be decoded. */
  private readonly undecodable = new WeakSet<Request>()

  constructor(options: PostHogAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? POSTHOG_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new PostHogState(
      sqlite,
      namespace,
      { flags: options.flags ?? {}, settings: options.settings ?? {} },
      this.now,
    )
    const script = (body: string) =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/javascript; charset=utf-8" },
      })
    const handlers = defineOperations<SupportedOperationId>({
      EvaluateFlags: (context) => this.flags(context, "flags"),
      Decide: (context) => this.flags(context, "decide"),
      GetRemoteConfig: (context) =>
        jsonRes(200, remoteConfig(context.params.token ?? "", this.state.current())),
      GetRemoteConfigScript: (context) => {
        const token = context.params.token ?? ""
        const config = remoteConfig(token, this.state.current())
        return script(
          `(function(){window._POSTHOG_REMOTE_CONFIG=window._POSTHOG_REMOTE_CONFIG||{};` +
            `window._POSTHOG_REMOTE_CONFIG[${JSON.stringify(token)}]=` +
            `{config:${JSON.stringify(config)},siteApps:[]};})();`,
        )
      },
      CaptureBatch: (context) => this.capture(context, "/batch/"),
      CaptureEvent: (context) => this.capture(context, "/e/"),
      CaptureEventV0: (context) => this.capture(context, "/i/v0/e/"),
      CaptureRecording: () => {
        this.state.update({ recordings: this.state.current().recordings + 1 })
        return jsonRes(200, { status: 1 })
      },
      GetRecorderScript: () => script("/* mockingbird: session recording is not modelled */\n"),
      GetVersionedRecorderScript: () =>
        script("/* mockingbird: session recording is not modelled */\n"),
      ListSurveys: (context) =>
        typeof context.query.token === "string" && context.query.token
          ? jsonRes(200, { surveys: [] })
          : invalidApiKey(),
      ListWebExperiments: (context) =>
        typeof context.query.token === "string" && context.query.token
          ? jsonRes(200, { experiments: [] })
          : invalidApiKey(),
      ListFeatureFlags: (context) => this.listFlags(context),
      CreateFeatureFlag: (context) => this.createFlag(context),
      UpdateFeatureFlag: (context) => this.updateFlag(context),
      RunQuery: (context) => this.query(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => error(404, "invalid_request", "not_found", "Not found."),
      onError: (thrown) => {
        if (thrown instanceof HttpError) return thrown.toResponse()
        throw thrown
      },
      before: (context) => {
        if (!context.url.pathname.startsWith("/api/projects/")) return undefined
        if (bearerToken(context.request)) return undefined
        return error(
          401,
          "authentication_error",
          "not_authenticated",
          "Authentication credentials were not provided.",
        )
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // PostHog routes end in `/`; the EMR frontend's raw fetch omits it (`/flags?v=2`).
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "")
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null
    const decoded = hasBody ? await decodePostHogBody(request) : undefined
    const headers = new Headers(request.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    const init: RequestInit = { method: request.method, headers }
    if (decoded !== undefined) {
      headers.set("content-type", "application/json")
      init.body = JSON.stringify(decoded)
    } else {
      headers.delete("content-type")
    }
    const routed = new Request(url, init)
    this.effects.set(
      routed,
      faultEffects(request).map((e) => e.name),
    )
    if (hasBody && decoded === undefined) this.undecodable.add(routed)
    return this.service.fetch(routed)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private effect(context: OperationContext, name: string): boolean {
    return this.effects.get(context.request)?.includes(name) ?? false
  }

  private body(context: OperationContext): unknown {
    if (this.undecodable.has(context.request)) throw new HttpError(400, malformedBody())
    return context.body.kind === "json" ? context.body.value : undefined
  }

  /** Every flag this subject sees, in id order, restricted to `keys` when given. */
  evaluate(subject: FlagSubject, keys?: readonly string[]): Evaluation[] {
    const only = keys && keys.length > 0 ? new Set(keys) : undefined
    return this.state
      .listFlags()
      .filter((flag) => !only || only.has(flag.key))
      .map((flag) => evaluateFlag(flag, subject))
      .filter((each): each is Evaluation => each !== undefined)
  }

  private flags(context: OperationContext, route: "flags" | "decide"): Response {
    const body = this.body(context)
    if (!isRecord(body)) return malformed()
    if (!tokenFromBody(body)) return invalidApiKey()
    const distinctId = body.distinct_id
    if (typeof distinctId !== "string" && typeof distinctId !== "number") {
      return error(400, "validation_error", "missing_distinct_id", "Decide requires a distinct_id.")
    }
    const version = Number(context.url.searchParams.get("v") ?? (route === "decide" ? 3 : 1))
    const detailed = route === "decide" ? version >= 4 : version >= 2
    const subject: FlagSubject = {
      distinct_id: String(distinctId),
      ...(isRecord(body.person_properties) ? { person_properties: body.person_properties } : {}),
    }
    const keys = [body.flag_keys_to_evaluate, body.flag_keys].find(Array.isArray) as
      | unknown[]
      | undefined
    const quotaLimited = this.effect(context, "quota_limited")
    const evaluations =
      quotaLimited || body.disable_flags === true ? [] : this.evaluate(subject, keys?.map(String))
    const withConfig = route === "decide" || context.url.searchParams.get("config") === "true"
    const config = withConfig
      ? (() => {
          const { token: _token, ...rest } = remoteConfig(
            String(tokenFromBody(body)),
            this.state.current(),
          )
          return { ...rest, config: { enable_collect_everything: true } }
        })()
      : {}
    const common = {
      errorsWhileComputingFlags: this.effect(context, "errors_while_computing"),
      ...(quotaLimited ? { quotaLimited: ["feature_flags"] } : {}),
      requestId: this.state.ids.next("req_", 24),
      evaluatedAt: this.now(),
    }
    const answer = detailed
      ? {
          ...config,
          flags: Object.fromEntries(evaluations.map((e) => [e.key, flagDetail(e)])),
          ...common,
        }
      : { ...config, ...legacyMaps(evaluations), ...common }
    return annotateResponse(jsonRes(200, answer), { ids: { distinctId: subject.distinct_id } })
  }

  private capture(context: OperationContext, endpoint: string): Response {
    const body = this.body(context)
    if (body === undefined || (typeof body !== "object" && !Array.isArray(body))) {
      return malformed()
    }
    const token = tokenFromBody(body)
    if (!token) return invalidApiKey()
    const items: unknown[] = Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body.batch)
        ? body.batch
        : [body]
    const events = items.filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && typeof item.event === "string" && item.event.length > 0,
    )
    if (events.length === 0 && items.length > 0) return malformed("Invalid payload: no event name")
    const stored: string[] = []
    for (const raw of events) {
      const event = raw.event as string
      const properties = isRecord(raw.properties) ? raw.properties : {}
      const distinct =
        raw.distinct_id ?? properties.distinct_id ?? raw.$distinct_id ?? properties.$distinct_id
      const uuid = typeof raw.uuid === "string" && raw.uuid ? raw.uuid : this.state.nextEventId()
      if (this.state.events.has(uuid)) continue
      const record: CapturedEvent = {
        uuid,
        event,
        distinct_id:
          typeof distinct === "string" || typeof distinct === "number" ? String(distinct) : "",
        properties: scrubProperties(event, properties),
        timestamp:
          typeof raw.timestamp === "string" && raw.timestamp
            ? raw.timestamp
            : new Date(this.now()).toISOString(),
        receivedAtMs: this.now(),
        endpoint,
      }
      this.state.events.insert(uuid, record)
      stored.push(uuid)
    }
    return annotateResponse(jsonRes(200, { status: 1 }), {
      ids: stored.length > 0 ? { eventId: stored[0] as string } : {},
    })
  }

  /** Captured events, oldest first. */
  events(query: EventQuery = {}): CapturedEvent[] {
    return this.state.events
      .list({
        order: "oldest",
        where: (event) =>
          (query.distinct_id === undefined || event.distinct_id === query.distinct_id) &&
          (query.event === undefined || event.event === query.event) &&
          (query.since === undefined || event.receivedAtMs >= query.since),
      })
      .map((row) => row.value)
  }

  private listFlags(context: OperationContext): Response {
    const limit = Math.min(Math.max(Number(context.url.searchParams.get("limit") ?? 100), 1), 100)
    const offset = Math.max(Number(context.url.searchParams.get("offset") ?? 0), 0)
    const flags = this.state.listFlags().filter((flag) => !flag.deleted)
    const base = `${context.url.origin}${context.url.pathname}/`
    const page = (at: number) => `${base}?limit=${limit}${at > 0 ? `&offset=${at}` : ""}`
    return jsonRes(200, {
      count: flags.length,
      next: offset + limit < flags.length ? page(offset + limit) : null,
      previous: offset > 0 ? page(Math.max(offset - limit, 0)) : null,
      results: flags.slice(offset, offset + limit).map(restView),
    })
  }

  private createFlag(context: OperationContext): Response {
    const body = this.body(context)
    if (!isRecord(body)) return malformed()
    const key = body.key
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]+$/.test(key)) {
      return error(
        400,
        "validation_error",
        "invalid_input",
        'Only letters, numbers, hyphens ("-") & underscores ("_") are allowed.',
        "key",
      )
    }
    const existing = this.state.flags.get(key)
    if (existing && !existing.deleted) {
      return error(
        400,
        "validation_error",
        "unique",
        "There is already a feature flag with this key.",
        "key",
      )
    }
    const flag = this.state.putFlag(key, {
      ...fromFilters(body.filters),
      name: typeof body.name === "string" ? body.name : "",
      active: typeof body.active === "boolean" ? body.active : true,
    })
    return annotateResponse(jsonRes(201, restView(flag)), { ids: { flag: flag.key } })
  }

  private updateFlag(context: OperationContext): Response {
    const flag = this.state.findFlag(context.params.flagId ?? "")
    if (!flag) return error(404, "invalid_request", "not_found", "Not found.")
    const body = this.body(context)
    if (!isRecord(body)) return malformed()
    const patch: Partial<FlagRecord> = {}
    if (typeof body.name === "string") patch.name = body.name
    if (typeof body.active === "boolean") patch.active = body.active
    if (typeof body.deleted === "boolean") patch.deleted = body.deleted
    if (body.filters !== undefined) Object.assign(patch, fromFilters(body.filters))
    const updated = this.state.patchFlag(flag.key, patch) ?? flag
    return annotateResponse(jsonRes(200, restView(updated)), { ids: { flag: flag.key } })
  }

  private query(context: OperationContext): Response {
    const body = this.body(context)
    const query = isRecord(body) && isRecord(body.query) ? body.query : undefined
    if (query?.kind !== "HogQLQuery" || typeof query.query !== "string") {
      return error(400, "validation_error", "invalid_input", "Expected a HogQLQuery.", "query")
    }
    const text = query.query
    const canned = this.state
      .current()
      .queryResults.find((each) => each.match === undefined || text.includes(each.match))
    return jsonRes(200, {
      results: canned?.results ?? [],
      columns: canned?.columns ?? [],
      is_cached: false,
    })
  }

  /** The admin view of every flag. */
  flagList() {
    return this.state.listFlags().map(adminView)
  }
}

const malformedBody = () => ({
  type: "validation_error",
  code: "invalid_payload",
  detail: "Malformed request data",
  attr: null,
})

export type { PostHogRuntime, PostHogRuntimeOptions } from "./runtime.js"
export { createRuntime, POSTHOG_PRESETS } from "./runtime.js"
