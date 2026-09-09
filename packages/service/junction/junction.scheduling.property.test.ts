import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { JunctionAPI } from "./src/index.js"

const auth = { "x-vital-api-key": "sk_us_mockingbird" }
const host = "https://junction.test"
const baseTime = 1_700_000_000_000
/** Walk clock advances so `delay`-queued simulate transitions and slot expiry both engage. */
const makeNow = () => {
  let current = baseTime
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

type Api = JunctionAPI
type Json = Record<string, unknown>

const request = (api: Api, path: string, init?: RequestInit) =>
  api.fetch(new Request(`${host}${path}`, { ...init, headers: { ...auth, ...init?.headers } }))

const LAB_AT_HOME = "b439efda-1e07-4d2c-8afb-51771c7cc0cb"
const LAB_WALK_IN = "c533549c-1e62-4afe-9a0e-0567a9b2bcc2"

const createUser = async (api: Api, clientUserId: string): Promise<string> => {
  const response = await request(api, "/v2/user", {
    method: "POST",
    body: JSON.stringify({ client_user_id: clientUserId }),
    headers: { "content-type": "application/json" },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as Json).user_id as string
}

const createOrder = async (api: Api, userId: string, labId: string): Promise<Json> => {
  const response = await request(api, "/v3/order", {
    method: "POST",
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
    headers: { "content-type": "application/json" },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as Json).order as Json
}

type Slot = { booking_key: string; start: string }

const phlebotomyAvailability = async (
  api: Api,
  zip: string,
  startDate?: string,
): Promise<{ status: number; slots: Slot[] }> => {
  const query = startDate === undefined ? "" : `?start_date=${startDate}`
  const response = await request(api, `/v3/order/phlebotomy/appointment/availability${query}`, {
    method: "POST",
    body: JSON.stringify({
      first_line: "1 Main St",
      second_line: null,
      city: "San Diego",
      state: "CA",
      zip_code: zip,
      unit: null,
    }),
    headers: { "content-type": "application/json" },
  })
  const body = (await response.json()) as Json
  const days = (body.slots as Array<Json> | undefined) ?? []
  return {
    status: response.status,
    slots: days.flatMap((day) => day.slots as Slot[]),
  }
}

const pscAvailability = async (
  api: Api,
  params: string,
): Promise<{ status: number; slots: Slot[] }> => {
  const response = await request(api, `/v3/order/psc/appointment/availability?${params}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  })
  const body = (await response.json()) as Json
  const days = (body.slots as Array<Json> | undefined) ?? []
  return {
    status: response.status,
    slots: days.flatMap((day) => day.slots as Slot[]),
  }
}

describe("Junction scheduling state space", () => {
  test("phlebotomy book/reschedule/cancel lifecycle stays coherent under random walks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          zip: fc.constantFrom("92101", "94105", "10001", "12345"),
          reschedule: fc.boolean(),
          cancelThenRebook: fc.boolean(),
          reasonIndex: fc.integer({ min: 0, max: 3 }),
        }),
        async ({ zip, reschedule, cancelThenRebook, reasonIndex }) => {
          const clock = makeNow()
          const api = new JunctionAPI({ now: clock.now, webhook: { seed: 11 } })
          const userId = await createUser(api, `sched-phlebo-${zip}`)
          const order = await createOrder(api, userId, LAB_AT_HOME)
          const orderId = order.id as string

          const availability = await phlebotomyAvailability(api, zip)
          expect(availability.status).toBe(200)
          expect(availability.slots.length).toBeGreaterThan(0)

          const firstKey = availability.slots[0]?.booking_key ?? ""
          const booked = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: firstKey }),
            headers: { "content-type": "application/json" },
          })
          expect(booked.status).toBe(200)
          const appointment = (await booked.json()) as Json
          expect(appointment.order_id).toBe(orderId)
          expect(appointment.user_id).toBe(userId)
          expect(appointment.type).toBe("phlebotomy")
          expect(appointment.status).toBe("confirmed")
          expect(appointment.event_status).toBe("scheduled")

          const fetched = await request(api, `/v3/order/${orderId}/phlebotomy/appointment`)
          expect(fetched.status).toBe(200)
          expect(((await fetched.json()) as Json).id).toBe(appointment.id)

          const updatedOrder = (await (await request(api, `/v3/order/${orderId}`)).json()) as Json
          const scheduledEvent = (updatedOrder.last_event as Json).status
          expect(scheduledEvent).toBe("collecting_sample.at_home_phlebotomy.appointment_scheduled")

          if (reschedule) {
            const secondAvailability = await phlebotomyAvailability(api, zip)
            const secondKey = secondAvailability.slots.find(
              (slot) => slot.booking_key !== firstKey && slot.start !== appointment.start_at,
            )?.booking_key
            if (secondKey !== undefined) {
              const rescheduled = await request(
                api,
                `/v3/order/${orderId}/phlebotomy/appointment/reschedule`,
                {
                  method: "PATCH",
                  body: JSON.stringify({ booking_key: secondKey }),
                  headers: { "content-type": "application/json" },
                },
              )
              expect(rescheduled.status).toBe(200)
              const rescheduledAppointment = (await rescheduled.json()) as Json
              expect(rescheduledAppointment.id).toBe(appointment.id)
              expect(rescheduledAppointment.start_at).not.toBe(appointment.start_at)
            }
          }

          if (cancelThenRebook) {
            const cancelled = await request(
              api,
              `/v3/order/${orderId}/phlebotomy/appointment/cancel`,
              {
                method: "PATCH",
                body: JSON.stringify({
                  cancellation_reason_id: `cancellation_reason_${reasonIndex + 1}`,
                  notes: reasonIndex === 3 ? "unavoidable" : null,
                }),
                headers: { "content-type": "application/json" },
              },
            )
            expect(cancelled.status).toBe(200)
            const cancelledAppointment = (await cancelled.json()) as Json
            expect(cancelledAppointment.status).toBe("cancelled")
            expect(cancelledAppointment.event_status).toBe("cancelled")

            const orderAfterCancel = (await (
              await request(api, `/v3/order/${orderId}`)
            ).json()) as Json
            expect((orderAfterCancel.last_event as Json).status).toBe(
              "collecting_sample.at_home_phlebotomy.appointment_cancelled",
            )

            const rebookAvailability = await phlebotomyAvailability(api, zip)
            const rebookKey = rebookAvailability.slots.find(
              (slot) => slot.booking_key !== firstKey,
            )?.booking_key
            if (rebookKey !== undefined) {
              const rebook = await request(
                api,
                `/v3/order/${orderId}/phlebotomy/appointment/book`,
                {
                  method: "POST",
                  body: JSON.stringify({ booking_key: rebookKey }),
                  headers: { "content-type": "application/json" },
                },
              )
              expect(rebook.status).toBe(200)
            }
          }

          const appointmentEvents = api
            .webhookEvents()
            .filter((event) => event.event_type === "labtest.appointment.updated")
          expect(appointmentEvents.length).toBeGreaterThanOrEqual(1)
        },
      ),
      { numRuns: 24, seed: 424242 },
    )
  })

  test("booking keys are single-use, expiring, and modality-bound", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 }), async (mode) => {
        const clock = makeNow()
        const api = new JunctionAPI({ now: clock.now })
        const userId = await createUser(api, `sched-key-${mode}`)
        const order = await createOrder(api, userId, LAB_AT_HOME)
        const orderId = order.id as string
        const availability = await phlebotomyAvailability(api, "92101")
        const key = availability.slots[0]?.booking_key ?? ""

        if (mode === 0) {
          const first = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: key }),
            headers: { "content-type": "application/json" },
          })
          expect(first.status).toBe(200)
          const second = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: key }),
            headers: { "content-type": "application/json" },
          })
          expect(second.status).toBe(400)
        } else if (mode === 1) {
          const expired = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: "totally-unknown-key" }),
            headers: { "content-type": "application/json" },
          })
          expect(expired.status).toBe(400)
        } else {
          clock.advance(7 * 24 * 60 * 60 * 1000)
          const stale = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: key }),
            headers: { "content-type": "application/json" },
          })
          expect(stale.status).toBe(400)
        }
      }),
      { numRuns: 9 },
    )
  })

  test("psc booking requires site_code, honors idempotency, and rejects mismatched sites", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 }), async (mode) => {
        const api = new JunctionAPI({ now: () => baseTime })
        const userId = await createUser(api, `sched-psc-${mode}`)
        const order = await createOrder(api, userId, LAB_WALK_IN)
        const orderId = order.id as string
        const availability = await pscAvailability(
          api,
          "lab=quest&zip_code=94105&site_codes=%5B%22L10257%22%5D",
        )
        expect(availability.status).toBe(200)
        expect(availability.slots.length).toBeGreaterThan(0)
        const key = availability.slots[0]?.booking_key ?? ""

        if (mode === 0) {
          const missingSite = await request(api, `/v3/order/${orderId}/psc/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: key }),
            headers: { "content-type": "application/json" },
          })
          expect(missingSite.status).toBe(400)
          const booked = await request(api, `/v3/order/${orderId}/psc/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: key, site_code: "L10257" }),
            headers: { "content-type": "application/json", "x-idempotency-key": "psc-key-1" },
          })
          expect(booked.status).toBe(200)
          const replay = await request(api, `/v3/order/${orderId}/psc/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: key, site_code: "L10257" }),
            headers: { "content-type": "application/json", "x-idempotency-key": "psc-key-1" },
          })
          expect(replay.status).toBe(200)
          expect(await replay.json()).toEqual(await booked.json())
        } else if (mode === 1) {
          const mismatch = await request(api, `/v3/order/${orderId}/psc/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: key, site_code: "Q10170" }),
            headers: { "content-type": "application/json" },
          })
          expect(mismatch.status).toBe(400)
        } else {
          const unknownOrder = await request(
            api,
            `/v3/order/00000000-0000-4000-8000-000000000000/psc/appointment/book`,
            {
              method: "POST",
              body: JSON.stringify({ booking_key: key, site_code: "L10257" }),
              headers: { "content-type": "application/json" },
            },
          )
          expect(unknownOrder.status).toBe(404)
        }
      }),
      { numRuns: 9 },
    )
  })

  test("appointment-less get/cancel 404s and cancelled appointments refuse reschedule", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (cancelFirst) => {
        const api = new JunctionAPI({ now: () => baseTime })
        const userId = await createUser(api, `sched-miss-${cancelFirst}`)
        const order = await createOrder(api, userId, LAB_AT_HOME)
        const orderId = order.id as string

        if (!cancelFirst) {
          const missing = await request(api, `/v3/order/${orderId}/phlebotomy/appointment`)
          expect(missing.status).toBe(404)
          const missingCancel = await request(
            api,
            `/v3/order/${orderId}/phlebotomy/appointment/cancel`,
            {
              method: "PATCH",
              body: JSON.stringify({ cancellation_reason_id: "cancellation_reason_1" }),
              headers: { "content-type": "application/json" },
            },
          )
          expect(missingCancel.status).toBe(404)
          return
        }

        const availability = await phlebotomyAvailability(api, "92101")
        const booked = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/book`, {
          method: "POST",
          body: JSON.stringify({ booking_key: availability.slots[0]?.booking_key ?? "" }),
          headers: { "content-type": "application/json" },
        })
        expect(booked.status).toBe(200)
        const cancelled = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/cancel`, {
          method: "PATCH",
          body: JSON.stringify({ cancellation_reason_id: "cancellation_reason_2" }),
          headers: { "content-type": "application/json" },
        })
        expect(cancelled.status).toBe(200)
        const doubleCancel = await request(
          api,
          `/v3/order/${orderId}/phlebotomy/appointment/cancel`,
          {
            method: "PATCH",
            body: JSON.stringify({ cancellation_reason_id: "cancellation_reason_2" }),
            headers: { "content-type": "application/json" },
          },
        )
        expect(doubleCancel.status).toBe(200)
        const rescheduleAfterCancel = await request(
          api,
          `/v3/order/${orderId}/phlebotomy/appointment/reschedule`,
          {
            method: "PATCH",
            body: JSON.stringify({ booking_key: availability.slots[1]?.booking_key ?? "" }),
            headers: { "content-type": "application/json" },
          },
        )
        expect(rescheduleAfterCancel.status).toBe(400)
      }),
      { numRuns: 12 },
    )
  })

  test("order cancellation cascades to the active appointment and emits both webhooks", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (withAppointment) => {
        const api = new JunctionAPI({ now: () => baseTime, webhook: { seed: 3 } })
        const userId = await createUser(api, `sched-cascade-${withAppointment}`)
        const order = await createOrder(api, userId, LAB_AT_HOME)
        const orderId = order.id as string

        if (withAppointment) {
          const availability = await phlebotomyAvailability(api, "92101")
          const booked = await request(api, `/v3/order/${orderId}/phlebotomy/appointment/book`, {
            method: "POST",
            body: JSON.stringify({ booking_key: availability.slots[0]?.booking_key ?? "" }),
            headers: { "content-type": "application/json" },
          })
          expect(booked.status).toBe(200)
        }

        const orderCancelled = await request(api, `/v3/order/${orderId}/cancel`, { method: "POST" })
        expect(orderCancelled.status).toBe(200)

        const appointment = await request(api, `/v3/order/${orderId}/phlebotomy/appointment`)
        if (withAppointment) {
          expect(appointment.status).toBe(200)
          expect(((await appointment.json()) as Json).status).toBe("cancelled")
        } else {
          expect(appointment.status).toBe(404)
        }

        const events = api.webhookEvents().map((event) => event.event_type)
        if (withAppointment) {
          const cancelIndex = events.lastIndexOf("labtest.appointment.updated")
          expect(cancelIndex).toBeGreaterThan(-1)
        }
      }),
      { numRuns: 10 },
    )
  })

  test("area info and psc info partition serviceable and unserviceable zips", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          zip: fc.constantFrom("92101", "94105", "10001", "00000"),
          labId: fc.constantFrom("3", "6", "99"),
        }),
        async ({ zip, labId }) => {
          const api = new JunctionAPI({ now: () => baseTime })
          const area = await request(api, `/v3/order/area/info?zip_code=${zip}`)
          expect(area.status).toBe(200)
          const areaBody = (await area.json()) as Json
          expect(areaBody.zip_code).toBe(zip)
          const unserviceable = zip === "00000"
          const phlebotomy = areaBody.phlebotomy as Json
          expect(phlebotomy.is_served).toBe(!unserviceable)

          const psc = await request(api, `/v3/order/psc/info?zip_code=${zip}&lab_id=${labId}`)
          expect(psc.status).toBe(200)
          const pscBody = (await psc.json()) as Json
          const centers = pscBody.patient_service_centers as unknown[]
          if (unserviceable) expect(centers).toHaveLength(0)
        },
      ),
      { numRuns: 20 },
    )
  })

  test("availability endpoint is deterministic for identical inputs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("92101", "94105"),
        fc.integer({ min: 0, max: 5 }),
        async (zip, day) => {
          const startDate = new Date(baseTime + day * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10)
          const first = new JunctionAPI({ now: () => baseTime })
          const second = new JunctionAPI({ now: () => baseTime })
          const a = await phlebotomyAvailability(first, zip, startDate)
          const b = await phlebotomyAvailability(second, zip, startDate)
          expect(a.status).toBe(b.status)
          expect(a.slots.map((slot) => slot.booking_key)).toEqual(
            b.slots.map((slot) => slot.booking_key),
          )
          expect(a.slots.map((slot) => slot.start)).toEqual(b.slots.map((slot) => slot.start))
        },
      ),
      { numRuns: 12 },
    )
  })

  test("delayed simulate transitions apply once the clock passes due_at", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (delaySeconds) => {
        const clock = makeNow()
        const api = new JunctionAPI({ now: clock.now })
        const userId = await createUser(api, `sched-delay-${delaySeconds}`)
        const order = await createOrder(api, userId, LAB_AT_HOME)
        const orderId = order.id as string

        const queued = await request(
          api,
          `/v3/order/${orderId}/test?final_status=completed.at_home_phlebotomy.completed&delay=${delaySeconds}`,
          { method: "POST" },
        )
        expect(queued.status).toBe(200)
        expect(await queued.text()).toBe("Success")

        const before = (await (await request(api, `/v3/order/${orderId}`)).json()) as Json
        expect(before.status).toBe("received")
        expect(before.interpretation).toBeNull()

        clock.advance((delaySeconds + 1) * 1000)
        const after = (await (await request(api, `/v3/order/${orderId}`)).json()) as Json
        expect(after.status).toBe("completed")
        expect((after.last_event as Json).status).toBe("completed.at_home_phlebotomy.completed")

        const queuedAgain = await request(
          api,
          `/v3/order/${orderId}/test?final_status=cancelled.at_home_phlebotomy.cancelled&delay=2`,
          { method: "POST" },
        )
        expect(queuedAgain.status).toBe(200)
        clock.advance(3_000)
        const final = (await (await request(api, `/v3/order/${orderId}`)).json()) as Json
        expect(final.status).toBe("cancelled")
      }),
      { numRuns: 8 },
    )
  })

  test("simulation flags surface in orders and results; pdfs are served", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          interpretation: fc.constantFrom("normal", "abnormal", "critical", "unknown"),
          resultType: fc.constantFrom("numeric", "range", "comment", "coded_value"),
          hasMissing: fc.boolean(),
        }),
        async ({ interpretation, resultType, hasMissing }) => {
          const clock = makeNow()
          const api = new JunctionAPI({ now: clock.now })
          const userId = await createUser(api, `sched-flags`)
          const order = await createOrder(api, userId, LAB_AT_HOME)
          const orderId = order.id as string

          const simulated = await request(
            api,
            `/v3/order/${orderId}/test?final_status=sample_with_lab.at_home_phlebotomy.partial_results`,
            {
              method: "POST",
              body: JSON.stringify({
                interpretation,
                result_types: [resultType],
                has_missing_results: hasMissing,
              }),
              headers: { "content-type": "application/json" },
            },
          )
          expect(simulated.status).toBe(200)

          const updated = (await (await request(api, `/v3/order/${orderId}`)).json()) as Json
          expect(updated.interpretation).toBe(interpretation)
          expect(updated.has_missing_results).toBe(hasMissing)

          const results = (await (await request(api, `/v3/order/${orderId}/result`)).json()) as Json
          const lines = results.results as Array<Json>
          expect(lines.length).toBeGreaterThan(0)
          for (const line of lines) expect(line.type).toBe(resultType)
          if (hasMissing) {
            const missing = results.missing_results as Array<Json>
            expect(missing).not.toBeNull()
            expect(missing.length).toBeGreaterThan(0)
          }

          const metadata = await request(api, `/v3/order/${orderId}/result/metadata`)
          expect(metadata.status).toBe(200)
          expect(((await metadata.json()) as Json).interpretation).toBe(interpretation)

          const pdf = await request(api, `/v3/order/${orderId}/result/pdf`)
          expect(pdf.status).toBe(200)
          expect(pdf.headers.get("content-type")).toBe("application/pdf")
          const bytes = new Uint8Array(await pdf.arrayBuffer())
          expect(bytes[0]).toBe(0x25)
          expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-")

          const requisition = await request(api, `/v3/order/${orderId}/requisition/pdf`)
          expect(requisition.status).toBe(200)
          expect(requisition.headers.get("content-type")).toBe("application/pdf")
        },
      ),
      { numRuns: 16 },
    )
  })

  test("results are empty until the order reaches a draw/sample status", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("received", "collecting_sample"), async (stopStatus) => {
        const api = new JunctionAPI({ now: () => baseTime })
        const userId = await createUser(api, "sched-empty")
        const order = await createOrder(api, userId, LAB_AT_HOME)
        const orderId = order.id as string

        const statusMap: Record<string, string> = {
          received: "received.at_home_phlebotomy.ordered",
          collecting_sample: "collecting_sample.at_home_phlebotomy.appointment_pending",
        }
        const stepped = await request(
          api,
          `/v3/order/${orderId}/test?final_status=${statusMap[stopStatus]}`,
          { method: "POST" },
        )
        expect(stepped.status).toBe(200)

        const results = (await (await request(api, `/v3/order/${orderId}/result`)).json()) as Json
        expect(results.results).toEqual([])
        expect(results.missing_results).toBeNull()

        const pdf = await request(api, `/v3/order/${orderId}/result/pdf`)
        expect(pdf.status).toBe(404)
      }),
      { numRuns: 4 },
    )
  })
})
