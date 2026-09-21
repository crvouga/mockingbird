import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  type BodyIssue,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  HttpError,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { type ErrorEntry, klaviyoApiKey, klaviyoError, uuidFrom } from "./errors.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type KlaviyoEvent, KlaviyoState } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export { klaviyoApiKey, klaviyoError } from "./errors.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { KlaviyoEvent, KlaviyoProfile } from "./state.js"

export const KLAVIYO_NAMESPACE = "klaviyo"

/** The revision our backend pins (`klaviyo.sevice.ts`). */
export const KLAVIYO_REVISION = "2024-02-15"

const REVISION_PATTERN = /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/

const errorResponse = (entry: ErrorEntry) => jsonRes(entry.status, klaviyoError(entry))

const invalid = (detail: string, pointer: string) =>
  errorResponse({
    status: 400,
    code: "invalid",
    title: "Invalid input.",
    detail,
    source: { pointer },
  })

const pointerOf = (path: string) => `/${path.split(".").filter(Boolean).join("/")}`

/** Klaviyo's wording for the first schema problem in a create-event body. */
const issueResponse = (issue: BodyIssue): Response => {
  const missing = /^missing required property (.+)$/.exec(issue.message)
  if (missing) {
    const path = [issue.path, missing[1]].filter(Boolean).join(".")
    return invalid(`'${missing[1]}' is a required field.`, pointerOf(path))
  }
  if (issue.path.endsWith("phone_number")) {
    return invalid(
      "Invalid phone number format (Example of a valid format: +12345678901)",
      pointerOf(issue.path),
    )
  }
  if (issue.path.endsWith("email")) {
    return invalid("Invalid email address", pointerOf(issue.path))
  }
  if (issue.path === "") return invalid("Invalid JSON body.", "/data")
  return invalid(`Invalid value: ${issue.message}.`, pointerOf(issue.path))
}

export type KlaviyoAPIOptions = APIOptions & {
  /** The public base URL used in `links` (default `https://a.klaviyo.com`). */
  baseUrl?: string
}

type Attributes = {
  properties: Record<string, unknown>
  time?: string
  value?: number
  value_currency?: string
  unique_id?: string
  metric: { data: { attributes: { name: string } } }
  profile: {
    data: {
      id?: string
      attributes?: { email?: string; phone_number?: string; external_id?: string }
    }
  }
}

/**
 * Stateful mock of Klaviyo's events API. Every accepted event lands in the namespace's
 * event store, which is also the outbox (`GET /__admin/outbox?to=<email>&metric=…`).
 */
