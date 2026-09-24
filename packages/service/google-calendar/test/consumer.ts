/**
 * A port of our EMR backend's Google integration, on the real SDK stack it runs:
 * `@googleapis/calendar@9.8.0` (the calendar client inside `googleapis@149`, on the same
 * googleapis-common 7 / gaxios 6) and `google-auth-library@9.15.0`.
 *
 * - `src/services/google-calendar-service.ts`: the EMR calendar
 *   get-or-create, `fetchCalendarEvents` (410 → full-sync fallback), EMR appointment create /
 *   update / find / delete, webhook channel register (watch, then stop the previous channel),
 *   unregister, token refresh and revoke.
 * - `src/business/authorize/authorize.business.ts`: the authorization
 *   code exchange (`redirect_uri: postmessage`) and the userinfo fetch.
 * - `src/routers/v1/webhooks/controller.ts`: the push receiver.
 *
 * Seams only: the calendar client gets `rootUrl` (the app passes none), the OAuth2 client gets
 * `endpoints` (token / revoke URLs), and userinfo's hardcoded
 * `https://www.googleapis.com/oauth2/v3/userinfo` becomes `<root>/oauth2/v3/userinfo`.
 * We use `@googleapis/calendar` rather than `googleapis` because the full package is ~125 MB
 * unpacked; the calendar module is the same generated code (~0.5 MB).
 */
import { auth, calendar, type calendar_v3 } from "@googleapis/calendar"
import { OAuth2Client } from "google-auth-library"

export type CalendarType = "primary" | "emr"

export type GoogleCalendarEvent = {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  source: "google"
  description?: string
  location?: string
  htmlLink?: string
}

export type EMRAppointmentSyncData = {
  medplumAppointmentId: string
  practitionerId: string
  appointmentName?: string
  serviceType?: string
  status: string
  start: string
  end: string
  location?: string
}

/** nodeEnv "test" → the local prefixes and calendar name, as in our non-production stacks. */
export const EMR_EVENT_PREFIX = "EMR-local-"
export const EMR_CALENDAR_NAME = "EMR Appointments (Local)"
const EMR_METADATA_KEY = "emrAppointmentId"
const WEBHOOK_EXPIRATION_DAYS = 30

export const isEMROriginatedEvent = (event: calendar_v3.Schema$Event): boolean =>
  (event.summary ?? "").startsWith(EMR_EVENT_PREFIX) ||
  event.extendedProperties?.private?.[EMR_METADATA_KEY] !== undefined

export class GoogleCalendarConsumer {
  readonly logs: { level: string; message: string; fields?: Record<string, unknown> }[] = []

  constructor(
    private readonly rootUrl: string,
    private readonly env: {
      clientId: string
      clientSecret: string
      primaryWebhookUrl: string
      emrWebhookUrl: string
    },
  ) {}

  private log(level: string, message: string, fields?: Record<string, unknown>) {
    this.logs.push({ level, message, ...(fields ? { fields } : {}) })
  }

  private oauth(): OAuth2Client {
    return new OAuth2Client({
      clientId: this.env.clientId,
      clientSecret: this.env.clientSecret,
      redirectUri: "postmessage",
      endpoints: {
        oauth2TokenUrl: `${this.rootUrl}/token`,
        oauth2RevokeUrl: `${this.rootUrl}/revoke`,
      },
    })
  }

  /** `new this.googleApi.auth.OAuth2(); setCredentials; calendar({version: 'v3', auth})`. */
  private calendar(accessToken: string): calendar_v3.Calendar {
    const client = new auth.OAuth2()
    client.setCredentials({ access_token: accessToken })
    return calendar({ version: "v3", auth: client, rootUrl: `${this.rootUrl}/` })
  }

