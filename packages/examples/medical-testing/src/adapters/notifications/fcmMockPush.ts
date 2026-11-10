import { createRuntime } from "@crvouga/mockingbird-service-fcm"
import type { OutboundPush } from "../../app/ports/notifier.js"
import type { MockAdmin } from "../admin.js"

/** The emulator's fixture Firebase project. */
const PROJECT_ID = "demo-project"
const ACCESS_TOKEN = "cove-demo-access-token"
const BASE_URL = "https://fcm.googleapis.com"

/**
 * Pushes through Mockingbird's in-process FCM emulator with the HTTP v1 call
 * `firebase-admin` makes: `POST /v1/projects/{project}/messages:send`.
 *
 * FCM only delivers to registration tokens a device obtained. Here the
 * "device" is fictional, so the first push to a token registers it through
 * the emulator's admin API, with the platform read from the token's prefix
 * (`ios-…` or `android-…`, see `deviceTokenFor`). That platform lets the
 * notification harness draw the right phone.
 */
export const createFcmMockPush = () => {
  const runtime = createRuntime()
  const registered = new Map<string, Promise<void>>()

  const register = (token: string): Promise<void> => {
    let pending = registered.get(token)
    if (!pending) {
      pending = (async () => {
        const response = await runtime.fetch(
          new Request(`${BASE_URL}/__admin/tokens`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token,
              platform: token.startsWith("ios-") ? "ios" : "android",
              project: PROJECT_ID,
            }),
          }),
        )
        if (!response.ok) throw new Error(`FCM device registration failed (${response.status})`)
      })()
      pending.catch(() => registered.delete(token))
      registered.set(token, pending)
    }
    return pending
  }

  const sendPush = async (message: OutboundPush): Promise<void> => {
    await register(message.deviceToken)
    const response = await runtime.fetch(
      new Request(`${BASE_URL}/v1/projects/${PROJECT_ID}/messages:send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ACCESS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: message.deviceToken,
            notification: { title: message.title, body: message.body },
            ...(message.data ? { data: message.data } : {}),
          },
        }),
      }),
    )
    if (!response.ok) throw new Error(`FCM rejected the push (${response.status})`)
  }

  const admin: MockAdmin = { id: "fcm", label: "FCM", fetch: (r) => runtime.fetch(r) }
  return { sendPush, runtime, admin }
}
