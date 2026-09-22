import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  coerce,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { RESULT_PDF } from "./pdf.js"
import {
  DEFAULT_PRACTITIONER,
  type EventRecord,
  FullscriptState,
  type LabOrderRecord,
  type LabOrderState,
  type Practitioner,
  type Settings,
  stateRank,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { RESULT_PDF } from "./pdf.js"
export type {
  Clinic,
  EventRecord,
  LabOrderRecord,
  LabOrderState,
  Practitioner,
  Settings,
} from "./state.js"
export {
  DEFAULT_CLINIC,
  DEFAULT_PRACTITIONER,
  isLabOrderState,
  LAB_ORDER_STATES,
} from "./state.js"

export const FULLSCRIPT_NAMESPACE = "fullscript"
const SCOPE = "clinic:read labs:read labs:write patients:read"
const TOKEN_PREFIX = "fsat_"

/** Fullscript API errors: `{errors: [{code, message}]}`. */
export const apiErrors = (status: number, code: string, message: string) =>
  jsonRes(status, { errors: [{ code, message }] })

/** Doorkeeper OAuth errors: `{error, error_description}`. */
export const oauthError = (status: number, error: string, description: string) =>
  jsonRes(status, { error, error_description: description })

const INVALID_GRANT =
  "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client."
const INVALID_CLIENT =
  "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method."

const base64url = (value: string) =>
  toBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const fromBase64url = (value: string) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64(value.replace(/-/g, "+").replace(/_/g, "/")),
    )
  } catch {
    return undefined
  }
}

type TokenClaims = {
  clientId: string
  practitionerId: string
  clinicId: string
  type: Practitioner["type"]
}

const sign = (payload: string, issuedAt: number) =>
  opaqueToken(`fullscript:${payload}:${issuedAt}`, 32)

/** Access tokens are self-describing and signed, so any instance can verify them. */
export const issueAccessToken = (claims: TokenClaims, issuedAtSeconds: number) => {
  const payload = base64url(
    JSON.stringify([claims.clientId, claims.practitionerId, claims.clinicId, claims.type]),
  )
  return `${TOKEN_PREFIX}${payload}.${issuedAtSeconds}.${sign(payload, issuedAtSeconds)}`
}

const readAccessToken = (token: string): (TokenClaims & { issuedAt: number }) | undefined => {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined
  const [payload, issued, signature] = token.slice(TOKEN_PREFIX.length).split(".")
  const issuedAt = Number(issued)
  if (!payload || !Number.isInteger(issuedAt) || signature !== sign(payload, issuedAt))
    return undefined
  const decoded = fromBase64url(payload)
  try {
    const [clientId, practitionerId, clinicId, type] = JSON.parse(decoded ?? "") as string[]
    if (!clientId || !practitionerId || !clinicId) return undefined
    return {
      clientId,
      practitionerId,
      clinicId,
      type: type === "Staff" ? "Staff" : "Practitioner",
      issuedAt,
    }
  } catch {
    return undefined
  }
}

/** The OAuth client an access token was issued to (how credentials map to namespaces). */
export const tokenCredential = (request: Request): string | undefined => {
  const token = bearerToken(request)
  return token ? (readAccessToken(token)?.clientId ?? token) : undefined
}

/** A lab order to start a namespace with, walked forward to `state` (events included). */
export type SeedOrder = {
  id: string
  patientId: string
  state: LabOrderState
  clinicId?: string
  treatmentPlanId?: string | null
  name?: string
  collectionMethod?: string
  tests?: string[]
}

export type FullscriptAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  orders?: readonly SeedOrder[]
  /** The public namespace, so result PDF URLs carry a `/ns/<name>` prefix. */
  publicNamespace?: string
  /** Called for every event; the runtime signs and delivers it. */
  onEvent?: (event: EventRecord) => void
}

/** An event as the events API returns it. */
export const publicEvent = (event: EventRecord) => ({
  id: event.id,
  type: event.type,
  clinic_id: event.clinic_id,
  created_at: event.created_at,
  data: event.data,
})

/** The webhook body Fullscript posts for an event: `{event_payload: {event}}`. */
export const envelope = (event: EventRecord) => ({ event_payload: { event: publicEvent(event) } })

const page = (context: OperationContext) => {
  const q = context.query as Record<string, unknown>
  const block = (q.page ?? {}) as Record<string, unknown>
  const number = coerce.integer(block.number ?? "1")
  const size = coerce.integer(block.size ?? "20")
  return {
    number: number.ok && number.value > 0 ? number.value : 1,
    size: size.ok && size.value > 0 ? Math.min(size.value, 100) : 20,
  }
}

