import { describe, expect, test } from "bun:test"
import { createClock } from "@crvouga/mockingbird-service"
import { createRuntime, KillBillAPI } from "./src/index.js"
import { createServer } from "./src/server.js"

type SubscriptionEvents = { events: Array<{ eventType: string; plan: string }> }
/** The plans of the subscription's CHANGE events. */
const changes = (subscription: SubscriptionEvents) =>
  subscription.events.filter((event) => event.eventType === "CHANGE").map((event) => event.plan)

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "acceptance-test",
}

describe("Kill Bill REST adapter", () => {
  test("runs account, subscription, invoice, payment, refund, retry, and webhook flows", async () => {
    const deliveries: Array<{ eventType: string; secret: string }> = []
    const server = await createServer({
      webhooks: {
        endpoints: [
          { url: "https://sink.test/kill-bill", secret: "webhook-secret", events: ["*"] },
        ],
        fetch: async (request) => {
          deliveries.push({
            eventType: ((await request.json()) as { eventType: string }).eventType,
            secret: request.headers.get("x-killbill-webhook-secret") ?? "",
          })
          return new Response(null, { status: 204 })
        },
      },
    })
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    const post = (path: string, body: unknown) =>
      request(path, { method: "POST", body: JSON.stringify(body) })
    try {
      expect((await fetch(`${server.url}/1.0/healthcheck`)).status).toBe(200)
      expect((await fetch(`${server.url}/1.0/kb/accounts`)).status).toBe(401)
      expect(
        (
          await request("/accounts", {
            method: "POST",
            headers: { "x-killbill-createdby": "" },
            body: "{}",
          })
        ).status,
      ).toBe(400)

      const created = await post("/accounts", {
        externalKey: "acct-ext",
        currency: "USD",
        name: "Ada",
      })
      expect(created.status).toBe(201)
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const duplicateAccount = await post("/accounts", {
        externalKey: "acct-ext",
        currency: "USD",
      })
      expect(duplicateAccount.status).toBe(409)
      expect(await duplicateAccount.json()).toEqual({
        className: "org.killbill.billing.account.api.AccountApiException",
        code: 3000,
        message: "Account already exists for key acct-ext",
        causeClassName: null,
        causeMessage: null,
        stackTrace: [],
      })
      expect(await json<{ accountId: string }>("/accounts?externalKey=acct-ext")).toMatchObject({
        accountId,
      })

      const method = await post(`/accounts/${accountId}/paymentMethods?isDefault=true`, {
        externalKey: "pm-ext",
        pluginName: "stripe",
      })
      const paymentMethodId = method.headers.get("location")?.split("/").at(-1) as string
      expect(
        (await json<Array<{ isDefault: boolean }>>(`/accounts/${accountId}/paymentMethods`))[0]
          ?.isDefault,
      ).toBe(true)
      expect((await post(`/accounts/${accountId}/tags`, ["tag-vip"])).status).toBe(201)

      const subscription = await post("/subscriptions", {
        accountId,
        externalKey: "sub-ext",
        planName: "standard-monthly",
      })
      const subscriptionId = subscription.headers.get("location")?.split("/").at(-1) as string
      expect(subscription.headers.get("location")).toEndWith(`/subscriptions/${subscriptionId}`)
      const bundles = await json<
        Array<{ bundleId: string; subscriptions: Array<{ subscriptionId: string }> }>
      >(`/accounts/${accountId}/bundles`)
      expect(bundles[0]?.subscriptions[0]?.subscriptionId).toBe(subscriptionId)
      expect(
        (await json<Array<{ balance: number }>>(`/accounts/${accountId}/invoices`))[0]?.balance,
      ).toBe(0)

      await post("/catalog", {
        plans: [{ name: "plus-monthly", amount: 125.5, currency: "USD", intervalDays: 30 }],
      })
      expect(
        (
          await request(`/subscriptions/${subscriptionId}?billingPolicy=END_OF_TERM`, {
            method: "PUT",
            body: JSON.stringify({ planName: "plus-monthly" }),
          })
        ).status,
      ).toBe(204)
      // Kill Bill 0.24.16 reports a scheduled change as a CHANGE event, not a field.
      expect(changes(await json<SubscriptionEvents>(`/subscriptions/${subscriptionId}`))).toEqual([
        "plus-monthly",
      ])
      await request(`/subscriptions/${subscriptionId}/changePlan`, { method: "DELETE" })
      expect(changes(await json<SubscriptionEvents>(`/subscriptions/${subscriptionId}`))).toEqual(
        [],
      )
      await request(`/subscriptions/${subscriptionId}`, { method: "DELETE" })
      await request(`/subscriptions/${subscriptionId}/uncancel`, { method: "PUT", body: "{}" })
      expect((await json<{ state: string }>(`/subscriptions/${subscriptionId}`)).state).toBe(
        "ACTIVE",
      )

      const charge = await post(`/invoices/charges/${accountId}`, [
        { amount: 10.01, currency: "USD", description: "Usage" },
      ])
      const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
      const paid = await post(`/invoices/${invoiceId}/payments`, {
        amount: 10.01,
        paymentMethodId,
        paymentExternalKey: "pay-ext",
        transactionExternalKey: "txn-ext",
      })
      const paymentId = paid.headers.get("location")?.split("/").at(-1) as string
      // Kill Bill 0.24.10 answers any payment on a settled invoice with 204, a retry included.
      const duplicate = await post(`/invoices/${invoiceId}/payments`, {
        amount: 10.01,
        paymentMethodId,
        paymentExternalKey: "pay-ext",
      })
      expect(duplicate.status).toBe(204)
      expect(
        (await json<{ paymentId: string }[]>(`/invoices/${invoiceId}/payments`)).map(
          (payment) => payment.paymentId,
        ),
      ).toEqual([paymentId])
      await post(`/payments/${paymentId}/refunds`, {
        amount: 3.33,
        transactionExternalKey: "refund-ext",
      })
      expect(await json<{ refundedAmount: number }>(`/payments/${paymentId}`)).toMatchObject({
        refundedAmount: 3.33,
      })
      const adjusted = await json<{
        balance: number
        refundAdj: number
        items: Array<{ invoiceItemId: string; itemType: string; linkedInvoiceItemId?: string }>
      }>(`/invoices/${invoiceId}`)
      // Kill Bill 0.24.16 (parity scenario refund-adjusted): a refund without item adjustments
      // reopens the balance and lowers refundAdj; it adds no invoice item.
      expect(adjusted).toMatchObject({ balance: 3.33, refundAdj: -3.33 })
      expect(adjusted.items.map((item) => item.itemType)).not.toContain("ITEM_ADJ")

      const voidable = await post(`/invoices/charges/${accountId}`, [{ amount: 4.25 }])
      expect(
        (
          await request(`/invoices/${voidable.headers.get("location")?.split("/").at(-1)}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(204)
      await fetch(`${server.url}/__admin/payments/decline-next`, { method: "POST" })
      const failed = await post(
        `/accounts/payments?externalKey=acct-ext&paymentMethodId=${paymentMethodId}`,
        { amount: 5, paymentExternalKey: "failed-pay" },
      )
      const failedId = failed.headers.get("location")?.split("/").at(-1) as string
      expect(
        (await json<{ transactions: Array<{ status: string }> }>(`/payments/${failedId}`))
          .transactions[0]?.status,
      ).toBe("PAYMENT_FAILURE")
      const retried = await fetch(`${server.url}/__admin/payments/${failedId}/retry`, {
        method: "POST",
      })
      expect(
        ((await retried.json()) as { transactions: Array<{ status: string }> }).transactions.at(-1)
          ?.status,
      ).toBe("SUCCESS")

      expect(
        (
          await request("/catalog", {
            method: "POST",
            headers: { "content-type": "application/xml" },
            body: '<catalog><plan name="xml-plan" amount="9.99"/></catalog>',
          })
        ).status,
      ).toBe(201)
      const catalog =
        await json<Array<{ products: Array<{ plans: Array<{ name: string }> }> }>>("/catalog")
      expect(Array.isArray(catalog)).toBe(true)
      expect(
        catalog
          .at(-1)
          ?.products.some((product) => product.plans.some((plan) => plan.name === "xml-plan")),
      ).toBe(true)
      await server.runtime.webhooks.idle()
      expect(deliveries.length).toBeGreaterThan(5)
      expect(deliveries.every(({ secret }) => secret === "webhook-secret")).toBe(true)
    } finally {
      await server.close()
    }
  })
  test("GET /1.0/kb/catalog returns a catalog-version array", async () => {
    const clock = createClock(() => Date.parse("2020-01-02T03:04:05.000Z"))
    const mock = createRuntime({
      clock,
      plans: [{ name: "example-monthly", amount: 10, currency: "USD" }],
    })
    const response = await mock.fetch(
      new Request("http://mock/1.0/kb/catalog", {
        headers: {
          authorization: `Basic ${btoa("admin:password")}`,
          accept: "application/json",
          "x-killbill-apikey": "bob",
          "x-killbill-apisecret": "lazar",
        },
      }),
    )
    expect(response.status).toBe(200)
    const versions = (await response.json()) as Array<{
      name: string
      effectiveDate: string
      currencies: string[]
      units: unknown[]
      plans?: Array<{ name: string }>
      products: Array<{
        type: string
        name: string
        prettyName: string
        plans: Array<{
          name: string
          prettyName: string
          recurringBillingMode: string
          billingPeriod: string
          phases: Array<{
            type: string
            prices: Array<{ currency: string; value: number }>
            fixedPrices: unknown[]
            duration: { unit: string; number: number }
            usages: unknown[]
          }>
        }>
        included: unknown[]
        available: unknown[]
      }>
      priceLists: Array<{ name: string; plans: string[] }>
    }>
    expect(Array.isArray(versions)).toBe(true)
    const latest = versions.at(-1)
    expect(latest?.plans).toBeUndefined()
    expect(
      (latest?.products ?? []).flatMap((product) => product.plans.map((plan) => plan.name)),
    ).toEqual(["example-monthly"])
    expect(latest).toEqual({
      name: "default",
      effectiveDate: "2020-01-02T03:04:05.000Z",
      currencies: ["USD"],
      units: [],
      products: [
        {
          type: "BASE",
          name: "example-monthly",
          prettyName: "example-monthly",
          plans: [
            {
              name: "example-monthly",
              prettyName: "example-monthly",
              recurringBillingMode: "IN_ADVANCE",
              billingPeriod: "MONTHLY",
              phases: [
                {
                  type: "EVERGREEN",
                  prices: [{ currency: "USD", value: 10 }],
                  fixedPrices: [],
                  duration: { unit: "UNLIMITED", number: -1 },
                  usages: [],
                },
              ],
            },
          ],
          included: [],
          available: [],
        },
      ],
      priceLists: [{ name: "DEFAULT", plans: ["example-monthly"] }],
    })
  })

  test("stores plans from a Kill Bill catalog XML document", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const plans = async () => {
      const versions = (await (await request("/catalog")).json()) as Array<{
        products: Array<{
          plans: Array<{
            name: string
            billingPeriod: string
            phases: Array<{ prices: Array<{ currency?: string; value: number }> }>
          }>
        }>
      }>
      // The evergreen phase is the last one (a TRIAL phase comes first).
      return (versions.at(-1)?.products ?? []).flatMap((product) =>
        product.plans.map((plan) => ({
          name: plan.name,
          amount: plan.phases.at(-1)?.prices[0]?.value,
          currency: plan.phases.at(-1)?.prices[0]?.currency,
          billingPeriod: plan.billingPeriod,
        })),
      )
    }
    const catalogXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<catalog>
  <effectiveDate>2026-01-01T00:00:00Z</effectiveDate>
  <products>
    <product name="Example">
      <plans>
        <plan name="example-monthly">
          <finalPhase type="EVERGREEN">
            <duration><unit>UNLIMITED</unit></duration>
            <recurring>
              <billingPeriod>MONTHLY</billingPeriod>
              <recurringPrice>
                <price><currency>USD</currency><value>10.00</value></price>
              </recurringPrice>
            </recurring>
          </finalPhase>
        </plan>
      </plans>
    </product>
  </products>
</catalog>`
    const versionedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<catalog>
  <effectiveDate>2026-02-01T00:00:00+00:00</effectiveDate>
  <catalogName>Example</catalogName>
  <currencies><currency>USD</currency><currency>GBP</currency></currencies>
  <products>
    <product name="Example"><category>BASE</category></product>
  </products>
  <rules></rules>
  <plans>
    <plan name="sibling-monthly">
      <product>Example</product>
      <initialPhases>
        <phase type="TRIAL">
          <duration><unit>DAYS</unit><number>14</number></duration>
          <recurring>
            <billingPeriod>DAILY</billingPeriod>
            <recurringPrice>
              <price><currency>USD</currency><value>0.00</value></price>
            </recurringPrice>
          </recurring>
        </phase>
      </initialPhases>
      <finalPhase type="EVERGREEN">
        <duration><unit>UNLIMITED</unit></duration>
        <recurring>
          <billingPeriod>ANNUAL</billingPeriod>
          <recurringPrice>
            <price><currency>GBP</currency><value>5.00</value></price>
            <price><currency>USD</currency><value>12.50</value></price>
          </recurringPrice>
        </recurring>
      </finalPhase>
    </plan>
  </plans>
  <priceLists>
    <defaultPriceList name="DEFAULT">
      <plans><plan>sibling-monthly</plan></plans>
    </defaultPriceList>
  </priceLists>
</catalog>`
    try {
      const posted = await request("/catalog/xml", {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: catalogXml,
      })
      expect(posted.status).toBe(201)
      expect(await plans()).toContainEqual({
        name: "example-monthly",
        amount: 10,
        currency: "USD",
        billingPeriod: "MONTHLY",
      })
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "catalog-acct", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      expect(
        (
          await request("/subscriptions", {
            method: "POST",
            body: JSON.stringify({ accountId, planName: "example-monthly" }),
          })
        ).status,
      ).toBe(201)
      expect(
        (
          await request("/catalog/xml", {
            method: "POST",
            headers: { "content-type": "text/xml" },
            body: versionedXml,
          })
        ).status,
      ).toBe(201)
      const stored = await plans()
      expect(stored).toContainEqual({
        name: "sibling-monthly",
        amount: 12.5,
        currency: "USD",
        billingPeriod: "ANNUAL",
      })
      expect(stored.some((plan) => plan.name === "sibling-monthly" && plan.amount === 0)).toBe(
        false,
      )
      expect(
        stored.some((plan) => plan.name === "sibling-monthly" && plan.billingPeriod === "DAILY"),
      ).toBe(false)
    } finally {
      await server.close()
    }
  })

  test("create subscription Location is the subscription and the document includes phaseType", async () => {
    const api = new KillBillAPI({
      plans: [{ name: "example-monthly", amount: 10, currency: "USD" }],
    })
    const call = (path: string, init: RequestInit = {}) =>
      api.fetch(
        new Request(`http://mock/1.0/kb${path}`, {
          ...init,
          headers: { ...headers, ...init.headers },
        }),
      )
    const account = await call("/accounts", {
      method: "POST",
      body: JSON.stringify({ externalKey: "member-1", currency: "USD" }),
    })
    const accountId = account.headers.get("location")?.split("/").pop()
    const created = await call("/subscriptions", {
      method: "POST",
      body: JSON.stringify({ accountId, planName: "example-monthly" }),
    })
    const location = created.headers.get("location") ?? ""
    const subscriptionId = location.split("/").pop()
    const follow = await api.fetch(new Request(location, { headers }))
    const document = (await follow.json()) as {
      subscriptionId: string
      bundleId: string
      accountId: string
      planName: string
      phaseType: string
      state: string
      startDate: string
      chargedThroughDate: string
    }
    const addon = await call("/subscriptions?requestedDate=2024-01-15", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        bundleId: document.bundleId,
        planName: "example-monthly",
      }),
    })
    const addonLocation = addon.headers.get("location") ?? ""
    const addonId = addonLocation.split("/").pop()
    const addonFollow = await api.fetch(new Request(addonLocation, { headers }))

    expect(created.status).toBe(201)
    expect(await created.text()).toBe("")
    expect(location).toEndWith(`/1.0/kb/subscriptions/${subscriptionId}`)
    expect(follow.status).toBe(200)
    expect(document).toMatchObject({
      subscriptionId,
      accountId,
      planName: "example-monthly",
      phaseType: "EVERGREEN",
      state: "ACTIVE",
    })
    expect(typeof document.bundleId).toBe("string")
    expect(document.bundleId).not.toBe(subscriptionId)
    // Kill Bill 0.24.16 reports startDate as the creation instant, chargedThroughDate as a day.
    expect(document.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(document.chargedThroughDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(addon.status).toBe(201)
    expect(addonLocation).toEndWith(`/1.0/kb/subscriptions/${addonId}`)
    expect(addonId).not.toBe(document.bundleId)
    expect(addonId).not.toBe(subscriptionId)
    expect(await addonFollow.json()).toMatchObject({
      subscriptionId: addonId,
      bundleId: document.bundleId,
      accountId,
      planName: "example-monthly",
      phaseType: "EVERGREEN",
      state: "ACTIVE",
    })
  })

  test("GET /test/clock returns Kill Bill's currentUtcTime, localDate, and timeZone", async () => {
    const fixed = Date.parse("2026-09-29T02:30:00.000Z")
    const api = new KillBillAPI({ now: () => fixed })
    const clock = (path: string, init: RequestInit = {}) =>
      api.fetch(new Request(`http://mock/1.0/kb${path}`, { ...init, headers }))
    const body = (await (await clock("/test/clock")).json()) as Record<string, unknown>
    expect(body).toEqual({
      currentUtcTime: "2026-09-29T02:30:00.000Z",
      timeZone: "UTC",
      localDate: "2026-09-29",
    })
    expect(body).not.toHaveProperty("utc")

    expect(await (await clock("/test/clock?timeZone=America/Los_Angeles")).json()).toEqual({
      currentUtcTime: "2026-09-29T02:30:00.000Z",
      timeZone: "America/Los_Angeles",
      localDate: "2026-09-28",
    })
    expect(await (await clock("/test/clock?timeZone=-08:00")).json()).toEqual({
      currentUtcTime: "2026-09-29T02:30:00.000Z",
      timeZone: "-08:00",
      localDate: "2026-09-28",
    })
    expect((await clock("/test/clock?timeZone=Not/AZone")).status).toBe(400)

    const moved = await clock("/test/clock?requestedDate=2015-12-14T23:02:15.000Z", {
      method: "PUT",
    })
    expect(moved.status).toBe(200)
    expect(await moved.json()).toEqual({
      currentUtcTime: "2015-12-14T23:02:15.000Z",
      timeZone: "UTC",
      localDate: "2015-12-14",
    })
    expect(await (await clock("/test/clock")).json()).toMatchObject({
      currentUtcTime: "2015-12-14T23:02:15.000Z",
    })
  })

  test("lists invoice payments with targetInvoiceId and records one external purchase", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    const post = (path: string, body: unknown) =>
      request(path, { method: "POST", body: JSON.stringify(body) })
    try {
      const created = await post("/accounts", { externalKey: "ext-pay", currency: "USD" })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const charge = await post(`/invoices/charges/${accountId}`, [
        { amount: 10, currency: "USD", description: "Visit" },
      ])
      const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
      await fetch(`${server.url}/__admin/payments/decline-next`, { method: "POST" })
      const paid = await post(`/invoices/${invoiceId}/payments?externalPayment=true`, {
        accountId,
        purchasedAmount: 10,
        currency: "USD",
        paymentExternalKey: "ext-pay-1",
      })
      expect(paid.status).toBe(201)
      const paymentId = paid.headers.get("location")?.split("/").at(-1) as string
      const duplicate = await post(`/invoices/${invoiceId}/payments?externalPayment=true`, {
        accountId,
        purchasedAmount: 10,
        currency: "USD",
        paymentExternalKey: "ext-pay-1",
      })
      expect(duplicate.status).toBe(204)
      expect(duplicate.headers.get("location")).toBeNull()
      const payments = await json<
        Array<{
          targetInvoiceId?: string
          invoiceId?: string
          accountId: string
          paymentId: string
          paymentExternalKey: string
          paymentMethodId?: string
          purchasedAmount: number
          refundedAmount: number
          currency: string
          transactions: Array<{
            transactionId: string
            transactionExternalKey: string
            paymentId: string
            transactionType: string
            amount: number
            currency: string
            status: string
          }>
        }>
      >(`/invoices/${invoiceId}/payments`)
      expect(payments).toHaveLength(1)
      expect(payments[0]).toMatchObject({
        targetInvoiceId: invoiceId,
        accountId,
        paymentId,
        paymentExternalKey: "ext-pay-1",
        purchasedAmount: 10,
        refundedAmount: 0,
        currency: "USD",
      })
      expect(payments[0]).not.toHaveProperty("invoiceId")
      expect(payments[0]?.paymentMethodId).toEqual(expect.any(String))
      expect(payments[0]?.transactions[0]).toEqual(
        expect.objectContaining({
          transactionId: expect.any(String),
          transactionExternalKey: expect.any(String),
          paymentId,
          transactionType: "PURCHASE",
          amount: 10,
          currency: "USD",
          status: "SUCCESS",
        }),
      )
      expect((await json<{ balance: number }>(`/invoices/${invoiceId}`)).balance).toBe(0)
      const method = await json<{ pluginName: string }>(
        `/paymentMethods/${payments[0]?.paymentMethodId}`,
      )
      expect(method.pluginName).toBe("__EXTERNAL_PAYMENT__")

      const card = await post(`/accounts/${accountId}/paymentMethods?isDefault=true`, {
        pluginName: "stripe",
      })
      const paymentMethodId = card.headers.get("location")?.split("/").at(-1) as string
      const second = await post(`/invoices/charges/${accountId}`, [{ amount: 4, currency: "USD" }])
      const secondInvoiceId = second.headers.get("location")?.split("/").at(-1) as string
      const gateway = await post(`/invoices/${secondInvoiceId}/payments`, {
        amount: 4,
        paymentMethodId,
        paymentExternalKey: "gateway-pay",
      })
      const gatewayId = gateway.headers.get("location")?.split("/").at(-1) as string
      expect(
        (await json<{ transactions: Array<{ status: string }> }>(`/payments/${gatewayId}`))
          .transactions[0]?.status,
      ).toBe("PAYMENT_FAILURE")
    } finally {
      await server.close()
    }
  })
})

