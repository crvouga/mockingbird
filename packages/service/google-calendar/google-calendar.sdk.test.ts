import { describe, expect, test } from "bun:test"
import { auth, calendar } from "@googleapis/calendar"
import { OAuth2Client } from "google-auth-library"
import { supportedOperationIds } from "./src/index.js"
import { createServer } from "./src/server.js"

/**
 * SDK drop-in: `@googleapis/calendar@9.8.0` (the calendar module `googleapis@149` bundles; the
 * full package is ~125 MB unpacked, so we install the module alone) and
 * `google-auth-library@9.15.0`, pointed at the served mock with `rootUrl` and `endpoints`.
 * Every operation is reached through the SDK and lands on the operation the contract names.
 */
describe("googleapis SDK drop-in", () => {
  test("every operation, called the way the SDK builds it", async () => {
    const server = await createServer()
    try {
      const oauth = new OAuth2Client({
        clientId: "c.apps.googleusercontent.com",
        clientSecret: "s",
        redirectUri: "postmessage",
        endpoints: {
          oauth2TokenUrl: `${server.url}/token`,
          oauth2RevokeUrl: `${server.url}/revoke`,
        },
      })
      const { tokens } = await oauth.getToken("4/mock-foreman")
      oauth.setCredentials({ refresh_token: tokens.refresh_token ?? null })
      const { credentials } = await oauth.refreshAccessToken()
      const client = new auth.OAuth2()
      client.setCredentials({ access_token: credentials.access_token ?? null })
      const cal = calendar({ version: "v3", auth: client, rootUrl: `${server.url}/` })
      const secondary = await cal.calendars.insert({ requestBody: { summary: "Clinic" } })
      expect((await cal.calendarList.list()).data.items?.map((c) => c.id)).toEqual([
        "foreman@example.com",
        secondary.data.id,
      ])
      const created = await cal.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: "Rounds",
          start: { dateTime: "2026-10-01T15:00:00Z" },
          end: { dateTime: "2026-10-01T16:00:00Z" },
        },
      })
      const id = created.data.id as string
      expect((await cal.events.get({ calendarId: "primary", eventId: id })).data.summary).toBe(
        "Rounds",
      )
      const updated = await cal.events.update({
        calendarId: "primary",
        eventId: id,
        requestBody: {
          summary: "Rounds",
          start: { dateTime: "2026-10-01T17:00:00Z" },
          end: { dateTime: "2026-10-01T18:00:00Z" },
        },
      })
      expect(updated.data.sequence).toBe(1)
      expect(
        (await cal.events.list({ calendarId: "primary", singleEvents: true, orderBy: "startTime" }))
          .data.items,
      ).toHaveLength(1)
      const channel = await cal.events.watch({
        calendarId: "primary",
        requestBody: {
          id: "sdk-channel",
          type: "web_hook",
          address: "https://emr.example.com/v1/webhooks/google-calendar/primary",
        },
      })
      await cal.channels.stop({
        requestBody: { id: "sdk-channel", resourceId: channel.data.resourceId ?? null },
      })
      await cal.events.delete({ calendarId: "primary", eventId: id })
      const info = await fetch(`${server.url}/oauth2/v3/userinfo`, {
        headers: { authorization: `Bearer ${credentials.access_token}` },
      })
      expect(((await info.json()) as { email: string }).email).toBe("foreman@example.com")
      await oauth.revokeToken(credentials.access_token as string)
      const journal = (await (await fetch(`${server.url}/__admin/requests?limit=100`)).json()) as {
        requests: { operationId?: string; status: number }[]
      }
      const seen = new Set(journal.requests.map((r) => r.operationId))
      expect([...supportedOperationIds].filter((op) => !seen.has(op))).toEqual([])
      expect(journal.requests.every((r) => r.status < 300)).toBe(true)
    } finally {
      await server.close()
    }
  })
})
