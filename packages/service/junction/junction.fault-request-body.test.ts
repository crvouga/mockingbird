import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

const AUTH = { "x-vital-api-key": "sk_us_test", "content-type": "application/json" }
const LAB_TEST = "c533549c-1e62-4afe-9a0e-0567a9b2bcc2"

const call = async (
  runtime: ReturnType<typeof createRuntime>,
  method: string,
  path: string,
  body?: unknown,
) => {
  const response = await runtime.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: AUTH,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
  const text = await response.text()
  return { status: response.status, json: text === "" ? null : JSON.parse(text), response }
}

const order = (userId: string, email: string) => ({
  user_id: userId,
  patient_details: {
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "1990-01-01",
    gender: "female",
    phone_number: "+14155551234",
    email,
  },
  patient_address: {
    first_line: "1 Main St",
    city: "San Diego",
    state: "CA",
    zip: "92101",
    country: "US",
  },
  order_set: { lab_test_ids: [LAB_TEST] },
})

test("a rule refuses one member's order by patient_details.email; other members pass", async () => {
  const runtime = createRuntime()
  const user = (await call(runtime, "POST", "/v2/user", { client_user_id: "member-fault" })).json
    .user_id as string
  const added = await call(runtime, "POST", "/__admin/faults", {
    method: "POST",
    path: "/v3/order",
    requestBody: { "patient_details.email": "member-a@example.test" },
    status: 503,
  })
  expect(added.status).toBe(201)

  const refused = await call(runtime, "POST", "/v3/order", order(user, "member-a@example.test"))
  expect(refused.status).toBe(503)
  const passed = await call(runtime, "POST", "/v3/order", order(user, "member-b@example.test"))
  expect(passed.status).toBe(200)
  // The refused order was never placed; the one that passed was placed from its body.
  const orders = (await call(runtime, "GET", `/v3/orders?user_id=${user}`)).json
  expect(JSON.stringify(orders)).toContain("member-b@example.test")
  expect(JSON.stringify(orders)).not.toContain("member-a@example.test")
})

test("a rule answers phlebotomy availability with empty slots for one address", async () => {
  const runtime = createRuntime()
  await call(runtime, "POST", "/__admin/faults", {
    method: "POST",
    pathPrefix: "/v3/order/phlebotomy/appointment/availability",
    requestBody: { zip_code: "00000" },
    status: 200,
    body: { slots: [], timezone: "America/Phoenix" },
  })
  const address = (zip_code: string) => ({
    first_line: "1 Main St",
    second_line: null,
    city: "Phoenix",
    state: "AZ",
    zip_code,
    unit: null,
  })
  const path = "/v3/order/phlebotomy/appointment/availability"
  const empty = await call(runtime, "POST", path, address("00000"))
  expect(empty.status).toBe(200)
  expect(empty.json).toEqual({ slots: [], timezone: "America/Phoenix" })
  const real = await call(runtime, "POST", path, address("85004"))
  expect(real.status).toBe(200)
  expect(real.json.slots.length).toBeGreaterThan(0)
})
