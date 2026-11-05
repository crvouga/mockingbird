import { expect, test } from "bun:test"
import { JunctionAPI } from "./src/index.js"

const auth = { "x-vital-api-key": "sk_us_mockingbird" }
const host = "https://junction.test"
const baseTime = Date.parse("2026-11-05T12:00:00Z")
const json = { "content-type": "application/json" }
const LAB_AT_HOME = "b439efda-1e07-4d2c-8afb-51771c7cc0cb"
const LAB_WALK_IN = "c533549c-1e62-4afe-9a0e-0567a9b2bcc2"

type Api = JunctionAPI
type Json = Record<string, unknown>
type Day = { date: string; slots: Array<{ booking_key: string; start: string }> }

const request = (api: Api, path: string, init?: RequestInit) =>
  api.fetch(new Request(`${host}${path}`, { ...init, headers: { ...auth, ...init?.headers } }))

const phlebotomyDays = async (api: Api, startDate: string): Promise<Day[]> => {
  const response = await request(
    api,
    `/v3/order/phlebotomy/appointment/availability?start_date=${startDate}`,
    {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        first_line: "1 Main St",
        second_line: null,
        city: "San Diego",
        state: "CA",
        zip_code: "92101",
        unit: null,
      }),
    },
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { slots: Day[] }).slots
}

const pscDays = async (api: Api, startDate: string): Promise<Day[]> => {
  const response = await request(
    api,
    `/v3/order/psc/appointment/availability?lab=quest&zip_code=94105&start_date=${startDate}`,
    { method: "POST", headers: json },
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { slots: Day[] }).slots
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const bookableOrder = async (api: Api, labId: string): Promise<string> => {
  const user = await request(api, "/v2/user", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_user_id: `window-${labId}` }),
  })
  const userId = ((await user.json()) as Json).user_id as string
  const order = await request(api, "/v3/order", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
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
      order_set: { lab_test_ids: [labId] },
    }),
  })
  expect(order.status).toBe(200)
  const orderId = (((await order.json()) as Json).order as Json).id as string
  const method = labId === LAB_WALK_IN ? "walk_in_test" : "at_home_phlebotomy"
  const requisition = await request(
    api,
    `/v3/order/${orderId}/test?final_status=received.${method}.requisition_created`,
    { method: "POST" },
  )
  expect(requisition.status).toBe(200)
  return orderId
}

test("phlebotomy availability spans Junction's 14-day window from start_date", async () => {
  const api = new JunctionAPI({ now: () => baseTime })
  const days = await phlebotomyDays(api, "2026-11-10")
  expect(days.map((day) => day.date)).toEqual(
    Array.from({ length: 14 }, (_, index) => addDays("2026-11-10", index)),
  )
})

test("psc availability spans the same 14-day window", async () => {
  const api = new JunctionAPI({ now: () => baseTime })
  const days = await pscDays(api, "2026-11-10")
  expect(days.map((day) => day.date)).toEqual(
    Array.from({ length: 14 }, (_, index) => addDays("2026-11-10", index)),
  )
})

test("a phlebotomy slot ten or more days out books", async () => {
  const api = new JunctionAPI({ now: () => baseTime })
  const orderId = await bookableOrder(api, LAB_AT_HOME)
  const days = await phlebotomyDays(api, "2026-11-10")
  const late = days[12]?.slots[0]
  expect(late?.start.slice(0, 10)).toBe("2026-11-22")
  const booked = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/book`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ booking_key: late?.booking_key }),
  })
  expect(booked.status).toBe(200)
  expect(((await booked.json()) as Json).start_at).toBe(late?.start)
})

test("a psc slot ten or more days out books", async () => {
  const api = new JunctionAPI({ now: () => baseTime })
  const orderId = await bookableOrder(api, LAB_WALK_IN)
  const days = await pscDays(api, "2026-11-10")
  const late = days[11]?.slots[0] as (Day["slots"][number] & { site_code?: string }) | undefined
  expect(late?.start.slice(0, 10)).toBe("2026-11-21")
  const booked = await request(api, `/v3/order/${orderId}/psc/appointment/book`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ booking_key: late?.booking_key, site_code: late?.site_code }),
  })
  expect(booked.status).toBe(200)
})

test("the first days keep the slots a 3-day window produced", async () => {
  const api = new JunctionAPI({ now: () => baseTime })
  const days = await phlebotomyDays(api, "2026-11-10")
  const short = await phlebotomyDays(
    new JunctionAPI({ now: () => baseTime, availabilityWindowDays: 3 }),
    "2026-11-10",
  )
  const starts = (list: Day[]) => list.map((day) => day.slots.map((slot) => slot.start))
  expect(starts(days.slice(0, 3))).toEqual(starts(short))
})

test("availabilityWindowDays configures the window for both modalities", async () => {
  const api = new JunctionAPI({ now: () => baseTime, availabilityWindowDays: 5 })
  expect((await phlebotomyDays(api, "2026-11-10")).length).toBe(5)
  expect((await pscDays(api, "2026-11-10")).length).toBe(5)
})

test("availabilityWindowDays must be a whole number of days from 1 to 60", () => {
  for (const bad of [0, -1, 1.5, 61, Number.NaN]) {
    expect(() => new JunctionAPI({ availabilityWindowDays: bad })).toThrow(TypeError)
  }
})