describe("Kill Bill tenants and notification callbacks", () => {
  const basic = {
    authorization: `Basic ${btoa("admin:password")}`,
    "content-type": "application/json",
    "x-killbill-createdby": "acceptance-test",
  }
  const call = (url: string, path: string, init: RequestInit = {}, extra: HeadersInit = {}) =>
    fetch(`${url}/1.0/kb${path}`, {
      ...init,
      headers: { ...basic, ...extra, ...init.headers },
    })
  const tenantHeaders = (apiKey: string, apiSecret: string) => ({
    "x-killbill-apikey": apiKey,
    "x-killbill-apisecret": apiSecret,
  })
  const createTenant = async (
    url: string,
    apiKey: string,
    apiSecret: string,
    externalKey: string,
  ) =>
    call(url, "/tenants", {
      method: "POST",
      body: JSON.stringify({ apiKey, apiSecret, externalKey }),
    })

  test("creates a tenant and rejects a duplicate api key", async () => {
    const server = await createServer()
    try {
      const created = await createTenant(server.url, "tenant-a", "secret-a", "env-a")
      expect(created.status).toBe(201)
      const duplicate = await createTenant(server.url, "tenant-a", "other-secret", "env-b")
      expect(duplicate.status).toBe(409)
    } finally {
      await server.close()
    }
  })

  test("looks up a tenant by api key with basic auth only", async () => {
    const server = await createServer()
    try {
      expect((await createTenant(server.url, "tenant-a", "secret-a", "env-a")).status).toBe(201)
      const found = await call(server.url, "/tenants?apiKey=tenant-a")
      expect(found.status).toBe(200)
      expect(await found.json()).toMatchObject({ apiKey: "tenant-a", externalKey: "env-a" })
      expect((await call(server.url, "/tenants?apiKey=missing")).status).not.toBe(200)
    } finally {
      await server.close()
    }
  })

  test("does not return another tenant's account", async () => {
    const server = await createServer()
    try {
      expect((await createTenant(server.url, "tenant-a", "secret-a", "env-a")).status).toBe(201)
      expect((await createTenant(server.url, "tenant-b", "secret-b", "env-b")).status).toBe(201)
      const created = await call(
        server.url,
        "/accounts",
        { method: "POST", body: JSON.stringify({ externalKey: "acct-ext", currency: "USD" }) },
        tenantHeaders("tenant-a", "secret-a"),
      )
      expect(created.status).toBe(201)
      const hidden = await call(
        server.url,
        "/accounts?externalKey=acct-ext",
        {},
        tenantHeaders("tenant-b", "secret-b"),
      )
      expect(hidden.status).not.toBe(200)
      const visible = await call(
        server.url,
        "/accounts?externalKey=acct-ext",
        {},
        tenantHeaders("tenant-a", "secret-a"),
      )
      expect(visible.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  test("registers a notification callback url", async () => {
    const server = await createServer()
    const callback = "https://example.test/kb/"
    try {
      expect((await createTenant(server.url, "tenant-a", "secret-a", "env-a")).status).toBe(201)
      const headers = tenantHeaders("tenant-a", "secret-a")
      const registered = await call(
        server.url,
        `/tenants/registerNotificationCallback?cb=${encodeURIComponent(callback)}`,
        { method: "POST" },
        headers,
      )
      expect(registered.status).toBe(201)
      const listed = await call(server.url, "/tenants/registerNotificationCallback", {}, headers)
      expect(listed.status).toBe(200)
      const body = (await listed.json()) as { values?: string[] }
      expect(body.values?.[0]).toBe(callback)
    } finally {
      await server.close()
    }
  })

  test("returns only the new callback url after delete", async () => {
    const server = await createServer()
    const first = "https://example.test/old/"
    const next = "https://example.test/new/"
    try {
      expect((await createTenant(server.url, "tenant-a", "secret-a", "env-a")).status).toBe(201)
      const headers = tenantHeaders("tenant-a", "secret-a")
      expect(
        (
          await call(
            server.url,
            `/tenants/registerNotificationCallback?cb=${encodeURIComponent(first)}`,
            { method: "POST" },
            headers,
          )
        ).status,
      ).toBe(201)
      expect(
        (
          await call(
            server.url,
            "/tenants/registerNotificationCallback",
            { method: "DELETE" },
            headers,
          )
        ).status,
      ).toBe(204)
      expect(
        (
          await call(
            server.url,
            `/tenants/registerNotificationCallback?cb=${encodeURIComponent(next)}`,
            { method: "POST" },
            headers,
          )
        ).status,
      ).toBe(201)
      const listed = await call(server.url, "/tenants/registerNotificationCallback", {}, headers)
      expect(listed.status).toBe(200)
      expect(await listed.json()).toMatchObject({ values: [next] })
    } finally {
      await server.close()
    }
  })

  test("posts invoice or payment notifications to the registered callback", async () => {
    const posted: Array<{
      method: string
      type: string | null
      agent: string | null
      objectType: string
    }> = []
    const hooked: string[] = []
    const sink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { objectType?: string }
        posted.push({
          method: request.method,
          type: request.headers.get("content-type"),
          agent: request.headers.get("user-agent"),
          objectType: body.objectType ?? "",
        })
        return new Response(null, { status: 204 })
      },
    })
    const server = await createServer({
      webhooks: {
        endpoints: [
          { url: "https://sink.test/kill-bill", secret: "webhook-secret", events: ["*"] },
        ],
        // The injected transport also carries tenant callbacks (issue #739); it forwards those.
        fetch: async (request) => {
          if (!request.url.startsWith("https://sink.test/")) return fetch(request)
          hooked.push(((await request.json()) as { objectType?: string }).objectType ?? "")
          return new Response(null, { status: 204 })
        },
      },
    })
    const callback = `http://127.0.0.1:${sink.port}/kb`
    try {
      expect((await createTenant(server.url, "tenant-a", "secret-a", "env-a")).status).toBe(201)
      const headers = tenantHeaders("tenant-a", "secret-a")
      expect(
        (
          await call(
            server.url,
            `/tenants/registerNotificationCallback?cb=${encodeURIComponent(callback)}`,
            { method: "POST" },
            headers,
          )
        ).status,
      ).toBe(201)
      const created = await call(
        server.url,
        "/accounts",
        { method: "POST", body: JSON.stringify({ externalKey: "acct-ext", currency: "USD" }) },
        headers,
      )
      const accountId = created.headers.get("location")?.split("/").at(-1)
      expect(accountId).toBeTruthy()
      expect(
        (
          await call(
            server.url,
            `/invoices/charges/${accountId}`,
            { method: "POST", body: JSON.stringify([{ amount: 10, currency: "USD" }]) },
            headers,
          )
        ).status,
      ).toBe(201)
      await server.runtime.webhooks.idle()
      // Kill Bill delivers tenant callbacks after the request; GET /test/queues waits for them.
      await call(server.url, "/test/queues?timeoutSec=10", {}, headers)
      const invoiceOrPayment = (objectType: string) =>
        objectType === "INVOICE" || objectType === "PAYMENT"
      expect(posted.some((event) => invoiceOrPayment(event.objectType))).toBe(true)
      expect(
        posted
          .filter((event) => invoiceOrPayment(event.objectType))
          .every((event) => event.method === "POST"),
      ).toBe(true)
      expect(posted.every((event) => event.type?.includes("application/json"))).toBe(true)
      expect(posted.every((event) => event.agent === "KillBill/1.0")).toBe(true)
      expect(hooked.some(invoiceOrPayment)).toBe(true)
    } finally {
      sink.stop(true)
      await server.close()
    }
  })

  test("undoChangePlan restores the plan that was current before a pending change", async () => {
    const server = await createServer({
      plans: [
        { name: "example-monthly", amount: 10, currency: "USD" },
        { name: "example-annual", amount: 100, currency: "USD" },
      ],
    })
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    try {
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "undo-acct", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const createdSubscription = await request("/subscriptions", {
        method: "POST",
        body: JSON.stringify({ accountId, planName: "example-monthly" }),
      })
      const location = createdSubscription.headers.get("location") ?? ""
      const subscriptionId = location.split("/").at(-1) as string
      expect(location).toEndWith(`/subscriptions/${subscriptionId}`)
      expect(
        (
          await request(`/subscriptions/${subscriptionId}?billingPolicy=END_OF_TERM`, {
            method: "PUT",
            body: JSON.stringify({ planName: "example-annual" }),
          })
        ).status,
      ).toBe(204)
      const undone = await request(`/subscriptions/${subscriptionId}/undoChangePlan`, {
        method: "PUT",
      })
      expect(undone.status).toBe(204)
      expect(await undone.text()).toBe("")
      expect(await (await request(`/subscriptions/${subscriptionId}`)).json()).toMatchObject({
        planName: "example-monthly",
      })
      const current = (await (
        await request(`/subscriptions/${subscriptionId}`)
      ).json()) as SubscriptionEvents
      expect(changes(current)).toEqual([])
    } finally {
      await server.close()
    }
  })

  test("undoChangePlan with no pending change returns Kill Bill error 1071", async () => {
    const server = await createServer({
      plans: [{ name: "example-monthly", amount: 10, currency: "USD" }],
    })
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    try {
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "undo-none", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const createdSubscription = await request("/subscriptions", {
        method: "POST",
        body: JSON.stringify({ accountId, planName: "example-monthly" }),
      })
      const location = createdSubscription.headers.get("location") ?? ""
      const subscriptionId = location.split("/").at(-1) as string
      expect(location).toEndWith(`/subscriptions/${subscriptionId}`)
      const undone = await request(`/subscriptions/${subscriptionId}/undoChangePlan`, {
        method: "PUT",
      })
      expect(undone.status).toBe(400)
      expect(await undone.json()).toMatchObject({
        className: "org.killbill.billing.subscription.api.user.SubscriptionBaseApiException",
        code: 1071,
        message:
          `Subscription (billing) ${subscriptionId} does not have a pending change plan: ` +
          "Failed to undo change plan",
      })
      const current = (await (await request(`/subscriptions/${subscriptionId}`)).json()) as {
        planName: string
        state: string
      } & SubscriptionEvents
      expect(current).toMatchObject({ planName: "example-monthly", state: "ACTIVE" })
      expect(changes(current)).toEqual([])
    } finally {
      await server.close()
    }
  })

  const purchase = async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    const post = (path: string, body: unknown) =>
      request(path, { method: "POST", body: JSON.stringify(body) })
    const created = await post("/accounts", { externalKey: "invoice-pay", currency: "USD" })
    const accountId = created.headers.get("location")?.split("/").at(-1) as string
    const method = await post(`/accounts/${accountId}/paymentMethods?isDefault=true`, {
      externalKey: "pm-invoice",
      pluginName: "__EXTERNAL_PAYMENT__",
    })
    const paymentMethodId = method.headers.get("location")?.split("/").at(-1) as string
    const charge = await post(`/invoices/charges/${accountId}`, [{ amount: 10, currency: "USD" }])
    const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
    const paid = await post(`/invoices/${invoiceId}/payments`, {
      amount: 10,
      currency: "USD",
      paymentMethodId,
      paymentExternalKey: "purchase-ext",
      transactionExternalKey: "purchase-1",
    })
    const paymentId = paid.headers.get("location")?.split("/").at(-1) as string
    return { server, request, json, post, invoiceId, paymentId, paymentMethodId }
  }

  test("reads an external purchase from GET /invoicePayments/{paymentId}", async () => {
    const { server, json, paymentId, invoiceId } = await purchase()
    try {
      const payment = await json<{
        paymentId: string
        targetInvoiceId: string
        purchasedAmount: number
        refundedAmount: number
      }>(`/invoicePayments/${paymentId}`)
      expect(payment).toMatchObject({
        paymentId,
        targetInvoiceId: invoiceId,
        purchasedAmount: 10,
        refundedAmount: 0,
      })
      expect(
        (await fetch(`${server.url}/1.0/kb/invoicePayments/missing`, { headers })).status,
      ).toBe(404)
    } finally {
      await server.close()
    }
  })

  test("refunds an invoice payment and marks the refund transaction successful", async () => {
    const { server, json, post, paymentId } = await purchase()
    try {
      const refund = await post(`/invoicePayments/${paymentId}/refunds`, {
        amount: 10,
        currency: "USD",
        transactionExternalKey: "refund-1",
      })
      expect(refund.status).toBe(201)
      const payment = await json<{
        refundedAmount: number
        transactions: Array<{
          transactionExternalKey: string
          transactionType: string
          status: string
          amount: number
        }>
      }>(`/invoicePayments/${paymentId}`)
      expect(payment.refundedAmount).toBe(10)
      expect(
        payment.transactions.find((row) => row.transactionExternalKey === "refund-1"),
      ).toMatchObject({ transactionType: "REFUND", status: "SUCCESS", amount: 10 })
    } finally {
      await server.close()
    }
  })

  test("does not refund an invoice payment twice for the same transaction external key", async () => {
    const { server, json, post, paymentId } = await purchase()
    try {
      await post(`/invoicePayments/${paymentId}/refunds`, {
        amount: 10,
        currency: "USD",
        transactionExternalKey: "refund-1",
      })
      const again = await post(`/invoicePayments/${paymentId}/refunds`, {
        amount: 10,
        currency: "USD",
        transactionExternalKey: "refund-1",
      })
      expect(again.status).toBe(400)
      const payment = await json<{
        refundedAmount: number
        transactions: Array<{ transactionExternalKey: string; transactionType: string }>
      }>(`/invoicePayments/${paymentId}`)
      expect(payment.refundedAmount).toBe(10)
      expect(
        payment.transactions.filter((row) => row.transactionExternalKey === "refund-1"),
      ).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  test("rejects an invoice payment refund above the remaining purchased amount", async () => {
    const { server, json, post, paymentId } = await purchase()
    try {
      const refund = await post(`/invoicePayments/${paymentId}/refunds`, {
        amount: 10.01,
        currency: "USD",
        transactionExternalKey: "refund-too-much",
      })
      expect(refund.status).toBe(400)
      expect(await json<{ refundedAmount: number }>(`/invoicePayments/${paymentId}`)).toMatchObject(
        {
          refundedAmount: 0,
        },
      )
    } finally {
      await server.close()
    }
  })

  test("records externalPayment=true as a credit on a new payment", async () => {
    const { server, json, post, paymentId, paymentMethodId } = await purchase()
    try {
      const refund = await post(
        `/invoicePayments/${paymentId}/refunds?externalPayment=true&paymentMethodId=${paymentMethodId}`,
        { amount: 10, currency: "USD", transactionExternalKey: "refund-1" },
      )
      expect(refund.status).toBe(201)
      const creditId = refund.headers.get("location")?.split("/").at(-1)
      expect(creditId).toBeTruthy()
      expect(creditId).not.toBe(paymentId)
      expect(await json<{ refundedAmount: number }>(`/invoicePayments/${paymentId}`)).toMatchObject(
        {
          refundedAmount: 0,
        },
      )
      const credit = await json<{
        creditedAmount: number
        transactions: Array<{
          transactionExternalKey: string
          transactionType: string
          status: string
        }>
      }>(`/invoicePayments/${creditId}`)
      expect(credit.creditedAmount).toBe(10)
      expect(credit.transactions[0]).toMatchObject({
        transactionExternalKey: "refund-1",
        transactionType: "CREDIT",
        status: "SUCCESS",
      })
      const again = await post(
        `/invoicePayments/${paymentId}/refunds?externalPayment=true&paymentMethodId=${paymentMethodId}`,
        { amount: 10, currency: "USD", transactionExternalKey: "refund-1" },
      )
      expect(again.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  test("PUT voidInvoice marks an unpaid committed invoice VOID", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    try {
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "void-unpaid", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const charge = await request(`/invoices/charges/${accountId}`, {
        method: "POST",
        body: JSON.stringify([{ amount: 4.25 }]),
      })
      const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
      expect(
        await json<{ status: string; balance: number; amount: number }>(`/invoices/${invoiceId}`),
      ).toMatchObject({
        status: "COMMITTED",
        balance: 4.25,
        amount: 4.25,
      })
      expect((await request(`/invoices/${invoiceId}/voidInvoice`, { method: "PUT" })).status).toBe(
        204,
      )
      expect(
        await json<{ status: string; balance: number }>(`/invoices/${invoiceId}`),
      ).toMatchObject({
        status: "VOID",
        balance: 0,
      })
    } finally {
      await server.close()
    }
  })

  test("a second PUT voidInvoice leaves an already void invoice VOID", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    try {
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "void-twice", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const charge = await request(`/invoices/charges/${accountId}`, {
        method: "POST",
        body: JSON.stringify([{ amount: 2 }]),
      })
      const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
      expect((await request(`/invoices/${invoiceId}/voidInvoice`, { method: "PUT" })).status).toBe(
        204,
      )
      const again = await request(`/invoices/${invoiceId}/voidInvoice`, { method: "PUT" })
      expect(again.status).toBe(400)
      expect(await again.json()).toMatchObject({ code: "INVOICE_INVALID_STATUS" })
      expect((await json<{ status: string }>(`/invoices/${invoiceId}`)).status).toBe("VOID")
    } finally {
      await server.close()
    }
  })

  test("PUT voidInvoice rejects a purchase that has not been fully refunded", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    try {
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "void-paid", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const charge = await request(`/invoices/charges/${accountId}`, {
        method: "POST",
        body: JSON.stringify([{ amount: 10.01 }]),
      })
      const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
      expect(
        (
          await request(`/invoices/${invoiceId}/payments`, {
            method: "POST",
            body: JSON.stringify({ amount: 10.01 }),
          })
        ).status,
      ).toBe(201)
      const rejected = await request(`/invoices/${invoiceId}/voidInvoice`, { method: "PUT" })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ code: "CAN_NOT_VOID_INVOICE_THAT_IS_PAID" })
      expect((await json<{ status: string }>(`/invoices/${invoiceId}`)).status).toBe("COMMITTED")
    } finally {
      await server.close()
    }
  })
})

describe("GET /1.0/kb/test/queues", () => {
  const open = async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const seed = (collection: string, id: string, value: Record<string, unknown>) =>
      fetch(`${server.url}/__admin/state/${collection}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, value }),
      })
    return { server, request, seed }
  }

  test("returns 200 when the tenant has no due notification or bus event", async () => {
    const { server, request } = await open()
    try {
      const started = performance.now()
      const idle = await request("/test/queues?timeoutSec=1")
      expect(performance.now() - started).toBeLessThan(500)
      expect(idle.status).toBe(200)
      expect(await idle.text()).toBe("")

      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "queues-acct", currency: "USD" }),
      })
      expect(created.status).toBe(201)
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      expect(
        (
          await request("/subscriptions", {
            method: "POST",
            body: JSON.stringify({
              accountId,
              externalKey: "queues-sub",
              planName: "standard-monthly",
            }),
          })
        ).status,
      ).toBe(201)
      const afterWrite = performance.now()
      const caughtUp = await request("/test/queues")
      expect(performance.now() - afterWrite).toBeLessThan(500)
      expect(caughtUp.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  test("returns 412 after timeoutSec when a notification stays queued", async () => {
    const { server, request, seed } = await open()
    try {
      expect(
        (
          await seed("kb_notifications", "stuck-notification", {
            id: "stuck-notification",
            effectiveDate: "2000-01-01T00:00:00.000Z",
            kind: "TEST",
          })
        ).status,
      ).toBe(201)
      const started = performance.now()
      const waiting = await request("/test/queues?timeoutSec=1")
      const elapsed = performance.now() - started
      expect(waiting.status).toBe(412)
      expect(await waiting.text()).toBe("")
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(2500)
    } finally {
      await server.close()
    }
  }, 10_000)

  test("a future end-of-term plan change does not keep queues at 412", async () => {
    const { server, request } = await open()
    try {
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "eot-acct", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      expect(
        (
          await request("/subscriptions", {
            method: "POST",
            body: JSON.stringify({
              accountId,
              externalKey: "eot-sub",
              planName: "standard-monthly",
            }),
          })
        ).status,
      ).toBe(201)
      const bundles = (await (await request(`/accounts/${accountId}/bundles`)).json()) as Array<{
        subscriptions: Array<{ subscriptionId: string }>
      }>
      const subscriptionId = bundles[0]?.subscriptions[0]?.subscriptionId as string
      expect(
        (
          await request("/catalog", {
            method: "POST",
            body: JSON.stringify({
              plans: [{ name: "plus-monthly", amount: 125, currency: "USD", intervalDays: 30 }],
            }),
          })
        ).status,
      ).toBe(201)
      expect(
        (
          await request(`/subscriptions/${subscriptionId}?billingPolicy=END_OF_TERM`, {
            method: "PUT",
            body: JSON.stringify({ planName: "plus-monthly" }),
          })
        ).status,
      ).toBe(204)
      expect(
        changes(
          (await (await request(`/subscriptions/${subscriptionId}`)).json()) as SubscriptionEvents,
        ),
      ).toEqual(["plus-monthly"])
      const queued = (await (
        await fetch(`${server.url}/__admin/state/kb_notifications`)
      ).json()) as { records: Array<{ value: { effectiveDate: string } }> }
      const clock = (await (await request("/test/clock")).json()) as { currentUtcTime: string }
      expect(queued.records).toHaveLength(1)
      expect(Date.parse(queued.records[0]?.value.effectiveDate ?? "")).toBeGreaterThan(
        Date.parse(clock.currentUtcTime),
      )
      const started = performance.now()
      const response = await request("/test/queues?timeoutSec=1")
      expect(performance.now() - started).toBeLessThan(500)
      expect(response.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  test("returns 412 after timeoutSec when a bus event stays queued", async () => {
    const { server, request, seed } = await open()
    try {
      expect(
        (
          await seed("kb_bus_events", "stuck-bus", {
            id: "stuck-bus",
            eventType: "INVOICE_CREATION",
          })
        ).status,
      ).toBe(201)
      const started = performance.now()
      const waiting = await request("/test/queues?timeoutSec=1")
      const elapsed = performance.now() - started
      expect(waiting.status).toBe(412)
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(2500)
    } finally {
      await server.close()
    }
  }, 10_000)

  test("returns the clear overdue state when an account has no unpaid invoice", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    try {
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "overdue-clear", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const overdue = (await (await request(`/accounts/${accountId}/overdue`)).json()) as {
        name: string
        externalMessage: string
        isDisableEntitlementAndChangesBlocked: boolean
        isBlockChanges: boolean
        isClearState: boolean
        reevaluationIntervalDays: number | null
      }
      expect(overdue).toEqual({
        name: "__KILLBILL__CLEAR__OVERDUE_STATE__",
        externalMessage: "",
        isDisableEntitlementAndChangesBlocked: false,
        isBlockChanges: false,
        isClearState: true,
        reevaluationIntervalDays: null,
      })
    } finally {
      await server.close()
    }
  })

  test("returns OD1 once an unpaid invoice is past the one-day overdue condition", async () => {
    const server = await createServer()
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const json = async <T>(path: string, init?: RequestInit) =>
      (await (await request(path, init)).json()) as T
    try {
      const created = await request("/accounts", {
        method: "POST",
        body: JSON.stringify({ externalKey: "overdue-od1", currency: "USD" }),
      })
      const accountId = created.headers.get("location")?.split("/").at(-1) as string
      const charge = await request(`/invoices/charges/${accountId}`, {
        method: "POST",
        body: JSON.stringify([{ amount: 12, currency: "USD", description: "Unpaid" }]),
      })
      const invoiceId = charge.headers.get("location")?.split("/").at(-1) as string
      const invoice = await json<{ invoiceDate: string; balance: number }>(`/invoices/${invoiceId}`)
      expect(invoice.balance).toBe(12)
      expect(
        await json<{ name: string; isClearState: boolean }>(`/accounts/${accountId}/overdue`),
      ).toMatchObject({
        name: "__KILLBILL__CLEAR__OVERDUE_STATE__",
        isClearState: true,
      })
      const due = new Date(
        Date.parse(`${invoice.invoiceDate}T00:00:00.000Z`) + 86_400_000,
      ).toISOString()
      expect(
        (
          await request(`/test/clock?requestedDate=${encodeURIComponent(due)}`, {
            method: "PUT",
            body: "{}",
          })
        ).status,
      ).toBe(200)
      expect(
        await json<{
          name: string
          externalMessage: string
          isDisableEntitlementAndChangesBlocked: boolean
          isBlockChanges: boolean
          isClearState: boolean
          reevaluationIntervalDays: number | null
        }>(`/accounts/${accountId}/overdue`),
      ).toEqual({
        name: "OD1",
        externalMessage: "",
        isDisableEntitlementAndChangesBlocked: false,
        isBlockChanges: false,
        isClearState: false,
        reevaluationIntervalDays: null,
      })
    } finally {
      await server.close()
    }
  })

  test("returns 404 when the overdue account id is unknown", async () => {
    const server = await createServer()
    try {
      const response = await fetch(`${server.url}/1.0/kb/accounts/missing-account/overdue`, {
        headers,
      })
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
