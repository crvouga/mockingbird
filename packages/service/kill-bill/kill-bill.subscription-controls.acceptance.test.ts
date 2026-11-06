import { describe, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "subscription-controls-test",
}
const session = async () => {
  const server = await createServer()
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`${server.url}/1.0/kb${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const clock = (date: string) => request(`/test/clock?requestedDate=${date}`, "POST")
  await clock("2030-01-01")
  const account = await request("/accounts", "POST", { currency: "USD" })
  const accountId = account.headers.get("location")?.split("/").at(-1) as string
  const created = await request("/subscriptions", "POST", {
    accountId,
    planName: "standard-monthly",
  })
  const subscriptionId = created.headers.get("location")?.split("/").at(-1) as string
  const subscription = () => request(`/subscriptions/${subscriptionId}`).then((r) => r.json())
  const invoices = () => request(`/accounts/${accountId}/invoices`).then((r) => r.json())
  const items = async () =>
    (
      (await request(`/accounts/${accountId}/invoices?includeInvoiceComponents=true`).then((r) =>
        r.json(),
      )) as Array<{ items: Array<{ itemType: string; startDate: string; amount: number }> }>
    ).flatMap((invoice) =>
      invoice.items.map((item) => `${item.itemType} ${item.startDate} ${item.amount}`),
    )
  return { server, request, clock, accountId, subscriptionId, subscription, invoices, items }
}
const blocking = (isBlockBilling: boolean, service = "example-service") => ({
  stateName: isBlockBilling ? "paused" : "resumed",
  service,
  isBlockBilling,
  isBlockChange: false,
  isBlockEntitlement: false,
})

describe("Kill Bill subscription billing controls", () => {
  test("billing pause retains subscriptions and bundles, suppresses renewal, and resumes by service", async () => {
    const s = await session()
    try {
      const path = `/subscriptions/${s.subscriptionId}/block`
      // Kill Bill 0.24.16 (parity scenario billing-pause-resume): a pause credits the rest of the
      // billed period, the paused renewals bill nothing, and a resume bills from that day.
      expect((await s.request(path, "POST", blocking(true))).status).toBe(201)
      expect((await s.subscription()).subscriptionId).toBe(s.subscriptionId)
      const bundles = await (await s.request(`/accounts/${s.accountId}/bundles`)).json()
      expect(bundles[0].subscriptions[0].subscriptionId).toBe(s.subscriptionId)
      const paused = await s.items()
      expect(paused).toContain("REPAIR_ADJ 2030-01-01 -100")
      expect((await s.clock("2030-02-01")).status).toBe(200)
      expect(await s.items()).toEqual(paused)
      // Another service cannot clear the original service's blocking state.
      await s.request(path, "POST", blocking(false, "another-service"))
      await s.clock("2030-02-02")
      expect(await s.items()).toEqual(paused)
      expect((await s.request(path, "POST", blocking(false))).status).toBe(201)
      expect(await s.items()).toContain("RECURRING 2030-02-02 96.43")
      expect((await s.request(path, "PUT", blocking(true))).status).toBe(405)
      const missing = await s.request("/subscriptions/missing/block", "POST", blocking(true))
      expect(missing.status).toBe(404)
      // Kill Bill 0.24.16: an unknown id is ObjectDoesNotExist.
      expect((await missing.json()).message).toBe(
        "Object id=missing type=SUBSCRIPTION doesn't exist!",
      )
    } finally {
      await s.server.close()
    }
  })

  test("an entitlement block marks the subscription BLOCKED and records pause and resume events", async () => {
    const s = await session()
    try {
      const path = `/subscriptions/${s.subscriptionId}/block`
      // Kill Bill 0.24.16: 201, state BLOCKED, then PAUSE_/RESUME_ENTITLEMENT and _BILLING events.
      expect(
        (await s.request(path, "POST", { ...blocking(true), isBlockEntitlement: true })).status,
      ).toBe(201)
      const paused = await s.subscription()
      expect(paused.state).toBe("BLOCKED")
      expect(paused.events.map((event: { eventType: string }) => event.eventType)).toEqual([
        "START_ENTITLEMENT",
        "START_BILLING",
        "PAUSE_ENTITLEMENT",
        "PAUSE_BILLING",
      ])
      expect((await s.request(path, "POST", blocking(false))).status).toBe(201)
      const resumed = await s.subscription()
      expect(resumed.state).toBe("ACTIVE")
      expect(
        resumed.events.slice(4).map((event: { eventType: string }) => event.eventType),
      ).toEqual(["RESUME_ENTITLEMENT", "RESUME_BILLING"])
    } finally {
      await s.server.close()
    }
  })

  test("future blocking states take effect on their requested date; malformed flags do not mutate", async () => {
    const s = await session()
    try {
      const path = `/subscriptions/${s.subscriptionId}/block`
      const before = await s.subscription()
      for (const flag of ["isBlockChange", "isBlockEntitlement"])
        expect((await s.request(path, "POST", { ...blocking(true), [flag]: "true" })).status).toBe(
          400,
        )
      expect(await s.subscription()).toEqual(before)
      expect(
        (await s.request(`${path}?requestedDate=2030-02-30`, "POST", blocking(true))).status,
      ).toBe(400)
      await s.request(`${path}?requestedDate=2030-03-01`, "POST", blocking(true))
      const initial = (await s.invoices()).length
      await s.clock("2030-02-01")
      expect((await s.invoices()).length).toBe(initial + 1)
      await s.clock("2030-03-03")
      expect((await s.invoices()).length).toBe(initial + 1)
    } finally {
      await s.server.close()
    }
  })

  test("BCD routes without a plan, defers until effective date and aligns monthly renewals", async () => {
    const s = await session()
    try {
      const path = `/subscriptions/${s.subscriptionId}/bcd`
      expect(
        (
          await s.request(`${path}?effectiveFromDate=2030-02-01`, "PUT", {
            subscriptionId: s.subscriptionId,
            billCycleDayLocal: 5,
          })
        ).status,
      ).toBe(204)
      const initial = (await s.invoices()).length
      // Kill Bill 0.24.16 (test clock): the January period ends 02-01 on the old day; on 02-01 a
      // 02-01..02-05 stub is billed at 4/28 of the month, then renewals fall on the 5th.
      await s.clock("2030-01-31")
      expect((await s.invoices()).length).toBe(initial)
      await s.clock("2030-02-01")
      expect((await s.invoices()).length).toBe(initial + 1)
      expect((await s.subscription()).billCycleDayLocal).toBe(1)
      await s.clock("2030-02-05")
      expect((await s.invoices()).length).toBe(initial + 2)
      expect((await s.subscription()).billCycleDayLocal).toBe(5)
      await s.clock("2030-03-04")
      expect((await s.invoices()).length).toBe(initial + 2)
      await s.clock("2030-03-05")
      expect((await s.invoices()).length).toBe(initial + 3)
      expect((await s.subscription()).chargedThroughDate).toBe("2030-04-05")
      const items = (
        await (
          await s.request(`/accounts/${s.accountId}/invoices?includeInvoiceComponents=true`)
        ).json()
      ).flatMap(
        (invoice: { items: Array<{ startDate: string; endDate: string; amount: number }> }) =>
          invoice.items.map((item) => `${item.startDate}..${item.endDate} ${item.amount}`),
      )
      expect(items).toContain("2030-02-01..2030-02-05 14.29")
      expect(items).toContain("2030-02-05..2030-03-05 100")
      const missing = await s.request("/subscriptions/missing/bcd", "PUT", { billCycleDayLocal: 5 })
      expect(missing.status).toBe(404)
      // Kill Bill 0.24.16: an unknown id is ObjectDoesNotExist.
      expect((await missing.json()).message).toBe(
        "Object id=missing type=SUBSCRIPTION doesn't exist!",
      )
    } finally {
      await s.server.close()
    }
  })

  test("a second BCD change is explicitly unsupported and preserves the existing renewal schedule", async () => {
    const s = await session()
    try {
      const path = `/subscriptions/${s.subscriptionId}/bcd`
      expect((await s.request(path, "PUT", { billCycleDayLocal: 5 })).status).toBe(204)
      const before = await s.subscription()
      const response = await s.request(`${path}?effectiveFromDate=2030-03-01`, "PUT", {
        billCycleDayLocal: 20,
      })
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe("UNSUPPORTED_BCD")
      expect(await s.subscription()).toEqual(before)
      const initial = (await s.invoices()).length
      // Kill Bill 0.24.16 (test clock): BCD 5 from the start day bills the 02-01..02-05 stub on
      // 01-05 at 4/31 of the new 01-05..02-05 period, then renews on the 5th.
      await s.clock("2030-01-04")
      expect((await s.invoices()).length).toBe(initial)
      await s.clock("2030-01-05")
      expect((await s.invoices()).length).toBe(initial + 1)
      await s.clock("2030-02-05")
      expect((await s.invoices()).length).toBe(initial + 2)
      expect((await s.subscription()).chargedThroughDate).toBe("2030-03-05")
    } finally {
      await s.server.close()
    }
  })

  test("BCD validates days and dates without mutation and clamps month ends", async () => {
    const s = await session()
    try {
      const path = `/subscriptions/${s.subscriptionId}/bcd`
      const before = await s.subscription()
      for (const day of [0, 32, 1.5, "5"])
        expect((await s.request(path, "PUT", { billCycleDayLocal: day })).status).toBe(400)
      expect(
        (await s.request(`${path}?effectiveFromDate=2030-02-30`, "PUT", { billCycleDayLocal: 5 }))
          .status,
      ).toBe(400)
      expect(
        (await s.request(`${path}?effectiveFromDate=2029-12-01`, "PUT", { billCycleDayLocal: 5 }))
          .status,
      ).toBe(400)
      expect(
        (await s.request(path, "PUT", { subscriptionId: "mismatched", billCycleDayLocal: 5 }))
          .status,
      ).toBe(400)
      expect(
        (
          await s.request(`${path}?forceNewBcdWithPastEffectiveDate=true`, "PUT", {
            billCycleDayLocal: 5,
          })
        ).status,
      ).toBe(400)
      expect(await s.subscription()).toEqual(before)
      expect((await s.request(path, "PUT", { billCycleDayLocal: 31 })).status).toBe(204)
      await s.clock("2030-01-31")
      expect((await s.subscription()).chargedThroughDate).toBe("2030-02-28")
      await s.clock("2030-02-28")
      expect((await s.subscription()).chargedThroughDate).toBe("2030-03-31")
    } finally {
      await s.server.close()
    }
  })
})