const meta = (current: number, size: number, total: number) => {
  const totalPages = Math.max(1, Math.ceil(total / size))
  return {
    current_page: current,
    next_page: current < totalPages ? current + 1 : null,
    prev_page: current > 1 ? current - 1 : null,
    total_pages: totalPages,
    total_count: total,
  }
}

/**
 * Stateful mock of the Fullscript lab-ordering API. Practitioners connect through OAuth;
 * lab orders move forward only through admin transitions, each emitting a `lab_order.updated`
 * event (and `order.placed` on purchase) readable through the events API and delivered as a
 * signed webhook. Results appear with the results-bearing states, as expiring PDF URLs.
 */
export class FullscriptAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: FullscriptState
  private readonly service: Service
  private readonly now: () => number
  private readonly prefix: string
  private readonly onEvent: ((event: EventRecord) => void) | undefined

  constructor(options: FullscriptAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? FULLSCRIPT_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onEvent = options.onEvent
    this.prefix =
      options.publicNamespace && options.publicNamespace !== "default"
        ? `/ns/${encodeURIComponent(options.publicNamespace)}`
        : ""
    this.state = new FullscriptState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      OAuthToken: (context) => this.token(context),
      OAuthRevoke: (context) => this.revoke(context),
      GetClinic: (context) => {
        const claims = this.claims(context)
        const clinic = this.state.clinics.get(claims.clinicId)
        if (!clinic) return apiErrors(404, "not_found", "Clinic not found")
        return jsonRes(200, { clinic })
      },
      CreateSessionGrant: (context) => {
        const claims = this.claims(context)
        const expires = this.now() + 5 * 60_000
        return jsonRes(201, {
          secret_token: `sg_${opaqueToken(`${claims.practitionerId}:${this.now()}`, 40)}`,
          expires_at: new Date(expires).toISOString(),
        })
      },
      ListLabOrders: (context) => {
        const claims = this.claims(context)
        const patient =
          typeof context.query.patient_id === "string" ? context.query.patient_id : undefined
        const rows = this.state.orders
          .list({
            order: "oldest",
            where: (o) => o.clinicId === claims.clinicId && (!patient || o.patientId === patient),
          })
          .map((r) => r.value)
        const p = page(context)
        return jsonRes(200, {
          orders: rows
            .slice((p.number - 1) * p.size, p.number * p.size)
            .map((o) => this.summary(o)),
          meta: meta(p.number, p.size, rows.length),
        })
      },
      GetLabOrder: (context) => {
        const claims = this.claims(context)
        const order = this.state.orders.get(context.params.orderId ?? "")
        if (!order || order.clinicId !== claims.clinicId)
          return apiErrors(404, "not_found", "Lab order not found")
        return annotateResponse(jsonRes(200, { order: this.detail(order, context) }), {
          ids: { orderId: order.id },
        })
      },
      ListLabOrderEvents: (context) => {
        const claims = this.claims(context)
        const ascending = context.query.order_by === "ASC"
        const rows = this.state.events
          .list({
            order: ascending ? "oldest" : "newest",
            where: (e) => e.clinic_id === claims.clinicId && e.type === "lab_order.updated",
          })
          .map((r) => r.value)
        const p = page(context)
        const drift = faultEffect(context.request, "events_schema_drift") !== undefined
        return jsonRes(200, {
          events: rows.slice((p.number - 1) * p.size, p.number * p.size).map((e) => ({
            id: e.id,
            type: drift ? "lab_order.changed" : e.type,
            clinic_id: e.clinic_id,
            created_at: e.created_at,
          })),
          meta: meta(p.number, p.size, rows.length),
        })
      },
      GetEvent: (context) => {
        const claims = this.claims(context)
        const event = this.state.events.get(context.params.eventId ?? "")
        if (!event || event.clinic_id !== claims.clinicId)
          return apiErrors(404, "not_found", "Event not found")
        return jsonRes(200, { event: this.publicEvent(event) })
      },
      Authorize: (context) => this.authorize(context),
      GetResultPdf: (context) => this.pdf(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => apiErrors(404, "not_found", "Not Found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        const id = context.operation.operationId
        if (
          id === "OAuthToken" ||
          id === "OAuthRevoke" ||
          id === "Authorize" ||
          id === "GetResultPdf"
        ) {
          return undefined
        }
        const token = bearerToken(context.request)
        if (!token)
          return apiErrors(401, "unauthorized", "You need to sign in or authenticate first")
        if (faultEffect(context.request, "token_expired") !== undefined) {
          return apiErrors(401, "token_expired", "The access token expired")
        }
        const claims = readAccessToken(token)
        if (!claims || this.state.revoked.has(token)) {
          return apiErrors(401, "invalid_token", "The access token is invalid")
        }
        if (this.now() / 1000 >= claims.issuedAt + this.state.current().accessTokenTtlSeconds) {
          return apiErrors(401, "token_expired", "The access token expired")
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
    for (const seed of options.orders ?? []) this.seedOrder(seed)
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

  private claims(context: OperationContext): TokenClaims {
    return readAccessToken(bearerToken(context.request) ?? "") as TokenClaims
  }

  private clientOk(clientId: unknown, secret: unknown): boolean {
    const clients = this.state.current().clients
    if (typeof clientId !== "string" || typeof secret !== "string" || !clientId || !secret)
      return false
    return (
      clients.length === 0 ||
      clients.some((c) => c.clientId === clientId && c.clientSecret === secret)
    )
  }

  private body(context: OperationContext): Record<string, unknown> {
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      throw new HttpError(400, {
        error: "invalid_request",
        error_description: `The request is missing a required parameter or is otherwise malformed: ${issues.map((i) => `${i.path || "body"} ${i.message}`).join("; ")}`,
      })
    }
    return context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
  }

  /** Mint an authorization code for a practitioner (what the consent page does). */
  issueCode(practitionerId: string, clientId: string, redirectUri: string | null): string {
    const code = `code_${opaqueToken(`${practitionerId}:${this.state.next("code")}`, 32)}`
    this.state.codes.insert(code, {
      code,
      practitionerId,
      clientId,
      redirectUri,
      expiresAtMs: this.now() + this.state.current().codeTtlSeconds * 1000,
      used: false,
    })
    return code
  }

  private tokenPair(practitioner: Practitioner, clientId: string) {
    const refresh = `fsrt_${opaqueToken(`${practitioner.id}:${this.state.next("refresh")}`, 40)}`
    this.state.refresh.insert(refresh, {
      token: refresh,
      practitionerId: practitioner.id,
      clientId,
      revoked: false,
    })
    const issuedAt = Math.floor(this.now() / 1000)
    return jsonRes(200, {
      oauth: {
        access_token: issueAccessToken(
          {
            clientId,
            practitionerId: practitioner.id,
            clinicId: practitioner.clinicId,
            type: practitioner.type,
          },
          issuedAt,
        ),
        token_type: "Bearer",
        expires_in: this.state.current().accessTokenTtlSeconds,
        refresh_token: refresh,
        scope: SCOPE,
        created_at: new Date(issuedAt * 1000).toISOString(),
        resource_owner: {
          id: practitioner.id,
          type: practitioner.type,
          clinic_id: practitioner.clinicId,
        },
      },
    })
  }

  private token(context: OperationContext): Response {
    const body = this.body(context)
    const clientId = String(body.client_id)
    if (!this.clientOk(body.client_id, body.client_secret))
      return oauthError(401, "invalid_client", INVALID_CLIENT)
    if (body.grant_type === "authorization_code") {
      if (typeof body.code !== "string" || !body.code) {
        return oauthError(400, "invalid_request", "Missing required parameter: code.")
      }
      const code = this.state.codes.get(body.code)
      if (
        !code ||
        code.used ||
        code.clientId !== clientId ||
        this.now() > code.expiresAtMs ||
        (code.redirectUri !== null && body.redirect_uri !== code.redirectUri)
      ) {
        return oauthError(400, "invalid_grant", INVALID_GRANT)
      }
      this.state.codes.update(code.code, { ...code, used: true })
      const practitioner = this.state.practitioners.get(code.practitionerId) ?? DEFAULT_PRACTITIONER
      return this.tokenPair(practitioner, clientId)
    }
    if (typeof body.refresh_token !== "string" || !body.refresh_token) {
      return oauthError(400, "invalid_request", "Missing required parameter: refresh_token.")
    }
    if (faultEffect(context.request, "invalid_grant") !== undefined) {
      return oauthError(400, "invalid_grant", INVALID_GRANT)
    }
    const refresh = this.state.refresh.get(body.refresh_token)
    if (!refresh || refresh.revoked || refresh.clientId !== clientId) {
      return oauthError(400, "invalid_grant", INVALID_GRANT)
    }
    // Refresh tokens rotate: the presented one is spent.
    this.state.refresh.update(refresh.token, { ...refresh, revoked: true })
    const practitioner =
      this.state.practitioners.get(refresh.practitionerId) ?? DEFAULT_PRACTITIONER
    return this.tokenPair(practitioner, clientId)
  }

  private revoke(context: OperationContext): Response {
    const body = this.body(context)
    if (!this.clientOk(body.client_id, body.client_secret))
      return oauthError(401, "invalid_client", INVALID_CLIENT)
    const token = String(body.token)
    const refresh = this.state.refresh.get(token)
    if (refresh) this.state.refresh.update(token, { ...refresh, revoked: true })
    else if (readAccessToken(token)) this.state.revoked.insert(token, { token })
    return jsonRes(200, {})
  }

  private authorize(context: OperationContext): Response {
    const url = context.url
    const redirect = url.searchParams.get("redirect_uri")
    const clientId = url.searchParams.get("client_id")
    if (!redirect || !clientId || url.searchParams.get("response_type") !== "code") {
      return oauthError(
        400,
        "invalid_request",
        "client_id, redirect_uri and response_type=code are required.",
      )
    }
    const practitionerId = url.searchParams.get("practitioner_id") ?? DEFAULT_PRACTITIONER.id
    if (!this.state.practitioners.get(practitionerId)) {
      return oauthError(400, "invalid_request", `Unknown practitioner ${practitionerId}.`)
    }
    const code = this.issueCode(practitionerId, clientId, redirect)
    const location = new URL(redirect)
    location.searchParams.set("code", code)
    const state = url.searchParams.get("state")
    if (state !== null) location.searchParams.set("state", state)
    return new Response(null, { status: 302, headers: { location: location.toString() } })
  }

  private summary(order: LabOrderRecord) {
    return {
      id: order.id,
      state: order.state,
      treatment_plan_id: order.treatmentPlanId,
      patient_id: order.patientId,
      name: order.name,
      created_at: order.created_at,
      updated_at: order.updated_at,
    }
  }

  /** A signed, expiring URL for a result artifact, on the mock itself (or `resultsBaseUrl`). */
  private pdfUrl(artifactId: string, context: OperationContext): string {
    const base = this.state.current().resultsBaseUrl ?? `${context.url.origin}${this.prefix}`
    const expires = this.now() + this.state.current().pdfUrlTtlSeconds * 1000
    return `${base.replace(/\/$/, "")}/results/${artifactId}?expires=${expires}&signature=${opaqueToken(`${artifactId}:${expires}`, 24)}`
  }

  private detail(order: LabOrderRecord, context: OperationContext) {
    return {
      ...this.summary(order),
      collection_method: order.collectionMethod,
      tests: order.tests,
      results: order.results.map((r) => ({
        id: r.id,
        name: r.name,
        state: r.state,
        pdf_url: this.pdfUrl(r.artifactId, context),
      })),
      latest_aggregated_result: order.aggregated
        ? {
            id: order.aggregated.id,
            artifact_id: order.aggregated.artifactId,
            pdf_url: this.pdfUrl(order.aggregated.artifactId, context),
            status: order.aggregated.status,
          }
        : null,
    }
  }

  private pdf(context: OperationContext): Response {
    const artifactId = context.params.artifactId ?? ""
    const expires = Number(context.url.searchParams.get("expires"))
    const signature = context.url.searchParams.get("signature")
    if (signature !== opaqueToken(`${artifactId}:${expires}`, 24)) {
      return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } })
    }
    if (this.now() > expires)
      return new Response("Expired", { status: 403, headers: { "content-type": "text/plain" } })
    const known = this.state.orders
      .list()
      .some(
        ({ value: o }) =>
          o.aggregated?.artifactId === artifactId ||
          o.results.some((r) => r.artifactId === artifactId),
      )
    if (!known) return new Response(null, { status: 404 })
    return new Response(new Blob([RESULT_PDF as BlobPart]), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(RESULT_PDF.byteLength),
      },
    })
  }

  private publicEvent(event: EventRecord) {
    return {
      id: event.id,
      type: event.type,
      clinic_id: event.clinic_id,
      created_at: event.created_at,
      data: event.data,
    }
  }

  private emit(
    type: EventRecord["type"],
    order: LabOrderRecord,
    data: Record<string, unknown>,
  ): EventRecord {
    const seq = this.state.next("event")
    const event: EventRecord = {
      id: `evt_${seq}`,
      type,
      clinic_id: order.clinicId,
      created_at: this.iso(),
      data,
      seq,
    }
    this.state.events.insert(event.id, event)
    this.onEvent?.(event)
    return event
  }

  /** Create a lab order in `not_purchased` (a practitioner recommended labs in a treatment plan). */
  createOrder(input: Omit<SeedOrder, "state" | "id"> & { id?: string }): LabOrderRecord {
    const id = input.id ?? `lo_${this.state.next("order")}`
    const now = this.iso()
    const order: LabOrderRecord = {
      id,
      clinicId: input.clinicId ?? DEFAULT_PRACTITIONER.clinicId,
      patientId: input.patientId,
      treatmentPlanId: input.treatmentPlanId === undefined ? `tp_${id}` : input.treatmentPlanId,
      name: input.name ?? "Comprehensive Wellness Panel",
      collectionMethod: input.collectionMethod ?? "at_home_phlebotomy",
      state: "not_purchased",
      tests: (input.tests ?? ["Lipid Panel", "Comprehensive Metabolic Panel"]).map((name, i) => ({
        id: `lt_${id}_${i + 1}`,
        name,
        lab_type: "labs",
      })),
      results: [],
      aggregated: null,
      created_at: now,
      updated_at: now,
    }
    this.state.orders.insert(id, order)
    return order
  }

  /**
   * Move an order forward (never back) and emit its events: `order.placed` on purchase and
   * `lab_order.updated` for every move. Results-bearing states attach result artifacts.
   */
  transition(orderId: string, to: LabOrderState): LabOrderRecord {
    const order = this.state.orders.get(orderId)
    if (!order)
      throw new HttpError(404, {
        error: { type: "mockingbird_admin", message: `no lab order ${orderId}` },
      })
    if (stateRank(to) <= stateRank(order.state)) {
      throw new HttpError(409, {
        error: {
          type: "mockingbird_admin",
          message: `lab orders only move forward: ${order.state} → ${to} is not allowed`,
        },
      })
    }
    const artifact = () => `art_${opaqueToken(`${order.id}:${this.state.next("artifact")}`, 16)}`
    const next: LabOrderRecord = { ...order, state: to, updated_at: this.iso() }
    const rank = stateRank(to)
    if (rank >= stateRank("partial_results")) {
      const wanted = rank >= stateRank("results_ready") ? next.tests.length : 1
      const results = [...next.results]
      for (const test of next.tests.slice(results.length, wanted)) {
        results.push({
          id: `res_${test.id}`,
          name: test.name,
          state: "final",
          artifactId: artifact(),
        })
      }
      next.results = results
    }
    if (rank >= stateRank("results_ready") && (!next.aggregated || to === "results_amended")) {
      next.aggregated = {
        id: `agg_${order.id}${to === "results_amended" ? "_amended" : ""}`,
        artifactId: artifact(),
        status: to === "results_amended" ? "amended" : "final",
      }
    }
    this.state.orders.update(order.id, next)
    if (to === "purchased" || (order.state === "not_purchased" && rank > stateRank("purchased"))) {
      this.emit("order.placed", next, {
        id: next.id,
        treatment_plan_ids: next.treatmentPlanId ? [next.treatmentPlanId] : [],
        patient_id: next.patientId,
        line_items: [{ type: "labs", lab_type: "labs", name: next.name }],
      })
    }
    this.emit("lab_order.updated", next, {
      lab_order: {
        id: next.id,
        state: next.state,
        treatment_plan_id: next.treatmentPlanId,
        patient_id: next.patientId,
      },
    })
    return next
  }

  seedOrder(seed: SeedOrder): LabOrderRecord {
    const order = this.state.orders.get(seed.id) ?? this.createOrder(seed)
    return seed.state === order.state ? order : this.transition(order.id, seed.state)
  }

  labOrders(): LabOrderRecord[] {
    return this.state.orders.list({ order: "oldest" }).map((r) => r.value)
  }

  eventsList(): EventRecord[] {
    return this.state.events.list({ order: "oldest" }).map((r) => r.value)
  }
}

export type { FullscriptRuntime, FullscriptRuntimeOptions } from "./runtime.js"
export { createRuntime, FULLSCRIPT_PRESETS, SIGNATURE_HEADER } from "./runtime.js"
