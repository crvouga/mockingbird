import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { JunctionAPI } from "./src/index.js"

const auth = { "x-vital-api-key": "sk_us_mockingbird" }
const host = "https://junction.test"
const now = () => 1_700_000_000_000
const request = (api: JunctionAPI, path: string, init: RequestInit = {}) =>
  api.fetch(new Request(`${host}${path}`, { ...init, headers: { ...auth, ...init.headers } }))

const orderBody = (userId: string, idempotencyKey: string) => ({
  user_id: userId,
  patient_details: {
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "1990-01-01",
    gender: "female",
    phone_number: "+14155551234",
    email: "ada@example.com",
  },
  patient_address: {
    first_line: "1 Main St",
    city: "San Diego",
    state: "CA",
    zip: "92101",
    country: "US",
  },
  order_set: { lab_test_ids: ["c533549c-1e62-4afe-9a0e-0567a9b2bcc2"] },
  idempotency_key: idempotencyKey,
})

describe("Junction lifecycle", () => {
  test("converges after duplicate order placement and repeated completion", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async (schedule) => {
        const api = new JunctionAPI({ now, webhook: { seed: 42 } })
        const userResponse = await request(api, "/v2/user", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_user_id: `lifecycle-${schedule.length}` }),
        })
        const user = (await userResponse.json()) as { user_id: string }
        const body = orderBody(user.user_id, "lifecycle-order-key")
        const responses = await Promise.all(
          schedule.map(() =>
            request(api, "/v3/order", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        )
        expect(responses.every((response) => response.status === 200)).toBe(true)
        const payloads = await Promise.all(responses.map((response) => response.json()))
        const order = payloads[0] as { order: { id: string } }
        expect(
          new Set(payloads.map((payload) => (payload as { order: { id: string } }).order.id)).size,
        ).toBe(1)
        for (const complete of schedule) {
          if (!complete) continue
          const response = await request(
            api,
            `/v3/order/${order.order.id}/test?final_status=completed.testkit.completed`,
            {
              method: "POST",
            },
          )
          expect(response.status).toBe(200)
          expect(await response.json()).toBe("Success")
        }
        const latest = (await (await request(api, `/v3/order/${order.order.id}`)).json()) as {
          status: string
          last_event: { status: string }
          order_transaction: { status: string }
        }
        if (schedule.some(Boolean)) {
          expect(latest.status).toBe("completed")
          expect(latest.last_event.status).toBe("completed.testkit.completed")
          expect(latest.order_transaction.status).toBe("completed")
        }
      }),
      { numRuns: 12, seed: 918273 },
    )
  })

  test("duplicate cancellation does not duplicate cancellation events", async () => {
    const api = new JunctionAPI({ now })
    const userResponse = await request(api, "/v2/user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_user_id: "cancel-client" }),
    })
    const user = (await userResponse.json()) as { user_id: string }
    const created = await request(api, "/v3/order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(orderBody(user.user_id, "cancel-key")),
    })
    const { order } = (await created.json()) as { order: { id: string } }
    const responses = await Promise.all(
      [1, 2].map(() => request(api, `/v3/order/${order.id}/cancel`, { method: "POST" })),
    )
    expect(responses.every((response) => response.status === 200)).toBe(true)
    const latest = (await (await request(api, `/v3/order/${order.id}`)).json()) as {
      events: unknown[]
      status: string
    }
    expect(latest.status).toBe("cancelled")
    expect(latest.events).toHaveLength(2)
  })
})