export class KlaviyoAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: KlaviyoState
  private readonly service: Service
  private readonly now: () => number
  private readonly baseUrl: string

  constructor(options: KlaviyoAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? KLAVIYO_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.baseUrl = (options.baseUrl ?? "https://a.klaviyo.com").replace(/\/$/, "")
    this.state = new KlaviyoState(sqlite, namespace)
    const handlers = defineOperations<SupportedOperationId>({
      CreateEvent: (context) => this.createEvent(context),
      GetEvents: () =>
        jsonRes(200, {
          data: this.state.events.list().map((event) => this.resource(event)),
          links: { self: `${this.baseUrl}/api/events/`, next: null, prev: null },
        }),
      GetEvent: (context) => {
        const event = this.state.events.get(context.params.id ?? "")
        if (!event) {
          return errorResponse({
            status: 404,
            code: "not_found",
            title: "Not found.",
            detail: `An event with id ${context.params.id} does not exist.`,
            source: { parameter: "id" },
          })
        }
        return annotateResponse(jsonRes(200, { data: this.resource(event) }), {
          ids: { eventId: event.id },
        })
      },
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () =>
        errorResponse({
          status: 404,
          code: "not_found",
          title: "Not found.",
          detail: "The requested resource was not found.",
        }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        if (!klaviyoApiKey(context.request)) {
          return errorResponse({
            status: 401,
            code: "not_authenticated",
            title: "Authentication credentials were not provided.",
            detail: "Missing or invalid authorization scheme. Please use Klaviyo-API-Key.",
          })
        }
        const revision = context.request.headers.get("revision")
        if (!revision || !REVISION_PATTERN.test(revision.trim())) {
          return errorResponse({
            status: 400,
            code: "invalid",
            title: "Invalid input.",
            detail: revision
              ? `Invalid revision header: ${revision}.`
              : "Missing required header 'revision'.",
            source: { parameter: "revision" },
          })
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  /** Klaviyo serves `/api/events/` (trailing slash) and `/api/events` alike. */
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "")
      return this.service.fetch(new Request(url, request))
    }
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
  }

  events(): KlaviyoEvent[] {
    return this.state.events.list()
  }

  private resource(event: KlaviyoEvent) {
    const seconds = Math.floor(Date.parse(event.time) / 1000)
    return {
      type: "event",
      id: event.id,
      attributes: {
        timestamp: seconds,
        event_properties: {
          ...event.properties,
          ...(event.value !== null ? { $value: event.value } : {}),
          ...(event.uniqueId !== null ? { $event_id: event.uniqueId } : {}),
        },
        datetime: event.time.replace(/\.\d{3}Z$/, "+00:00"),
        uuid: uuidFrom(event.id),
      },
      relationships: {
        profile: { data: { type: "profile", id: event.profileId } },
        metric: { data: { type: "metric", id: event.metricId } },
      },
      links: { self: `${this.baseUrl}/api/events/${event.id}/` },
    }
  }

  private createEvent(context: OperationContext): Response {
    if (context.body.kind !== "json") {
      return invalid("Invalid JSON body.", "/data")
    }
    const issues = bodyIssues(context)
    const first = issues[0]
    if (first) return issueResponse(first)
    const attributes = (context.body.value as { data: { attributes: Attributes } }).data.attributes
    const identifiers = {
      id: attributes.profile.data.id?.trim() || undefined,
      email: attributes.profile.data.attributes?.email,
      phone_number: attributes.profile.data.attributes?.phone_number,
      external_id: attributes.profile.data.attributes?.external_id,
    }
    if (!Object.values(identifiers).some(Boolean)) {
      return invalid(
        "A profile identifier is required: one of id, email, phone_number or external_id.",
        "/data/attributes/profile/data",
      )
    }
    const nowIso = new Date(this.now()).toISOString()
    const sent = attributes.time ? Date.parse(attributes.time) : Number.NaN
    const time = Number.isNaN(sent) ? nowIso : new Date(sent).toISOString()
    const metric = attributes.metric.data.attributes.name
    const profile = this.state.resolveProfile(identifiers, nowIso)
    const uniqueId = attributes.unique_id ?? null
    const metricId = this.state.metricId(metric)
    if (uniqueId !== null) {
      const duplicate = this.state.events
        .list({
          where: (e) =>
            e.uniqueId === uniqueId && e.metricId === metricId && e.profileId === profile.id,
        })
        .at(0)
      if (duplicate) {
        return annotateResponse(new Response(null, { status: 202 }), {
          ids: { eventId: duplicate.id, profileId: profile.id },
        })
      }
    }
    const event: KlaviyoEvent = {
      id: this.state.nextId("event"),
      to: [profile.email, profile.phone_number, profile.id].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
      createdAt: nowIso,
      metric,
      metricId,
      profileId: profile.id,
      uniqueId,
      value: attributes.value ?? null,
      valueCurrency: attributes.value_currency ?? null,
      properties: attributes.properties,
      time,
    }
    this.state.events.record(event)
    return annotateResponse(new Response(null, { status: 202 }), {
      ids: { eventId: event.id, profileId: profile.id },
    })
  }
}

export type { KlaviyoRuntime, KlaviyoRuntimeOptions } from "./runtime.js"
export { createRuntime, KLAVIYO_PRESETS } from "./runtime.js"
