import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bearerToken,
  bodyIssues,
  bootSqlite,
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
import {
  type CalendarRecord,
  type ChannelRecord,
  type EventRecord,
  GoogleCalendarState,
  type Settings,
  type StoredEvent,
  type UserRecord,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type {
  CalendarRecord,
  ChannelRecord,
  EventRecord,
  Settings,
  StoredEvent,
  UserRecord,
} from "./state.js"
export { DEFAULT_SCOPE } from "./state.js"

export const GOOGLE_CALENDAR_NAMESPACE = "google-calendar"

/** One push notification, as the runtime delivers it to the channel's address. */
export type PushNotification = {
  channel: ChannelRecord
  state: "sync" | "exists" | "not_exists"
  messageNumber: number
}

export type GoogleCalendarAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  /** Called for every push notification; the runtime delivers it. */
  onPush?: (push: PushNotification) => void
  /** Called whenever the set of live channels changes (the runtime re-targets deliveries). */
  onChannels?: (channels: ChannelRecord[]) => void
}

const b64u = (value: string) =>
  toBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const fromB64u = (value: string): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64(value.replace(/-/g, "+").replace(/_/g, "/")),
    )
  } catch {
    return undefined
  }
}

const ACCESS_PREFIX = "ya29.mock."
const REFRESH_PREFIX = "1//mock."
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv"

const sign = (kind: string, email: string, issuedAt: number) =>
  opaqueToken(`gcal:${kind}:${email}:${issuedAt}`, 24)

export const issueAccessToken = (email: string, issuedAtSeconds: number) =>
  `${ACCESS_PREFIX}${b64u(email)}.${issuedAtSeconds}.${sign("access", email, issuedAtSeconds)}`

const issueRefreshToken = (email: string, issuedAtSeconds: number) =>
  `${REFRESH_PREFIX}${b64u(email)}.${issuedAtSeconds}.${sign("refresh", email, issuedAtSeconds)}`

/** `{email, issuedAt}` of a well-signed mock token, else undefined. */
export const parseToken = (
  token: string,
  kind: "access" | "refresh",
): { email: string; issuedAt: number } | undefined => {
  const prefix = kind === "access" ? ACCESS_PREFIX : REFRESH_PREFIX
  if (!token.startsWith(prefix)) return undefined
  const [encoded, issued, signature] = token.slice(prefix.length).split(".")
  const email = encoded ? fromB64u(encoded) : undefined
  const issuedAt = Number(issued)
  if (!email || !Number.isInteger(issuedAt) || signature !== sign(kind, email, issuedAt)) {
    return undefined
  }
  return { email, issuedAt }
}

/**
 * The Google account an access token was issued to (or the raw bearer): how credentials map
 * to namespaces. Token-endpoint calls carry no bearer and use the header or `/ns/` prefix.
 */
export const accessTokenCredential = (request: Request): string | undefined => {
  const token = bearerToken(request)
  if (!token) return undefined
  return parseToken(token, "access")?.email ?? token
}

/** Google's JSON API error envelope. */
export const googleError = (
  code: number,
  reason: string,
  message: string,
  extra: { domain?: string; status?: string; locationType?: string; location?: string } = {},
) => {
  const { domain = "global", status, ...rest } = extra
  return jsonRes(code, {
    error: {
      errors: [{ domain, reason, message, ...rest }],
      code,
      message,
      ...(status ? { status } : {}),
    },
  })
}

const oauthError = (status: number, error: string, description: string) =>
  jsonRes(status, { error, error_description: description })

/** The account a `4/mock-<local or email>` authorization code signs in. */
export const emailFromCode = (code: string): string | undefined => {
  const match = /^4\/mock-(.+)$/.exec(code)
  if (!match?.[1]) return undefined
  const who = decodeURIComponent(match[1])
  return who.includes("@") ? who : `${who}@example.com`
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const OPTIONAL_EVENT_FIELDS = [
  "summary",
  "description",
  "location",
  "extendedProperties",
  "attendees",
  "colorId",
  "transparency",
  "visibility",
  "recurrence",
  "source",
] as const

const timeOf = (value: unknown): number | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as { dateTime?: unknown; date?: unknown }
  const raw =
    typeof v.dateTime === "string" ? v.dateTime : typeof v.date === "string" ? v.date : undefined
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? Number.NaN : ms
}

type Paging = { offset: number; key: string }

