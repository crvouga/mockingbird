import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  DroppedConnectionError,
  defineOperations,
  faultEffect,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type Insight, type MetaEvent, type MetaSettings, MetaState, OAUTH_CODES } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { createRuntime, META_PRESETS } from "./runtime.js"
export type { Insight, MarketingObject, MetaEvent, MetaSettings } from "./state.js"
export { DEFAULT_SETTINGS, MetaState, OAUTH_CODES } from "./state.js"

export const META_NAMESPACE = "meta"

export type MetaAPIOptions = APIOptions & { settings?: Partial<MetaSettings> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Bearer access token, or the access_token query parameter used by Graph API clients. */
export const accessTokenCredential = (request: Request): string | undefined =>
  bearerToken(request) ?? new URL(request.url).searchParams.get("access_token") ?? undefined

const field = (record: Record<string, unknown>, key: string): string | null =>
  typeof record[key] === "string" ? record[key] : null

const HASHED_USER_FIELDS = [
  "external_id",
  "em",
  "ph",
  "fn",
  "ln",
  "ct",
  "st",
  "zp",
  "db",
  "country",
]
const sha256 = /^[a-f0-9]{64}$/i

const invalidHash = (userData: Record<string, unknown>): string | undefined => {
  for (const name of HASHED_USER_FIELDS) {
    const raw = userData[name]
    if (raw === undefined) continue
    const values = Array.isArray(raw) ? raw : [raw]
    if (values.some((value) => typeof value !== "string" || !sha256.test(value))) return name
  }
  return undefined
}

type InsightRow = Partial<Omit<Insight, "id">> & { date_start: string; date_stop: string }

const INSIGHT_LEVELS = ["ad", "adset", "campaign", "account"] as const
type InsightLevel = (typeof INSIGHT_LEVELS)[number]
const isInsightLevel = (value: string): value is InsightLevel =>
  (INSIGHT_LEVELS as readonly string[]).includes(value)

/** Every insight field the emulator can return; any other `fields` entry is rejected. */
const INSIGHT_FIELDS = new Set([
  "account_id",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "date_start",
  "date_stop",
  "impressions",
  "clicks",
  "spend",
  "actions",
  "action_values",
  "website_purchase_roas",
])

/** `all_days`, `monthly` or a day count from 1 to 90; `undefined` when absent, `null` when invalid. */
const parseTimeIncrement = (raw: unknown): number | "all_days" | "monthly" | undefined | null => {
  if (raw === undefined) return undefined
  if (raw === "all_days" || raw === "monthly") return raw
  const days = Number(raw)
  return typeof raw === "string" && /^\d+$/.test(raw) && days >= 1 && days <= 90 ? days : null
}

const DAY_MS = 86_400_000
const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`)
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const money = (value: number) => String(Math.round(value * 100) / 100)

const sumStats = (
  rows: Insight[],
  pick: (row: Insight) => Array<{ action_type: string; value: string }>,
) => {
  const totals = new Map<string, number>()
  for (const row of rows)
    for (const stat of pick(row))
      totals.set(stat.action_type, (totals.get(stat.action_type) ?? 0) + Number(stat.value))
  return [...totals].map(([action_type, value]) => ({ action_type, value: money(value) }))
}

/** The reporting window a row falls into for a `time_increment`. */
const bucketOf = (
  date: string,
  increment: number | "all_days" | "monthly",
  since: string,
  until: string,
): { start: string; stop: string } => {
  if (increment === "all_days") return { start: since, stop: until }
  if (increment === "monthly") {
    const month = date.slice(0, 7)
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    const start = `${month}-01` < since ? since : `${month}-01`
    const end = dateOf(last.getTime())
    return { start, stop: end > until ? until : end }
  }
  const index = Math.floor((dayOf(date) - dayOf(since)) / (increment * DAY_MS))
  const start = dateOf(dayOf(since) + index * increment * DAY_MS)
  const end = dateOf(dayOf(start) + (increment - 1) * DAY_MS)
  return { start, stop: end > until ? until : end }
}

/**
 * Roll stored daily rows up to a `level` and `time_increment`, the way Insights reports them:
 * counts and spend are summed, action lists are summed per `action_type`, and purchase ROAS is
 * recomputed from the summed purchase value over the summed spend.
 */
const aggregateInsights = (
  rows: Insight[],
  options: {
    level: InsightLevel
    increment: number | "all_days" | "monthly"
    since: string | undefined
    until: string | undefined
    country: boolean
  },
): InsightRow[] => {
  if (rows.length === 0) return []
  const since = options.since ?? rows[0]?.date_start ?? ""
  const until =
    options.until ?? rows.reduce((max, row) => (row.date_stop > max ? row.date_stop : max), "")
  const groups = new Map<string, { bucket: { start: string; stop: string }; rows: Insight[] }>()
  for (const row of rows) {
    if (options.level === "adset" && !row.adset_id) continue
    if (options.level === "ad" && !row.ad_id) continue
    const object =
      options.level === "account"
        ? row.account_id
        : options.level === "campaign"
          ? row.campaign_id
          : options.level === "adset"
            ? (row.adset_id ?? "")
            : (row.ad_id ?? "")
    const bucket = bucketOf(row.date_start, options.increment, since, until)
    const key = `${bucket.start}|${object}|${options.country ? (row.country ?? "") : ""}`
    const group = groups.get(key) ?? { bucket, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].map(({ bucket, rows: members }) => {
    const first = members[0] as Insight
    const spend = members.reduce((total, row) => total + Number(row.spend), 0)
    const actionValues = sumStats(members, (row) => row.action_values)
    const purchaseValue = Number(
      actionValues.find((stat) => stat.action_type === "purchase")?.value ?? 0,
    )
    const level = options.level
    return {
      account_id: first.account_id,
      ...(level !== "account"
        ? { campaign_id: first.campaign_id, campaign_name: first.campaign_name }
        : {}),
      ...(level === "adset" || level === "ad"
        ? {
            ...(first.adset_id ? { adset_id: first.adset_id } : {}),
            ...(first.adset_name ? { adset_name: first.adset_name } : {}),
          }
        : {}),
      ...(level === "ad"
        ? {
            ...(first.ad_id ? { ad_id: first.ad_id } : {}),
            ...(first.ad_name ? { ad_name: first.ad_name } : {}),
          }
        : {}),
      date_start: bucket.start,
      date_stop: bucket.stop,
      impressions: String(members.reduce((total, row) => total + Number(row.impressions), 0)),
      clicks: String(members.reduce((total, row) => total + Number(row.clicks), 0)),
      spend: money(spend),
      actions: sumStats(members, (row) => row.actions),
      action_values: actionValues,
      website_purchase_roas:
        spend > 0 ? [{ action_type: "purchase", value: money(purchaseValue / spend) }] : [],
      ...(options.country && first.country ? { country: first.country } : {}),
    }
  })
}

/** Graph returns only the requested `fields`, plus the reporting window and breakdowns. */
const selectFields = (
  row: InsightRow,
  fields: string[] | undefined,
  country: boolean,
): InsightRow => {
  if (fields === undefined) return row
  const keep = new Set([...fields, "date_start", "date_stop", ...(country ? ["country"] : [])])
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => keep.has(key)),
  ) as unknown as InsightRow
}

/** Stateful subset of Meta Graph v26 used by marketing reporting and CAPI clients. */
export class MetaAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: MetaState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: MetaAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? META_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new MetaState(sqlite, namespace, options.settings)
    this.service = createService({
      document,
      handlers: defineOperations<SupportedOperationId>({
        PostPixelEvents: (context) => this.postEvents(context),
        GetInsights: (context) => this.getInsights(context),
        GetMarketingObject: (context) => this.getMarketingObject(context),
      }),
      sqlite,
      namespace,
      now: this.now,
      notFound: () => this.error(404, "Unsupported get request.", 100, 33),
      onError: (error) => {
        throw error
      },
      before: (context) => {
        const token = accessTokenCredential(context.request)
        if (!token) return this.error(401, "An active access token must be used.", 190, 463)
        const allowed = this.state.current().accessTokens
        if (allowed.length > 0 && !allowed.includes(token)) {
          return this.error(401, "Invalid OAuth access token.", 190, 467)
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

  events(): MetaEvent[] {
    return this.state.events.list().map((entry) => entry.value)
  }

  private trace(): string {
    return this.state.ids.next("trace_", 24)
  }

  private error(
    status: number,
    message: string,
    code: number,
    errorSubcode?: number,
    transient = false,
  ): Response {
    return jsonRes(status, {
      error: {
        message,
        type: OAUTH_CODES.has(code) ? "OAuthException" : "GraphMethodException",
        code,
        ...(errorSubcode === undefined ? {} : { error_subcode: errorSubcode }),
        is_transient: transient,
        fbtrace_id: this.trace(),
      },
    })
  }

  private postEvents(context: OperationContext): Response {
    const issues = bodyIssues(context, "application/json")
    if (issues.length > 0)
      return this.error(400, `Invalid parameter: ${issues[0]?.path ?? "data"}`, 100)
    const body =
      context.body.kind === "json" && isRecord(context.body.value) ? context.body.value : null
    const data = Array.isArray(body?.data) ? body.data : []
    if (data.length === 0) return this.error(400, "The parameter data is required.", 100)
    const pixelId = context.params.pixel_id ?? ""
    const testCode = typeof body?.test_event_code === "string" ? body.test_event_code : null
    const partial = faultEffect(context.request, "partial_acceptance") !== undefined
    let accepted = 0
    const messages: string[] = []
    for (let index = 0; index < data.length; index += 1) {
      const raw = data[index]
      if (!isRecord(raw)) return this.error(400, `Invalid parameter at data[${index}]`, 100)
      const eventName = field(raw, "event_name")
      const actionSource = field(raw, "action_source")
      const eventTime = typeof raw.event_time === "number" ? raw.event_time : Number.NaN
      const userData = isRecord(raw.user_data) ? raw.user_data : null
      if (!eventName || !actionSource || !Number.isInteger(eventTime) || !userData) {
        return this.error(400, `Invalid parameter at data[${index}]`, 100)
      }
      const badHash = invalidHash(userData)
      if (badHash) return this.error(400, `Invalid SHA-256 value for user_data.${badHash}.`, 100)
      const age = Math.floor(this.now() / 1000) - eventTime
      if (age > this.state.current().maxEventAgeSeconds) {
        return this.error(400, "Event time can be at most 7 days old.", 100)
      }
      if (age < -60) return this.error(400, "Event time cannot be in the future.", 100)
      if (partial && index > 0) {
        messages.push(`data[${index}] was not accepted by the scripted partial failure`)
        continue
      }
      const eventId = field(raw, "event_id")
      const id = eventId ? `${pixelId}:${eventId}` : this.state.ids.next("evt_", 24)
      if (!this.state.events.has(id)) {
        this.state.events.insert(id, {
          id,
          pixelId,
          event_name: eventName,
          event_time: eventTime,
          event_id: eventId,
          action_source: actionSource,
          event_source_url: field(raw, "event_source_url"),
          user_data: userData,
          custom_data: isRecord(raw.custom_data) ? raw.custom_data : {},
          test_event_code: testCode,
          accepted_at: Math.floor(this.now() / 1000),
        })
      }
      accepted += 1
    }
    if (faultEffect(context.request, "accepted_then_drop") !== undefined) {
      throw new DroppedConnectionError()
    }
    return annotateResponse(
      jsonRes(200, { events_received: accepted, messages, fbtrace_id: this.trace() }),
      { ids: { pixelId } },
    )
  }

  private getInsights(context: OperationContext): Response {
    const accountId = context.params.account_id ?? ""
    let since: string | undefined
    let until: string | undefined
    if (typeof context.query.time_range === "string") {
      try {
        const parsed = JSON.parse(context.query.time_range) as unknown
        if (!isRecord(parsed)) throw new Error("not an object")
        since = typeof parsed.since === "string" ? parsed.since : undefined
        until = typeof parsed.until === "string" ? parsed.until : undefined
      } catch {
        return this.error(400, "Invalid parameter: time_range.", 100)
      }
    }
    const level = typeof context.query.level === "string" ? context.query.level : undefined
    if (level !== undefined && !isInsightLevel(level)) {
      return this.error(
        400,
        `(#100) level must be one of the following values: ${INSIGHT_LEVELS.join(", ")}`,
        100,
      )
    }
    const increment = parseTimeIncrement(context.query.time_increment)
    if (increment === null) {
      return this.error(
        400,
        "(#100) time_increment must be all_days, monthly, or an integer between 1 and 90",
        100,
      )
    }
    const fields =
      typeof context.query.fields === "string" && context.query.fields.trim() !== ""
        ? context.query.fields.split(",").map((name) => name.trim())
        : undefined
    const unknownField = fields?.find((name) => !INSIGHT_FIELDS.has(name))
    if (unknownField !== undefined) {
      return this.error(400, `(#100) ${unknownField} is not valid for fields param.`, 100)
    }
    const country =
      typeof context.query.breakdowns === "string" &&
      context.query.breakdowns.split(",").includes("country")
    const stored = this.state.insights
      .list({
        where: (row) =>
          row.account_id === accountId &&
          (since === undefined || row.date_start >= since) &&
          (until === undefined || row.date_stop <= until),
      })
      .map((entry) => entry.value)
      .sort((left, right) => left.date_start.localeCompare(right.date_start))
    const rows =
      level === undefined && increment === undefined
        ? stored.map((row) => this.renderInsight(row, country))
        : aggregateInsights(stored, {
            level: level ?? "campaign",
            increment: increment ?? 1,
            since,
            until,
            country,
          })
    const start = typeof context.query.after === "string" ? Number(context.query.after) : 0
    if (!Number.isInteger(start) || start < 0) return this.error(400, "Invalid cursor.", 100)
    const limit = Math.min(100, Math.max(1, Number(context.query.limit ?? 25)))
    const page = rows.slice(start, start + limit)
    const nextOffset = start + page.length
    const cursors = { before: String(start), after: String(nextOffset) }
    const paging: { cursors: typeof cursors; next?: string } = { cursors }
    if (nextOffset < rows.length) {
      const next = new URL(context.url)
      next.searchParams.set("after", String(nextOffset))
      paging.next = next.toString()
    }
    return jsonRes(200, {
      data: page.map((row) => selectFields(row, fields, country)),
      paging,
    })
  }

  private renderInsight(row: Insight, wantsCountry: boolean): InsightRow {
    const {
      id: _id,
      country,
      adset_id: _adsetId,
      adset_name: _adsetName,
      ad_id: _adId,
      ad_name: _adName,
      ...rest
    } = row
    return { ...rest, ...(wantsCountry && country ? { country } : {}) }
  }

  private getMarketingObject(context: OperationContext): Response {
    const id = context.params.object_id ?? ""
    const object = this.state.objects.get(id)
    if (!object)
      return this.error(
        404,
        `Unsupported get request. Object with ID '${id}' does not exist.`,
        100,
        33,
      )
    return annotateResponse(jsonRes(200, object), { ids: { marketingObjectId: id } })
  }
}
