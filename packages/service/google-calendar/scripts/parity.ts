/**
 * Live parity: the same random walk against Google (a dedicated test account's calendar) and
 * a fresh mock, canonicalized and diffed. Credentials come from the environment
 * (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   GOOGLE_CALENDAR_CLIENT_ID
 *   GOOGLE_CALENDAR_CLIENT_SECRET
 *   GOOGLE_CALENDAR_REFRESH_TOKEN   for a throwaway test Google account only
 *
 * By default only reads run (calendarList, events list/get, userinfo); event writes, watch,
 * channels.stop and calendars.insert need `--include-unsafe` and must only ever target that
 * test account. The walk's own token-endpoint calls use mock-only codes, so on the real side
 * they exercise Google's invalid_grant answers.
 */
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { document, GoogleCalendarAPI, issueAccessToken } from "../src/index.js"

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "google-calendar",
      fields: {
        GOOGLE_CALENDAR_CLIENT_ID: "GOOGLE_CALENDAR_CLIENT_ID",
        GOOGLE_CALENDAR_CLIENT_SECRET: "GOOGLE_CALENDAR_CLIENT_SECRET",
        GOOGLE_CALENDAR_REFRESH_TOKEN: "GOOGLE_CALENDAR_REFRESH_TOKEN",
      },
    },
    { env: process.env },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`google-calendar parity: no test-account credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const values = credentials.values
const refreshed = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: values.GOOGLE_CALENDAR_REFRESH_TOKEN,
    client_id: values.GOOGLE_CALENDAR_CLIENT_ID,
    client_secret: values.GOOGLE_CALENDAR_CLIENT_SECRET,
  }),
})
if (!refreshed.ok) {
  console.error(`google-calendar parity: token refresh failed (${refreshed.status})`)
  process.exit(2)
}
const accessToken = ((await refreshed.json()) as { access_token: string }).access_token
const mockToken = issueAccessToken("parity@example.com", Math.floor(Date.now() / 1000))

try {
  await parity({
    provider: "google-calendar",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl: "https://www.googleapis.com",
      allowedHosts: ["www.googleapis.com", "oauth2.googleapis.com"],
      headers: () => ({ authorization: `Bearer ${accessToken}` }),
      minIntervalMs: 250,
      fetch: (request) => {
        const url = new URL(request.url)
        // The token and revoke endpoints live on oauth2.googleapis.com.
        if (url.pathname === "/token" || url.pathname === "/revoke")
          url.host = "oauth2.googleapis.com"
        return fetch(new Request(url, request))
      },
    },
    mock: {
      create: () => new GoogleCalendarAPI(),
      headers: () => ({ authorization: `Bearer ${mockToken}` }),
    },
    redact: createRedactor([...credentials.secrets, accessToken]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