/**
 * Stateful mock of Google Calendar v3 and Google OAuth. Tokens and authorization codes are
 * self-describing (`4/mock-alice` signs in alice@example.com), every account gets a primary
 * calendar on first use, and every event write bumps a change sequence that sync tokens and
 * push channels follow.
 */
export class GoogleCalendarAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: GoogleCalendarState
  private readonly service: Service
  private readonly now: () => number
  private readonly onPush: ((push: PushNotification) => void) | undefined
  private readonly onChannels: ((channels: ChannelRecord[]) => void) | undefined

  constructor(options: GoogleCalendarAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? GOOGLE_CALENDAR_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onPush = options.onPush
    this.onChannels = options.onChannels
    this.state = new GoogleCalendarState(sqlite, namespace, options.settings ?? {})
    const handlers = defineOperations<SupportedOperationId>({
      OAuthToken: (context) => this.token(context),
      OAuthRevoke: (context) => this.revoke(context),
      UserInfo: (context) => jsonRes(200, this.user(this.email(context))),
      CalendarListList: (context) => this.calendarList(context),
      CalendarsInsert: (context) => this.insertCalendar(context),
      EventsList: (context) => this.listEvents(context),
      EventsInsert: (context) => {
        const calendar = this.calendar(context)
        const event = this.createEvent(calendar, this.body(context))
        return annotateResponse(jsonRes(200, event), { ids: { eventId: event.id } })
      },
      EventsGet: (context) => {
        const stored = this.stored(context)
        return annotateResponse(jsonRes(200, stored.event), { ids: { eventId: stored.event.id } })
      },
      EventsUpdate: (context) => {
        const stored = this.stored(context)
        const event = this.updateEvent(stored, this.body(context))
        return annotateResponse(jsonRes(200, event), { ids: { eventId: event.id } })
      },
      EventsDelete: (context) => {
        const stored = this.stored(context)
        this.deleteEvent(stored)
        return annotateResponse(new Response(null, { status: 204 }), {
          ids: { eventId: stored.event.id },
        })
      },
      EventsWatch: (context) => this.watch(context),
      ChannelsStop: (context) => this.stop(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => googleError(404, "notFound", "Not Found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => this.authenticate(context),
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
    this.onChannels?.([])
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString()
  }

  // --- auth -------------------------------------------------------------------------------

  private authenticate(context: OperationContext): Response | undefined {
    const id = context.operation.operationId
    if (id === "OAuthToken" || id === "OAuthRevoke") return undefined
    const token = bearerToken(context.request)
    const parsed = token ? parseToken(token, "access") : undefined
    const valid =
      parsed !== undefined &&
      token !== undefined &&
      !this.state.spent.has(token) &&
      this.now() / 1000 < parsed.issuedAt + this.state.current().tokenTtlSeconds &&
      faultEffect(context.request, "token_expired") === undefined
    if (valid) return undefined
    if (id === "UserInfo") return oauthError(401, "invalid_request", "Invalid Credentials")
    return googleError(
      401,
      "authError",
      "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
      { status: "UNAUTHENTICATED", locationType: "header", location: "Authorization" },
    )
  }

  private email(context: OperationContext): string {
    return parseToken(bearerToken(context.request) ?? "", "access")?.email ?? ""
  }

  /** The account's userinfo profile (set through the admin plane, else derived from the email). */
  user(email: string): UserRecord {
    const stored = this.state.users.get(email)
    if (stored) return stored
    const local = email.split("@")[0] ?? email
    const [given = local, family = "Mock"] = local.split(/[._-]/)
    const digits = [...opaqueToken(`sub:${email}`, 21)].map((c) => String(c.charCodeAt(0) % 10))
    return {
      sub: `1${digits.join("").slice(1)}`,
      email,
      name: `${titleCase(given)} ${titleCase(family)}`,
      given_name: titleCase(given),
      family_name: titleCase(family),
      picture: `https://lh3.googleusercontent.com/a/mock-${b64u(email)}=s96-c`,
      email_verified: true,
    }
  }

  private form(context: OperationContext): Record<string, string> {
    const issues = bodyIssues(context, "application/x-www-form-urlencoded")
    if (issues.length > 0) {
      throw new HttpError(400, {
        error: "invalid_request",
        error_description: `Invalid request: ${issues.map((i) => `${i.path || "body"} ${i.message}`).join("; ")}`,
      })
    }
    return context.body.kind === "form" ? (context.body.value as Record<string, string>) : {}
  }

  private idToken(email: string, clientId: string, nowSeconds: number): string {
    const user = this.user(email)
    const header = b64u(JSON.stringify({ alg: "RS256", kid: "mockingbird", typ: "JWT" }))
    const payload = b64u(
      JSON.stringify({
        iss: "https://accounts.google.com",
        azp: clientId,
        aud: clientId,
        sub: user.sub,
        email,
        email_verified: true,
        name: user.name,
        picture: user.picture,
        given_name: user.given_name,
        family_name: user.family_name,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      }),
    )
    return `${header}.${payload}.${opaqueToken(`${header}.${payload}`, 43)}`
  }

  private token(context: OperationContext): Response {
    const form = this.form(context)
    const basic = basicAuth(context.request)
    const clientId = form.client_id ?? basic?.username
    const clientSecret = form.client_secret ?? basic?.password
    if (!clientId) {
      return oauthError(400, "invalid_request", "Could not determine client ID from request.")
    }
    const clients = this.state.current().clients
    if (
      clients.length > 0 &&
      !clients.some((c) => c.clientId === clientId && c.clientSecret === clientSecret)
    ) {
      return oauthError(401, "invalid_client", "Unauthorized")
    }
    if (faultEffect(context.request, "invalid_grant") !== undefined) {
      return oauthError(400, "invalid_grant", "Token has been expired or revoked.")
    }
    const nowSeconds = Math.floor(this.now() / 1000)
    const settings = this.state.current()
    if (form.grant_type === "authorization_code") {
      const code = form.code ?? ""
      const email = emailFromCode(code)
      if (!email) return oauthError(400, "invalid_grant", "Malformed auth code.")
      if (this.state.spent.has(code)) return oauthError(400, "invalid_grant", "Bad Request")
      this.state.spent.insert(code, { kind: "code" })
      this.ensurePrimary(email)
      return annotateResponse(
        jsonRes(200, {
          access_token: issueAccessToken(email, nowSeconds),
          expires_in: settings.tokenTtlSeconds,
          refresh_token: issueRefreshToken(email, nowSeconds),
          scope: settings.scope,
          token_type: "Bearer",
          id_token: this.idToken(email, clientId, nowSeconds),
        }),
        { ids: { account: email } },
      )
    }
    if (form.grant_type === "refresh_token") {
      const refresh = form.refresh_token ?? ""
      const parsed = parseToken(refresh, "refresh")
      if (!parsed || this.state.spent.has(refresh)) {
        return oauthError(400, "invalid_grant", "Token has been expired or revoked.")
      }
      return annotateResponse(
        jsonRes(200, {
          access_token: issueAccessToken(parsed.email, nowSeconds),
          expires_in: settings.tokenTtlSeconds,
          scope: settings.scope,
          token_type: "Bearer",
          id_token: this.idToken(parsed.email, clientId, nowSeconds),
        }),
        { ids: { account: parsed.email } },
      )
    }
    return oauthError(400, "unsupported_grant_type", `Invalid grant_type: ${form.grant_type ?? ""}`)
  }

  private revoke(context: OperationContext): Response {
    const token = context.url.searchParams.get("token") ?? ""
    const valid = parseToken(token, "access") ?? parseToken(token, "refresh")
    if (!valid || this.state.spent.has(token)) {
      return oauthError(400, "invalid_token", "Token expired or revoked")
    }
    this.state.spent.insert(token, { kind: "revoked" })
    return jsonRes(200, {})
  }

  // --- calendars --------------------------------------------------------------------------

  ensurePrimary(email: string): CalendarRecord {
    const existing = this.state.calendars.get(email)
    if (existing) return existing
    const calendar: CalendarRecord = {
      id: email,
      owner: email,
      summary: email,
      timeZone: "America/New_York",
      primary: true,
      resourceId: opaqueToken(`resource:${email}`, 27),
    }
    this.state.calendars.insert(email, calendar)
    return calendar
  }

  private calendar(context: OperationContext): CalendarRecord {
    const email = this.email(context)
    const id = context.params.calendarId ?? ""
    const calendar = this.resolveCalendar(email, id)
    if (!calendar) throw new HttpError(404, this.errorBody(404, "notFound", "Not Found"))
    return calendar
  }

  resolveCalendar(email: string, calendarId: string): CalendarRecord | undefined {
    if (calendarId === "primary" || calendarId === email) return this.ensurePrimary(email)
    const calendar = this.state.calendars.get(calendarId)
    return calendar && calendar.owner === email ? calendar : undefined
  }

  private errorBody(code: number, reason: string, message: string, domain = "global") {
    return { error: { errors: [{ domain, reason, message }], code, message } }
  }

  private paging(context: OperationContext): Paging {
    const params = new URLSearchParams(context.url.searchParams)
    params.delete("pageToken")
    params.sort()
    const key = opaqueToken(`${context.url.pathname}?${params}`, 12)
    const token = context.url.searchParams.get("pageToken")
    if (token === null) return { offset: 0, key }
    const decoded = fromB64u(token)
    let parsed: { o?: unknown; k?: unknown } | undefined
    try {
      parsed = decoded ? (JSON.parse(decoded) as { o?: unknown; k?: unknown }) : undefined
    } catch {
      parsed = undefined
    }
    if (!parsed || typeof parsed.o !== "number" || parsed.k !== key) {
      throw new HttpError(400, this.errorBody(400, "invalid", "Invalid Value"))
    }
    return { offset: parsed.o, key }
  }

  private calendarList(context: OperationContext): Response {
    const email = this.email(context)
    this.ensurePrimary(email)
    const paging = this.paging(context)
    const max = Math.min(250, Number(context.url.searchParams.get("maxResults") ?? 100) || 100)
    const all = this.state.calendars
      .list({ order: "oldest", where: (c) => c.owner === email })
      .map((r) => r.value)
    const page = all.slice(paging.offset, paging.offset + max)
    const more = paging.offset + max < all.length
    return jsonRes(200, {
      kind: "calendar#calendarList",
      etag: `"p${this.state.changeSeq()}"`,
      ...(more
        ? { nextPageToken: b64u(JSON.stringify({ o: paging.offset + max, k: paging.key })) }
        : { nextSyncToken: `mockcl_${b64u(email)}` }),
      items: page.map((c) => ({
        kind: "calendar#calendarListEntry",
        etag: `"${opaqueToken(`${c.id}:etag`, 10)}"`,
        id: c.id,
        summary: c.summary,
        ...(c.description ? { description: c.description } : {}),
        timeZone: c.timeZone,
        ...(c.primary ? { primary: true } : {}),
        accessRole: "owner",
        defaultReminders: [],
      })),
    })
  }

  private insertCalendar(context: OperationContext): Response {
    const email = this.email(context)
    const body = this.body(context)
    const id = `${this.state.ids.next("cal", 26).toLowerCase()}@group.calendar.google.com`
    const calendar: CalendarRecord = {
      id,
      owner: email,
      summary: String(body.summary),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      timeZone: typeof body.timeZone === "string" ? body.timeZone : "UTC",
      primary: false,
      resourceId: opaqueToken(`resource:${id}`, 27),
    }
    this.state.calendars.insert(id, calendar)
    return annotateResponse(
      jsonRes(200, {
        kind: "calendar#calendar",
        etag: `"${opaqueToken(`${id}:etag`, 10)}"`,
        id,
        summary: calendar.summary,
        ...(calendar.description ? { description: calendar.description } : {}),
        timeZone: calendar.timeZone,
        conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] },
      }),
      { ids: { calendarId: id } },
    )
  }

  // --- events -----------------------------------------------------------------------------

  private body(context: OperationContext): Record<string, unknown> {
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      const message = `Invalid value: ${issues.map((i) => `${i.path || "body"} ${i.message}`).join("; ")}`
      throw new HttpError(400, this.errorBody(400, "invalid", message))
    }
    return context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
  }

  private checkTimes(body: Record<string, unknown>): void {
    const start = timeOf(body.start)
    const end = timeOf(body.end)
    if (start === undefined)
      throw new HttpError(400, this.errorBody(400, "required", "Missing start time."))
    if (end === undefined)
      throw new HttpError(400, this.errorBody(400, "required", "Missing end time."))
    if (Number.isNaN(start))
      throw new HttpError(400, this.errorBody(400, "invalid", "Invalid start time."))
    if (Number.isNaN(end))
      throw new HttpError(400, this.errorBody(400, "invalid", "Invalid end time."))
    if (end < start) {
      throw new HttpError(
        400,
        this.errorBody(400, "timeRangeEmpty", "The specified time range is empty."),
      )
    }
  }

  private eventId(): string {
    return [...this.state.ids.next("evt", 26).slice(3)]
      .map((c) => BASE32HEX.charAt(c.charCodeAt(0) % 32))
      .join("")
  }

  private fields(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of OPTIONAL_EVENT_FIELDS) if (body[key] !== undefined) out[key] = body[key]
    return out
  }

  /** Create an event as the calendar's owner (the API, or an admin simulating the Google UI). */
  createEvent(calendar: CalendarRecord, body: Record<string, unknown>): EventRecord {
    this.checkTimes(body)
    const id = typeof body.id === "string" ? body.id : this.eventId()
    const key = this.state.eventKey(calendar.id, id)
    if (this.state.events.has(key)) {
      throw new HttpError(
        409,
        this.errorBody(409, "duplicate", "The requested identifier already exists."),
      )
    }
    const change = this.state.nextChange()
    const now = this.iso()
    const event: EventRecord = {
      kind: "calendar#event",
      etag: `"${3_000_000_000_000_000 + change}"`,
      id,
      status: typeof body.status === "string" ? body.status : "confirmed",
      htmlLink: `https://www.google.com/calendar/event?eid=${b64u(`${id} ${calendar.id}`)}`,
      created: now,
      updated: now,
      ...this.fields(body),
      creator: { email: calendar.owner, self: true },
      organizer: {
        email: calendar.id,
        ...(calendar.primary ? {} : { displayName: calendar.summary }),
        self: true,
      },
      start: body.start,
      end: body.end,
      iCalUID: `${id}@google.com`,
      sequence: 0,
      reminders: body.reminders ?? { useDefault: true },
      eventType: "default",
    }
    this.state.events.insert(key, { calendarId: calendar.id, event, changeSeq: change })
    this.notify(calendar.id)
    return event
  }

  private stored(context: OperationContext): StoredEvent {
    const calendar = this.calendar(context)
    const stored = this.state.events.get(
      this.state.eventKey(calendar.id, context.params.eventId ?? ""),
    )
    if (!stored) throw new HttpError(404, this.errorBody(404, "notFound", "Not Found"))
    return stored
  }

  findEvent(calendarId: string, eventId: string): StoredEvent | undefined {
    return this.state.events.get(this.state.eventKey(calendarId, eventId))
  }

  updateEvent(stored: StoredEvent, body: Record<string, unknown>): EventRecord {
    this.checkTimes(body)
    const change = this.state.nextChange()
    const previous = stored.event
    const moved =
      JSON.stringify([previous.start, previous.end]) !== JSON.stringify([body.start, body.end])
    const kept: Record<string, unknown> = {}
    for (const key of [
      "kind",
      "etag",
      "id",
      "htmlLink",
      "created",
      "creator",
      "organizer",
      "iCalUID",
      "eventType",
    ]) {
      kept[key] = previous[key]
    }
    const event = {
      ...kept,
      etag: `"${3_000_000_000_000_000 + change}"`,
      status: typeof body.status === "string" ? body.status : "confirmed",
      updated: this.iso(),
      ...this.fields(body),
      start: body.start,
      end: body.end,
      sequence: previous.sequence + (moved ? 1 : 0),
      reminders: body.reminders ?? { useDefault: true },
    } as unknown as EventRecord
    this.state.events.update(this.state.eventKey(stored.calendarId, previous.id), {
      calendarId: stored.calendarId,
      event,
      changeSeq: change,
    })
    this.notify(stored.calendarId)
    return event
  }

  deleteEvent(stored: StoredEvent): void {
    if (stored.event.status === "cancelled") {
      throw new HttpError(410, this.errorBody(410, "deleted", "Resource has been deleted"))
    }
    const change = this.state.nextChange()
    const event = {
      ...stored.event,
      etag: `"${3_000_000_000_000_000 + change}"`,
      status: "cancelled",
      updated: this.iso(),
    }
    this.state.events.update(this.state.eventKey(stored.calendarId, stored.event.id), {
      calendarId: stored.calendarId,
      event,
      changeSeq: change,
    })
    this.notify(stored.calendarId)
  }

  private syncToken(calendarId: string): string {
    return `mock_${b64u(JSON.stringify({ c: calendarId, s: this.state.changeSeq() }))}`
  }

  private listEvents(context: OperationContext): Response {
    const calendar = this.calendar(context)
    const params = context.url.searchParams
    const syncToken = params.get("syncToken")
    const bool = (key: string) => params.get(key) === "true"
    const max = Math.min(2500, Math.max(1, Number(params.get("maxResults") ?? 250) || 250))
    let rows = this.state.events
      .list({ order: "oldest", where: (e) => e.calendarId === calendar.id })
      .map((r) => r.value)
    if (syncToken !== null) {
      const conflicting = ["timeMin", "timeMax", "q", "orderBy", "updatedMin", "iCalUID"].filter(
        (k) => params.has(k),
      )
      if (conflicting.length > 0) {
        return googleError(
          400,
          "invalid",
          `Invalid parameters: syncToken cannot be combined with ${conflicting.join(", ")}.`,
        )
      }
      const decoded = fromB64u(syncToken.replace(/^mock_/, ""))
      let parsed: { c?: unknown; s?: unknown } | undefined
      try {
        parsed =
          syncToken.startsWith("mock_") && decoded
            ? (JSON.parse(decoded) as { c?: unknown; s?: unknown })
            : undefined
      } catch {
        parsed = undefined
      }
      const gone =
        faultEffect(context.request, "sync_token_gone") !== undefined ||
        !parsed ||
        parsed.c !== calendar.id ||
        typeof parsed.s !== "number" ||
        parsed.s < this.state.current().syncTokensValidFrom
      if (gone) {
        return googleError(
          410,
          "fullSyncRequired",
          "Sync token is no longer valid, a full sync is required.",
          {
            domain: "calendar",
          },
        )
      }
      const since = parsed?.s as number
      rows = rows.filter((e) => e.changeSeq > since).sort((a, b) => a.changeSeq - b.changeSeq)
    } else {
      const orderBy = params.get("orderBy")
      if (orderBy === "startTime" && !bool("singleEvents")) {
        return googleError(
          400,
          "invalid",
          "The requested ordering is not available for the particular query.",
        )
      }
      const timeMin = params.get("timeMin")
      const timeMax = params.get("timeMax")
      const updatedMin = params.get("updatedMin")
      const q = params.get("q")?.toLowerCase()
      const bound = (value: string | null, name: string) => {
        if (value === null) return undefined
        const ms = Date.parse(value)
        if (Number.isNaN(ms))
          throw new HttpError(400, this.errorBody(400, "invalid", `Bad Request: invalid ${name}`))
        return ms
      }
      const min = bound(timeMin, "timeMin")
      const maxTime = bound(timeMax, "timeMax")
      const updated = bound(updatedMin, "updatedMin")
      rows = rows.filter(({ event }) => {
        if (event.status === "cancelled" && !bool("showDeleted")) return false
        const start = timeOf(event.start) ?? 0
        const end = timeOf(event.end) ?? start
        if (min !== undefined && end <= min) return false
        if (maxTime !== undefined && start >= maxTime) return false
        if (updated !== undefined && Date.parse(event.updated) < updated) return false
        if (q) {
          const text = [event.summary, event.description, event.location]
            .filter((v) => typeof v === "string")
            .join(" ")
            .toLowerCase()
          if (!text.includes(q)) return false
        }
        return true
      })
      if (orderBy === "startTime")
        rows.sort((a, b) => (timeOf(a.event.start) ?? 0) - (timeOf(b.event.start) ?? 0))
      if (orderBy === "updated")
        rows.sort((a, b) => Date.parse(a.event.updated) - Date.parse(b.event.updated))
    }
    const paging = this.paging(context)
    const page = rows.slice(paging.offset, paging.offset + max)
    const more = paging.offset + max < rows.length
    const syncable = !["q", "orderBy", "updatedMin"].some((k) => params.has(k))
    const items = page.map(({ event }) =>
      event.status === "cancelled" && syncToken !== null
        ? { kind: event.kind, etag: event.etag, id: event.id, status: "cancelled" }
        : event,
    )
    return annotateResponse(
      jsonRes(200, {
        kind: "calendar#events",
        etag: `"p${this.state.changeSeq()}"`,
        summary: calendar.summary,
        updated: page.at(-1)?.event.updated ?? this.iso(),
        timeZone: calendar.timeZone,
        accessRole: "owner",
        defaultReminders: [{ method: "popup", minutes: 10 }],
        ...(more
          ? { nextPageToken: b64u(JSON.stringify({ o: paging.offset + max, k: paging.key })) }
          : {}),
        ...(!more && syncable ? { nextSyncToken: this.syncToken(calendar.id) } : {}),
        items,
      }),
      { ids: { calendarId: calendar.id } },
    )
  }

  // --- push channels ----------------------------------------------------------------------

  private liveChannels(): ChannelRecord[] {
    return this.state.channels
      .list({ order: "oldest", where: (c) => !c.stopped && c.expirationMs > this.now() })
      .map((r) => r.value)
  }

  private push(channel: ChannelRecord, state: PushNotification["state"]): void {
    const next = { ...channel, messageNumber: channel.messageNumber + 1 }
    this.state.channels.update(channel.id, next)
    this.onPush?.({ channel: next, state, messageNumber: next.messageNumber })
  }

  /** Send `exists` to every live channel on a calendar (after any change to its events). */
  notify(calendarId: string): void {
    for (const channel of this.liveChannels()) {
      if (channel.calendarId === calendarId) this.push(channel, "exists")
    }
  }

  private watch(context: OperationContext): Response {
    const calendar = this.calendar(context)
    const body = this.body(context)
    const settings = this.state.current()
    const address = String(body.address)
    let url: URL | undefined
    try {
      url = new URL(address)
    } catch {
      url = undefined
    }
    if (!url || (settings.requireHttpsWebhooks && url.protocol !== "https:")) {
      return googleError(
        400,
        "push.webhookUrlNotHttps",
        `WebHook callback must be HTTPS: ${address}`,
        { domain: "push" },
      )
    }
    const id = String(body.id)
    const existing = this.state.channels.get(id)
    if (existing && !existing.stopped) {
      return googleError(400, "channelIdNotUnique", `Channel id ${id} not unique`, {
        domain: "push",
      })
    }
    const requested = typeof body.expiration === "string" ? Number(body.expiration) : undefined
    const cap = this.now() + settings.maxChannelTtlSeconds * 1000
    const expirationMs = Math.min(
      requested && requested > this.now() ? requested : this.now() + 7 * 86_400_000,
      cap,
    )
    const channel: ChannelRecord = {
      id,
      resourceId: calendar.resourceId,
      calendarId: calendar.id,
      owner: calendar.owner,
      address,
      token: typeof body.token === "string" ? body.token : null,
      expirationMs,
      messageNumber: 0,
      stopped: false,
      resourceUri: `${context.url.origin}/calendar/v3/calendars/${encodeURIComponent(context.params.calendarId ?? "")}/events?alt=json`,
    }
    this.state.channels.insert(id, channel)
    this.onChannels?.(this.liveChannels())
    this.push(channel, "sync")
    return annotateResponse(
      jsonRes(200, {
        kind: "api#channel",
        id,
        resourceId: channel.resourceId,
        resourceUri: channel.resourceUri,
        ...(channel.token ? { token: channel.token } : {}),
        expiration: String(expirationMs),
      }),
      { ids: { channelId: id } },
    )
  }

  private stop(context: OperationContext): Response {
    const body = this.body(context)
    const channel = this.state.channels.get(String(body.id))
    if (!channel || channel.stopped || channel.resourceId !== body.resourceId) {
      return googleError(
        404,
        "notFound",
        `Channel '${String(body.id)}' not found for project 'mockingbird'`,
      )
    }
    this.state.channels.update(channel.id, { ...channel, stopped: true })
    this.onChannels?.(this.liveChannels())
    return annotateResponse(new Response(null, { status: 204 }), { ids: { channelId: channel.id } })
  }

  channels(): ChannelRecord[] {
    return this.state.channels.list({ order: "oldest" }).map((r) => r.value)
  }

  events(email?: string): StoredEvent[] {
    return this.state.events
      .list({
        order: "oldest",
        where: (e) =>
          email === undefined || this.state.calendars.get(e.calendarId)?.owner === email,
      })
      .map((r) => r.value)
  }

  /** Make every sync token issued so far answer 410 fullSyncRequired. */
  invalidateSyncTokens(): Settings {
    return this.state.update({ syncTokensValidFrom: this.state.nextChange() })
  }
}

export type { GoogleCalendarRuntime, GoogleCalendarRuntimeOptions } from "./runtime.js"
export { createRuntime, GOOGLE_CALENDAR_PRESETS, pushHeaders } from "./runtime.js"
