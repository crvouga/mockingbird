import { describe, expect, test } from "bun:test"
import { JunctionAPI } from "./src/index.js"

const auth = { "x-vital-api-key": "sk_us_mockingbird" }
const now = () => 1_700_000_000_000
const request = (api: JunctionAPI, path: string, init?: RequestInit) =>
  api.fetch(
    new Request(`https://junction.test${path}`, {
      ...init,
      headers: { ...auth, ...init?.headers },
    }),
  )

const json = async (response: Response) => (await response.json()) as Record<string, unknown>

describe("Junction client-facing lifecycle", () => {
  test("updates user info and replays idempotent order creation", async () => {
    const api = new JunctionAPI({ now })
    const created = await request(api, "/v2/user", {
      method: "POST",
      body: JSON.stringify({ client_user_id: "client-1" }),
      headers: { "content-type": "application/json" },
    })
    expect(created.status).toBe(200)
    const user = await json(created)
    const userId = user.user_id as string

    const info = await request(api, `/v2/user/${userId}/info`, {
      method: "PATCH",
      body: JSON.stringify({ first_name: "Ada" }),
      headers: { "content-type": "application/json" },
    })
    expect(info.status).toBe(200)
    expect((await json(info)).first_name).toBe("Ada")

    const body = JSON.stringify({
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
      idempotency_key: "order-key-1",
    })
    const first = await request(api, "/v3/order", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    })
    const second = await request(api, "/v3/order", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await json(second)).order).toEqual((await json(first)).order)
  })

  test("cancels an order and rejects unknown order ids", async () => {
    const api = new JunctionAPI({ now })
    const response = await request(api, "/v3/order/00000000-0000-4000-8000-000000000000/cancel", {
      method: "POST",
    })
    expect(response.status).toBe(404)
  })
})