  /** `exchangeGoogleToken`: the code flow's token exchange. */
  async exchangeGoogleToken(code: string) {
    const tokenResponse = await this.oauth().getToken(code)
    const tokens = tokenResponse.tokens
    if (!tokens.id_token) throw new Error("No ID token received from Google")
    return {
      idToken: tokens.id_token,
      ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.expiry_date && tokens.expiry_date > Date.now()
        ? { expiresIn: Math.floor((tokens.expiry_date - Date.now()) / 1000) }
        : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    }
  }

  /** `getUserInfoFromGoogle`. */
  async getUserInfoFromGoogle(accessToken: string) {
    const response = await fetch(`${this.rootUrl}/oauth2/v3/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw new Error("Failed to get user info from Google")
    return JSON.parse(await response.text()) as {
      email: string
      name: string
      given_name: string
      family_name: string
      picture: string
    }
  }

  /** `refreshToken`: returns the same success/error shape as the service. */
  async refreshToken(refreshToken: string) {
    try {
      const client = this.oauth()
      client.setCredentials({ refresh_token: refreshToken })
      const { credentials } = await client.refreshAccessToken()
      if (!credentials.access_token) throw new Error("No access token received from refresh")
      return {
        success: true as const,
        accessToken: credentials.access_token,
        ...(credentials.expiry_date ? { expiresAt: new Date(credentials.expiry_date) } : {}),
      }
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  }

  /** `revokeTokens` (the Google half). */
  async revokeToken(accessToken: string): Promise<boolean> {
    try {
      await new OAuth2Client({
        endpoints: { oauth2RevokeUrl: `${this.rootUrl}/revoke` },
      }).revokeToken(accessToken)
      return true
    } catch (error) {
      this.log("warn", "Failed to revoke token with Google", { error: (error as Error).message })
      return false
    }
  }

  /** `getOrCreateEMRCalendar`. */
  async getOrCreateEMRCalendar(accessToken: string, practitionerId: string): Promise<string> {
    const cal = this.calendar(accessToken)
    try {
      const list = await cal.calendarList.list()
      const existing = list.data.items?.find((c) => c.summary === EMR_CALENDAR_NAME)
      if (existing?.id) return existing.id
      const created = await cal.calendars.insert({
        requestBody: {
          summary: EMR_CALENDAR_NAME,
          description: `EMR appointments calendar for practitioner ${practitionerId}`,
          timeZone: "America/New_York",
        },
      })
      if (!created.data.id) throw new Error("Failed to create EMR calendar - no ID returned")
      return created.data.id
    } catch (error) {
      throw new Error(`Failed to get or create EMR calendar: ${error}`)
    }
  }

  private transformGoogleEvents(events: calendar_v3.Schema$Event[]): GoogleCalendarEvent[] {
    return events
      .filter((event) => event.id && event.summary)
      .filter((event) => !isEMROriginatedEvent(event))
      .flatMap((event) => {
        const allDay = !!(event.start?.date && !event.start?.dateTime)
        const start = allDay ? event.start?.date : event.start?.dateTime
        const end = allDay ? event.end?.date : event.end?.dateTime
        if (!start || !end) return []
        const out: GoogleCalendarEvent = {
          id: `google-${event.id}`,
          title: event.summary ?? "Untitled Event",
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          allDay,
          source: "google",
        }
        if (event.description) out.description = event.description
        if (event.location) out.location = event.location
        if (event.htmlLink) out.htmlLink = event.htmlLink
        return [out]
      })
  }

  /**
   * `fetchCalendarEvents`. As in the app, the syncToken is accepted but never sent (the
   * assignment is commented out), so the 410 fallback only fires if Google 410s a full list.
   */
  async fetchCalendarEvents(
    accessToken: string,
    timeRange: { start: string; end: string },
    maxResults = 1000,
    syncToken?: string,
  ): Promise<{
    success: boolean
    events: GoogleCalendarEvent[]
    eventsCount: number
    nextSyncToken?: string
    error?: string
  }> {
    try {
      const response = await this.calendar(accessToken).events.list({
        calendarId: "primary",
        maxResults,
        singleEvents: true,
        timeMin: timeRange.start,
        timeMax: timeRange.end,
      })
      const events = this.transformGoogleEvents(response.data.items ?? [])
      return {
        success: true,
        events,
        eventsCount: events.length,
        ...(response.data.nextSyncToken ? { nextSyncToken: response.data.nextSyncToken } : {}),
      }
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status
      if (syncToken && status === 410) {
        this.log("warn", "Sync token invalidated, falling back to full sync")
        return this.fetchCalendarEvents(accessToken, timeRange, maxResults)
      }
      const message = (error as Error).message
      if (message.includes("API has not been used") || message.includes("is disabled")) {
        throw new Error(
          "Google Calendar API is not enabled. Please enable it in Google Cloud Console and try again.",
        )
      }
      if (
        message.includes("invalid_grant") ||
        message.includes("Token has been expired or revoked")
      ) {
        throw new Error(
          "Google Calendar access token has expired. Please reconnect your Google account.",
        )
      }
      if (message.includes("insufficient authentication scopes")) {
        throw new Error(
          "Insufficient permissions for Google Calendar. Please reconnect with calendar access.",
        )
      }
      const detailed =
        (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? message
      return {
        success: false,
        events: [],
        eventsCount: 0,
        error: `Failed to fetch Google Calendar events: ${detailed}`,
      }
    }
  }

  /** `buildEMREventResource`. */
  buildEMREventResource(data: EMRAppointmentSyncData): calendar_v3.Schema$Event {
    return {
      summary: `${EMR_EVENT_PREFIX}${data.appointmentName ?? data.serviceType ?? "Appointment"}`,
      description: `📅 EMR APPOINTMENT - READ ONLY\n\nService: ${data.serviceType ?? "N/A"}\nStatus: ${data.status}\n${data.location ? `Location: ${data.location}` : ""}`,
      start: { dateTime: data.start, timeZone: "UTC" },
      end: { dateTime: data.end, timeZone: "UTC" },
      ...(data.location ? { location: data.location } : {}),
      status: data.status === "cancelled" ? "cancelled" : "confirmed",
      extendedProperties: {
        private: {
          [EMR_METADATA_KEY]: data.medplumAppointmentId,
          emrSyncedAt: new Date().toISOString(),
          emrServiceType: data.serviceType ?? "",
        },
      },
    }
  }

  async createEMRAppointment(accessToken: string, data: EMRAppointmentSyncData) {
    const response = await this.calendar(accessToken).events.insert({
      calendarId: "primary",
      requestBody: this.buildEMREventResource(data),
    })
    return {
      success: true,
      action: "created" as const,
      googleEventId: response.data.id ?? undefined,
    }
  }

  async updateEMRAppointment(
    accessToken: string,
    data: EMRAppointmentSyncData,
    googleEventId: string,
  ) {
    const response = await this.calendar(accessToken).events.update({
      calendarId: "primary",
      eventId: googleEventId,
      requestBody: this.buildEMREventResource(data),
    })
    return {
      success: true,
      action: "updated" as const,
      googleEventId: response.data.id ?? undefined,
    }
  }

  /** `findGoogleEventByEMRAppointmentId`: q = prefix, ±window, orderBy updated. */
  async findGoogleEventByEMRAppointmentId(
    accessToken: string,
    medplumAppointmentId: string,
    horizonWeeks = 12,
  ) {
    const response = await this.calendar(accessToken).events.list({
      calendarId: "primary",
      q: EMR_EVENT_PREFIX,
      timeMin: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      timeMax: new Date(Date.now() + horizonWeeks * 7 * 86_400_000).toISOString(),
      maxResults: 250,
      singleEvents: true,
      orderBy: "updated",
    })
    return (
      (response.data.items ?? []).find(
        (event) => event.extendedProperties?.private?.[EMR_METADATA_KEY] === medplumAppointmentId,
      ) ?? null
    )
  }

  /** Orphan / duplicate cleanup: delete, logging (not throwing) failures. */
  async deleteEvents(accessToken: string, eventIds: string[]): Promise<number> {
    const cal = this.calendar(accessToken)
    let deleted = 0
    for (const eventId of eventIds) {
      try {
        await cal.events.delete({ calendarId: "primary", eventId })
        deleted++
      } catch (error) {
        this.log("warn", "Failed to delete orphaned Google Calendar event", {
          eventId,
          status: (error as { response?: { status?: number } }).response?.status,
        })
      }
    }
    return deleted
  }

  /** `registerWebhookChannel`: watch with a fresh channel id, then stop the previous channel. */
  async registerWebhookChannel(
    accessToken: string,
    practitionerId: string,
    calendarType: CalendarType,
    existingChannel?: { channelId: string; resourceId: string },
  ) {
    const cal = this.calendar(accessToken)
    const channelId = `${practitionerId}-${calendarType}-${crypto.randomUUID()}`
    const expiration = new Date()
    expiration.setDate(expiration.getDate() + WEBHOOK_EXPIRATION_DAYS)
    const calendarId =
      calendarType === "primary"
        ? "primary"
        : await this.getOrCreateEMRCalendar(accessToken, practitionerId)
    const response = await cal.events.watch({
      calendarId,
      requestBody: {
        id: channelId,
        type: "web_hook",
        address: calendarType === "primary" ? this.env.primaryWebhookUrl : this.env.emrWebhookUrl,
        expiration: expiration.getTime().toString(),
      },
    })
    const resourceId = response.data.resourceId
    if (!resourceId) throw new Error("No resource ID received from Google Calendar API")
    if (existingChannel) {
      try {
        await cal.channels.stop({
          requestBody: { id: existingChannel.channelId, resourceId: existingChannel.resourceId },
        })
      } catch (error) {
        this.log(
          "warn",
          "Failed to stop previous Google Calendar webhook channel during renewal cleanup",
          {
            error: (error as Error).message,
          },
        )
      }
    }
    return {
      success: true,
      channelId,
      resourceId,
      expiration: response.data.expiration
        ? new Date(Number(response.data.expiration)).toISOString()
        : expiration.toISOString(),
    }
  }

  /** `unregisterWebhookChannel` (the Google half). */
  async stopChannel(accessToken: string, channel: { channelId: string; resourceId: string }) {
    await this.calendar(accessToken).channels.stop({
      requestBody: { id: channel.channelId, resourceId: channel.resourceId },
    })
  }
}

/** The `x-goog-*` fields the webhook controller reads, after Fastify lower-cases them. */
export type PushHeaders = Record<string, string | undefined>

/**
 * `handlePrimaryCalendarWebhook`: 400 without channel id / state, 200 ack for `sync`, 200
 * ignore for anything but `exists`, otherwise process (a full sync) and 200.
 */
export const handlePrimaryCalendarWebhook = async (
  headers: PushHeaders,
  process: (data: {
    channelId: string
    resourceState: string
    resourceId: string
    messageNumber: string
  }) => Promise<void>,
): Promise<{ status: number; body: Record<string, string> }> => {
  const channelId = headers["x-goog-channel-id"]
  const resourceState = headers["x-goog-resource-state"]
  const resourceId = headers["x-goog-resource-id"]
  const messageNumber = headers["x-goog-message-number"]
  if (!channelId || !resourceState)
    return { status: 400, body: { error: "Missing required webhook headers" } }
  if (resourceState === "sync") return { status: 200, body: { message: "Sync acknowledged" } }
  if (resourceState !== "exists")
    return { status: 200, body: { message: "Non-exists state ignored" } }
  await process({
    channelId,
    resourceState,
    resourceId: resourceId ?? "",
    messageNumber: messageNumber ?? "0",
  })
  return { status: 200, body: { message: "Primary calendar webhook processed successfully" } }
}
