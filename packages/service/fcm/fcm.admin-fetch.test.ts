import { expect, test } from "bun:test"
import { createAdminCredential, routeAdminRequest } from "./src/admin-fetch.js"
import { createRuntime, FCM_FIXTURE_PROJECT, FCM_FIXTURE_TOKEN } from "./src/index.js"

test("socket-free credential and routing support strict sends and outbox capture", async () => {
  const runtime = createRuntime()
  const credential = createAdminCredential()
  const token = await credential.getAccessToken()
  expect(token).toEqual({ access_token: "fixture-token", expires_in: 3600 })
  const settings = await runtime.fetch(
    new Request("http://fcm/__admin/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        strict: true,
        credentials: { [token.access_token]: { project: FCM_FIXTURE_PROJECT } },
      }),
    }),
  )
  expect(settings.status).toBe(200)
  const route = routeAdminRequest(runtime)
  const response = await route(
    new Request(`https://fcm.googleapis.com/v1/projects/${FCM_FIXTURE_PROJECT}/messages:send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: { token: FCM_FIXTURE_TOKEN, notification: { title: "Fixture notification" } },
      }),
    }),
  )
  expect(response?.status).toBe(200)
  if (!response) throw new Error("send was not routed")
  expect((await response.json()).name).toStartWith(`projects/${FCM_FIXTURE_PROJECT}/messages/`)
  const outbox = await runtime.fetch(new Request("http://fcm/__admin/outbox"))
  expect((await outbox.json()).messages).toHaveLength(1)
  for (const url of [
    "https://other.test/v1/projects/demo/messages:send",
    "https://fcm.googleapis.com/__admin/reset",
    "http://fcm.googleapis.com/v1/projects/demo/messages:send",
  ]) {
    expect(route(new Request(url, { method: "POST" }))).toBeUndefined()
  }
})

// SDK request construction is real; only the outgoing HTTP boundary is host supplied.
// This private seam is version-pinned test plumbing, not part of the public helper API.
for (const version of ["firebase-admin", "firebase-admin-12"] as const) {
  test(`${version} send and legacy multicast through a host HTTP implementation`, async () => {
    const { initializeApp, deleteApp } = await import(`${version}/app`)
    const { getMessaging } = await import(`${version}/messaging`)
    const runtime = createRuntime()
    const credential = createAdminCredential()
    const app = initializeApp({ projectId: FCM_FIXTURE_PROJECT, credential }, `fetch-${version}`)
    try {
      const messaging = getMessaging(app)
      messaging.enableLegacyHttpTransport()
      const client = (
        messaging as unknown as {
          messagingRequestHandler: {
            httpClient: {
              send: (request: {
                url: string
                method: string
                headers: Record<string, string>
                data: unknown
              }) => Promise<unknown>
            }
          }
        }
      ).messagingRequestHandler.httpClient
      const route = routeAdminRequest(runtime)
      client.send = async (request) => {
        const token = await credential.getAccessToken()
        const response = await route(
          new Request(request.url, {
            method: request.method,
            headers: {
              ...request.headers,
              authorization: `Bearer ${token.access_token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request.data),
          }),
        )
        if (!response) throw new Error(`Unrouted SDK URL: ${request.url}`)
        return { status: response.status, data: await response.json(), isJson: () => true }
      }
      expect(
        await messaging.send({ token: FCM_FIXTURE_TOKEN, notification: { title: "SDK fixture" } }),
      ).toStartWith(`projects/${FCM_FIXTURE_PROJECT}/messages/`)
      const batch = await messaging.sendEachForMulticast({
        tokens: [FCM_FIXTURE_TOKEN, FCM_FIXTURE_TOKEN],
        notification: { title: "SDK multicast" },
      })
      expect(batch.successCount).toBe(2)
      expect(batch.failureCount).toBe(0)
      const outbox = await runtime.fetch(new Request("http://fcm/__admin/outbox"))
      expect((await outbox.json()).messages).toHaveLength(3)
    } finally {
      await deleteApp(app)
    }
  })
}

test("forwarded real sends enter outbox without delivering to fixture devices", async () => {
  let calls = 0
  const runtime = createRuntime({
    upstream: {
      baseUrl: "https://fcm.googleapis.com",
      mode: "forward",
      fetch: async () => {
        calls++
        return Response.json({ name: "projects/demo-project/messages/real-fixture-id" })
      },
    },
  })
  const response = await runtime.fetch(
    new Request("http://fcm/v1/projects/demo-project/messages:send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
      body: JSON.stringify({
        message: { token: FCM_FIXTURE_TOKEN, notification: { title: "Real send fixture" } },
      }),
    }),
  )
  expect(response.status).toBe(200)
  const outbox = await (await runtime.fetch(new Request("http://fcm/__admin/outbox"))).json()
  expect(outbox.messages).toHaveLength(1)
  expect(outbox.messages[0].upstream).toBe(true)
  expect(outbox.messages[0].sentForReal).toBe(true)
  expect(runtime.instance().inbox(FCM_FIXTURE_TOKEN)).toHaveLength(0)
  const unsupported = await runtime.fetch(new Request("http://fcm/unsupported", { method: "POST" }))
  expect(unsupported.status).toBe(501)
  expect(calls).toBe(1)
})
