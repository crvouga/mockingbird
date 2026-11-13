import { describe, expect, test } from "bun:test"
import { createServer, type KillBillServerOptions } from "./src/server.js"

/**
 * Issues #737–#742, each behavior measured against Kill Bill 0.24.16 (docker
 * killbill/killbill:0.24.16, a push-notification callback and the test clock) on 2026-11-13
 * unless a test says it is a best guess.
 */
const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "issues-737-742",
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AUTO_PAY_OFF = "00000000-0000-0000-0000-000000000001"
const AUTO_INVOICING_OFF = "00000000-0000-0000-0000-000000000002"
const WRITTEN_OFF = "00000000-0000-0000-0000-000000000004"

const CATALOG = `<?xml version="1.0" encoding="UTF-8"?>
<catalog>
  <effectiveDate>2024-01-01T00:00:00+00:00</effectiveDate>
  <catalogName>acme</catalogName>
  <recurringBillingMode>IN_ADVANCE</recurringBillingMode>
  <currencies><currency>USD</currency></currencies>
  <products>
    <product name="Pro"><category>BASE</category><available><addonProduct>Seats</addonProduct></available></product>
    <product name="Lite"><category>BASE</category></product>
    <product name="Seats"><category>ADD_ON</category></product>
  </products>
  <rules>
    <changePolicy><changePolicyCase><policy>IMMEDIATE</policy></changePolicyCase></changePolicy>
    <cancelPolicy><cancelPolicyCase><policy>IMMEDIATE</policy></cancelPolicyCase></cancelPolicy>
  </rules>
  <plans>
    <plan name="pro-monthly">
      <product>Pro</product>
      <finalPhase type="EVERGREEN"><duration><unit>UNLIMITED</unit></duration>
        <recurring><billingPeriod>MONTHLY</billingPeriod><recurringPrice><price><currency>USD</currency><value>100.00</value></price></recurringPrice></recurring>
      </finalPhase>
    </plan>
    <plan name="pro-quarterly">
      <product>Pro</product>
      <finalPhase type="EVERGREEN"><duration><unit>UNLIMITED</unit></duration>
        <recurring><billingPeriod>QUARTERLY</billingPeriod><recurringPrice><price><currency>USD</currency><value>270.00</value></price></recurringPrice></recurring>
      </finalPhase>
    </plan>
    <plan name="pro-trial-monthly">
      <product>Pro</product>
      <initialPhases>
        <phase type="TRIAL"><duration><unit>DAYS</unit><number>14</number></duration><fixed><fixedPrice/></fixed></phase>
      </initialPhases>
      <finalPhase type="EVERGREEN"><duration><unit>UNLIMITED</unit></duration>
        <recurring><billingPeriod>MONTHLY</billingPeriod><recurringPrice><price><currency>USD</currency><value>50.00</value></price></recurringPrice></recurring>
      </finalPhase>
    </plan>
    <plan name="lite-monthly">
      <product>Lite</product>
      <finalPhase type="EVERGREEN"><duration><unit>UNLIMITED</unit></duration>
        <recurring><billingPeriod>MONTHLY</billingPeriod><recurringPrice><price><currency>USD</currency><value>20.00</value></price></recurringPrice></recurring>
      </finalPhase>
    </plan>
    <plan name="seats-monthly">
      <product>Seats</product>
      <finalPhase type="EVERGREEN"><duration><unit>UNLIMITED</unit></duration>
        <recurring><billingPeriod>MONTHLY</billingPeriod><recurringPrice><price><currency>USD</currency><value>10.00</value></price></recurringPrice></recurring>
      </finalPhase>
    </plan>
  </plans>
  <priceLists><defaultPriceList name="DEFAULT"><plans><plan>pro-monthly</plan><plan>pro-quarterly</plan><plan>pro-trial-monthly</plan><plan>lite-monthly</plan><plan>seats-monthly</plan></plans></defaultPriceList></priceLists>
</catalog>`

type Notification = {
  eventType: string
  objectType: string
  objectId: string
  accountId: string | null
  metaData: string | null
}
type Json = Record<string, unknown> & { [key: string]: unknown }

const session = async (options: KillBillServerOptions = {}) => {
  const received: Notification[] = []
  const sink = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push((await request.json()) as Notification)
      return new Response(null, { status: 200 })
    },
  })
  const server = await createServer({ notificationDelayMs: 0, ...options })
  const call = async (path: string, method = "GET", body?: unknown, contentType?: string) => {
    const response = await fetch(`${server.url}/1.0/kb${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": contentType ?? "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    })
    const text = await response.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {}
    const location = response.headers.get("location") ?? ""
    return {
      status: response.status,
      json: json as Json,
      location,
      id: location.split("/").pop() as string,
    }
  }
  /** Every push notification sent since the last call, once the queues have drained. */
  const events = async () => {
    await call("/test/queues?timeoutSec=10")
    return received.splice(0)
  }
  await call("/test/clock?requestedDate=2026-11-13T10:00:00.000Z", "POST")
  await call("/catalog/xml", "POST", CATALOG, "text/xml")
  await call(
    `/tenants/registerNotificationCallback?cb=${encodeURIComponent(sink.url.toString())}`,
    "POST",
  )
  const account = async (tags: string[] = [AUTO_PAY_OFF]) => {
    const { id } = await call("/accounts", "POST", { name: "Probe", currency: "USD" })
    await call(`/accounts/${id}/paymentMethods?isDefault=true`, "POST", {
      pluginName: "__EXTERNAL_PAYMENT__",
    })
    if (tags.length > 0) await call(`/accounts/${id}/tags`, "POST", tags)
    return id
  }
  const subscribe = async (body: Json) => call("/subscriptions", "POST", body)
  const invoices = async (accountId: string) =>
    (await call(`/accounts/${accountId}/invoices?includeInvoiceComponents=true`))
      .json as unknown as Array<Json & { items: Json[] }>
  const close = async () => {
    await server.close()
    sink.stop(true)
  }
  await events()
  return { server, call, events, account, subscribe, invoices, close }
}

describe("bundle external keys (#737)", () => {
  test("bundleExternalKey keys the bundle, externalKey keys only the subscription", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      const keyed = await s.subscribe({
        accountId,
        planName: "pro-monthly",
        bundleExternalKey: "purchase-1",
      })
      expect(keyed.status).toBe(201)
      const sub = (await s.call(`/subscriptions/${keyed.id}`)).json
      expect(sub.bundleExternalKey).toBe("purchase-1")
      expect(sub.externalKey).toBe(keyed.id)
      const other = await s.subscribe({
        accountId,
        planName: "lite-monthly",
        externalKey: "sub-key-only",
      })
      const unkeyed = (await s.call(`/subscriptions/${other.id}`)).json
      expect(unkeyed.externalKey).toBe("sub-key-only")
      expect(unkeyed.bundleExternalKey).toBe(unkeyed.bundleId)
    } finally {
      await s.close()
    }
  })

  test("the bundles externalKey filter returns the match or nothing", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      const keyed = await s.subscribe({
        accountId,
        planName: "pro-monthly",
        bundleExternalKey: "purchase-1",
      })
      await s.subscribe({ accountId, planName: "lite-monthly" })
      const matched = (await s.call(`/accounts/${accountId}/bundles?externalKey=purchase-1`))
        .json as unknown as Json[]
      expect(matched.map((b) => b.externalKey)).toEqual(["purchase-1"])
      expect(((matched[0]?.subscriptions ?? []) as Json[])[0]?.subscriptionId).toBe(keyed.id)
      // bundlesFilter is a list of bundle ids; an unknown one matches nothing.
      const filtered = await s.call(`/accounts/${accountId}/bundles?bundlesFilter=nope`)
      expect(filtered.json as unknown).toEqual([])
      const missing = await s.call(`/accounts/${accountId}/bundles?externalKey=does-not-exist`)
      expect(missing.status).toBe(200)
      expect(missing.json as unknown).toEqual([])
      // GET /1.0/kb/bundles?externalKey= finds it across the tenant, or 404 SubscriptionApiException 1084.
      const byKey = await s.call("/bundles?externalKey=purchase-1")
      expect((byKey.json as unknown as Json[]).map((b) => b.bundleId)).toEqual([
        matched[0]?.bundleId,
      ])
      const none = await s.call("/bundles?externalKey=does-not-exist")
      expect(none.status).toBe(404)
      expect(none.json).toMatchObject({
        className: "org.killbill.billing.entitlement.api.SubscriptionApiException",
        code: 1084,
        message: "Could not find a bundle matching key does-not-exist",
      })
    } finally {
      await s.close()
    }
  })

  test("a second base subscription on an active bundle key is refused; after a cancel it opens a new bundle", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      const first = await s.subscribe({
        accountId,
        planName: "pro-monthly",
        bundleExternalKey: "purchase-1",
      })
      const again = await s.subscribe({
        accountId,
        planName: "lite-monthly",
        bundleExternalKey: "purchase-1",
      })
      expect(again.status).toBe(400)
      expect(again.json).toMatchObject({
        className: "org.killbill.billing.subscription.api.user.SubscriptionBaseApiException",
        code: 1015,
        message: "Subscription bundle purchase-1 already has a base subscription",
      })
      // An add-on the base product makes available joins the bundle.
      const addOn = await s.subscribe({
        accountId,
        planName: "seats-monthly",
        bundleExternalKey: "purchase-1",
      })
      expect(addOn.status).toBe(201)
      const seats = (await s.call(`/subscriptions/${addOn.id}`)).json
      const pro = (await s.call(`/subscriptions/${first.id}`)).json
      expect(seats.bundleId).toBe(pro.bundleId)
      expect(seats.productCategory).toBe("ADD_ON")
      await s.call(
        `/subscriptions/${first.id}?entitlementPolicy=IMMEDIATE&billingPolicy=IMMEDIATE`,
        "DELETE",
      )
      await s.call(
        `/subscriptions/${addOn.id}?entitlementPolicy=IMMEDIATE&billingPolicy=IMMEDIATE`,
        "DELETE",
      )
      const recreated = await s.subscribe({
        accountId,
        planName: "pro-monthly",
        bundleExternalKey: "purchase-1",
      })
      expect(recreated.status).toBe(201)
      const bundles = (await s.call(`/accounts/${accountId}/bundles?externalKey=purchase-1`))
        .json as unknown as Json[]
      expect(bundles).toHaveLength(2)
      expect((await s.call(`/subscriptions/${recreated.id}`)).json.bundleId).toBe(
        bundles[1]?.bundleId,
      )
    } finally {
      await s.close()
    }
  })

  test("an add-on the base product does not make available is refused (1019)", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      await s.subscribe({ accountId, planName: "lite-monthly", bundleExternalKey: "purchase-2" })
      const addOn = await s.subscribe({
        accountId,
        planName: "seats-monthly",
        bundleExternalKey: "purchase-2",
      })
      expect(addOn.status).toBe(400)
      expect(addOn.json).toMatchObject({
        className: "org.killbill.billing.subscription.api.user.SubscriptionBaseApiException",
        code: 1019,
        message: "Can't create AddOn seats-monthly for BasePlan Lite (Not available)",
      })
    } finally {
      await s.close()
    }
  })
})

describe("custom fields, invoice tags, invoice by number and account close (#738)", () => {
  test("subscription custom fields are created, listed and deleted", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      const { id: subscriptionId } = await s.subscribe({ accountId, planName: "pro-monthly" })
      await s.events()
      const created = await s.call(`/subscriptions/${subscriptionId}/customFields`, "POST", [
        { name: "purchase", value: "p-1" },
      ])
      expect(created.status).toBe(201)
      expect(created.location).toEndWith(`/1.0/kb/subscriptions/${subscriptionId}/customFields`)
      const listed = (await s.call(`/subscriptions/${subscriptionId}/customFields`))
        .json as unknown as Json[]
      expect(listed).toEqual([
        {
          customFieldId: expect.stringMatching(UUID),
          objectId: subscriptionId,
          objectType: "SUBSCRIPTION",
          name: "purchase",
          value: "p-1",
          auditLogs: [],
        },
      ])
      expect(await s.events()).toEqual([
        {
          eventType: "CUSTOM_FIELD_CREATION",
          accountId,
          objectType: "CUSTOM_FIELD",
          objectId: listed[0]?.customFieldId as string,
          metaData: null,
        },
      ])
      const accountFields = await s.call(`/accounts/${accountId}/customFields`, "POST", [
        { name: "crm", value: "c-1" },
      ])
      expect(accountFields.status).toBe(201)
      expect(
        ((await s.call(`/accounts/${accountId}/customFields`)).json as unknown as Json[])[0],
      ).toMatchObject({
        objectType: "ACCOUNT",
        name: "crm",
      })
      const removed = await s.call(
        `/subscriptions/${subscriptionId}/customFields?customField=${listed[0]?.customFieldId}`,
        "DELETE",
      )
      expect(removed.status).toBe(204)
      expect(
        (await s.call(`/subscriptions/${subscriptionId}/customFields`)).json as unknown,
      ).toEqual([])
    } finally {
      await s.close()
    }
  })

  test("a WRITTEN_OFF invoice tag zeroes the balance until it is removed", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      await s.subscribe({ accountId, planName: "pro-monthly" })
      const [invoice] = await s.invoices(accountId)
      const invoiceId = invoice?.invoiceId as string
      expect(invoice?.balance).toBe(100)
      await s.events()
      const tagged = await s.call(`/invoices/${invoiceId}/tags`, "POST", [WRITTEN_OFF])
      expect(tagged.status).toBe(201)
      expect(tagged.location).toEndWith(`/1.0/kb/invoices/${invoiceId}/tags`)
      const tags = (await s.call(`/invoices/${invoiceId}/tags`)).json as unknown as Json[]
      expect(tags).toEqual([
        {
          tagId: expect.stringMatching(UUID),
          objectType: "INVOICE",
          objectId: invoiceId,
          tagDefinitionId: WRITTEN_OFF,
          tagDefinitionName: "WRITTEN_OFF",
          auditLogs: [],
        },
      ])
      expect((await s.call(`/invoices/${invoiceId}`)).json).toMatchObject({
        amount: 100,
        balance: 0,
      })
      expect(
        (await s.call(`/accounts/${accountId}?accountWithBalanceAndCBA=true`)).json.accountBalance,
      ).toBe(0)
      expect(await s.events()).toEqual([
        {
          eventType: "TAG_CREATION",
          accountId,
          objectType: "TAG",
          objectId: tags[0]?.tagId as string,
          metaData: '{"tagDefinitionName":"WRITTEN_OFF"}',
        },
      ])
      expect(
        (await s.call(`/invoices/${invoiceId}/tags?tagDef=${WRITTEN_OFF}`, "DELETE")).status,
      ).toBe(204)
      expect((await s.call(`/invoices/${invoiceId}`)).json.balance).toBe(100)
      expect((await s.events()).map((n) => [n.eventType, n.metaData])).toEqual([
        ["TAG_DELETION", '{"tagDefinitionName":"WRITTEN_OFF"}'],
      ])
    } finally {
      await s.close()
    }
  })

  test("GET /invoices/byNumber/{n} returns the invoice, or InvoiceApiException 4018", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      await s.subscribe({ accountId, planName: "pro-monthly" })
      const [invoice] = await s.invoices(accountId)
      const found = await s.call(`/invoices/byNumber/${invoice?.invoiceNumber}`)
      expect(found.status).toBe(200)
      expect(found.json).toMatchObject({ invoiceId: invoice?.invoiceId, amount: 100 })
      const missing = await s.call("/invoices/byNumber/999999")
      expect(missing.status).toBe(400)
      expect(missing.json).toMatchObject({
        className: "org.killbill.billing.invoice.api.InvoiceApiException",
        code: 4018,
        message: "No invoice could be found for number 999999.",
      })
    } finally {
      await s.close()
    }
  })

  test("DELETE /accounts/{id} closes the account: cancels, writes off, stops invoicing", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      const { id: subscriptionId } = await s.subscribe({ accountId, planName: "pro-monthly" })
      const [invoice] = await s.invoices(accountId)
      await s.events()
      const closed = await s.call(
        `/accounts/${accountId}?cancelAllSubscriptions=true&writeOffUnpaidInvoices=true&itemAdjustUnpaidInvoices=false`,
        "DELETE",
      )
      expect(closed.status).toBe(204)
      expect(
        (await s.call(`/accounts/${accountId}?accountWithBalanceAndCBA=true`)).json,
      ).toMatchObject({
        accountId,
        accountBalance: 0,
      })
      const sub = (await s.call(`/subscriptions/${subscriptionId}`)).json
      expect(sub.state).toBe("CANCELLED")
      expect(sub.cancelledDate).toBe("2026-11-13T10:00:00.000Z")
      // Billing stops at the end of the billed period (Kill Bill prints the start's time of day;
      // the emulator's stop instants are midnight, an existing difference).
      expect(String(sub.billingEndDate).slice(0, 10)).toBe("2026-12-13")
      expect((await s.call(`/invoices/${invoice?.invoiceId}`)).json.balance).toBe(0)
      const tags = (await s.call(`/accounts/${accountId}/tags`)).json as unknown as Json[]
      expect(tags.map((t) => t.tagDefinitionName).sort()).toEqual([
        "AUTO_INVOICING_OFF",
        "AUTO_PAY_OFF",
      ])
      const sent = await s.events()
      expect(sent.map((n) => n.eventType)).toContain("ENTITLEMENT_CANCEL")
      expect(
        sent.find((n) => n.eventType === "TAG_CREATION" && n.metaData?.includes("WRITTEN_OFF")),
      ).toBeDefined()
      expect(
        sent.find(
          (n) => n.eventType === "TAG_CREATION" && n.metaData?.includes("AUTO_INVOICING_OFF"),
        ),
      ).toBeDefined()
      const blocking = sent.find((n) => n.eventType === "BLOCKING_STATE")
      expect(blocking).toMatchObject({ objectType: "ACCOUNT", objectId: accountId })
      expect(JSON.parse(blocking?.metaData as string)).toEqual({
        blockableId: accountId,
        service: "account-service",
        stateName: "CLOSE_ACCOUNT",
        blockingType: "ACCOUNT",
        effectiveDate: "2026-11-13T10:00:00.000Z",
        transitionedToBlockedBilling: false,
        transitionedToUnblockedBilling: false,
        transitionedToBlockedEntitlement: false,
        transitionedToUnblockedEntitlement: false,
      })
      // AUTO_INVOICING_OFF: the renewal is not invoiced.
      await s.call("/test/clock?requestedDate=2027-01-20T10:00:00.000Z", "POST")
      expect(await s.invoices(accountId)).toHaveLength(1)
    } finally {
      await s.close()
    }
  })

  test("DELETE /accounts/{id} with itemAdjustUnpaidInvoices=true is an explicit emulator limitation", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      await s.subscribe({ accountId, planName: "pro-monthly" })
      const refused = await s.call(`/accounts/${accountId}?itemAdjustUnpaidInvoices=true`, "DELETE")
      expect(refused.status).toBe(400)
      expect(refused.json).toMatchObject({ code: "UNSUPPORTED_ACCOUNT_CLOSE" })
      expect(((await s.call(`/accounts/${accountId}/tags`)).json as unknown as Json[]).length).toBe(
        1,
      )
    } finally {
      await s.close()
    }
  })
})

describe("push notifications (#739)", () => {
  test("account and subscription blocking states send BLOCKING_STATE", async () => {
    const s = await session()
    try {
      const accountId = await s.account([])
      const { id: subscriptionId } = await s.subscribe({ accountId, planName: "pro-monthly" })
      await s.events()
      const pause = {
        stateName: "PAUSED",
        service: "probe",
        isBlockChange: false,
        isBlockEntitlement: false,
        isBlockBilling: true,
      }
      const paused = await s.call(`/accounts/${accountId}/block`, "POST", pause)
      expect(paused.status).toBe(201)
      expect(paused.location).toEndWith(
        `/1.0/kb/accounts/${accountId}/block?blockingStateTypes=ACCOUNT`,
      )
      const sent = await s.events()
      const blocking = sent.find((n) => n.eventType === "BLOCKING_STATE")
      expect(blocking).toMatchObject({ objectType: "ACCOUNT", objectId: accountId, accountId })
      expect(JSON.parse(blocking?.metaData as string)).toEqual({
        blockableId: accountId,
        service: "probe",
        stateName: "PAUSED",
        blockingType: "ACCOUNT",
        effectiveDate: "2026-11-13T10:00:00.000Z",
        transitionedToBlockedBilling: true,
        transitionedToUnblockedBilling: false,
        transitionedToBlockedEntitlement: false,
        transitionedToUnblockedEntitlement: false,
      })
      // An account billing pause credits the rest of the billed period, as a subscription pause does.
      expect(sent.map((n) => n.eventType)).toContain("INVOICE_CREATION")
      await s.call(`/accounts/${accountId}/block`, "POST", {
        ...pause,
        stateName: "RESUMED",
        isBlockBilling: false,
      })
      const resumed = (await s.events()).find((n) => n.eventType === "BLOCKING_STATE")
      expect(JSON.parse(resumed?.metaData as string)).toMatchObject({
        stateName: "RESUMED",
        transitionedToBlockedBilling: false,
        transitionedToUnblockedBilling: true,
      })
      const subscriptionBlock = await s.call(`/subscriptions/${subscriptionId}/block`, "POST", {
        ...pause,
        isBlockEntitlement: true,
      })
      expect(subscriptionBlock.location).toEndWith(
        `/1.0/kb/accounts/${accountId}/block?blockingStateTypes=SUBSCRIPTION`,
      )
      const subscriptionEvent = (await s.events()).find((n) => n.eventType === "BLOCKING_STATE")
      expect(subscriptionEvent).toMatchObject({
        objectType: "SUBSCRIPTION",
        objectId: subscriptionId,
      })
      expect(JSON.parse(subscriptionEvent?.metaData as string)).toMatchObject({
        blockableId: subscriptionId,
        blockingType: "SUBSCRIPTION",
        transitionedToBlockedBilling: true,
        transitionedToBlockedEntitlement: true,
      })
    } finally {
      await s.close()
    }
  })

  test("an account entering and leaving overdue state OD1 sends OVERDUE_CHANGE then BLOCKING_STATE", async () => {
    const s = await session()
    try {
      const accountId = await s.account()
      await s.subscribe({ accountId, planName: "pro-monthly" })
      const [invoice] = await s.invoices(accountId)
      await s.events()
      await s.call("/test/clock?requestedDate=2026-11-15T10:00:00.000Z", "POST")
      expect((await s.call(`/accounts/${accountId}/overdue`)).json.name).toBe("OD1")
      const entered = await s.events()
      expect(
        entered.map((n) => [n.eventType, n.objectType, n.objectId, n.metaData === null]),
      ).toEqual([
        ["OVERDUE_CHANGE", "ACCOUNT", accountId, true],
        ["BLOCKING_STATE", "ACCOUNT", accountId, false],
      ])
      expect(JSON.parse(entered[1]?.metaData as string)).toMatchObject({
        service: "overdue-service",
        stateName: "OD1",
        blockingType: "ACCOUNT",
      })
      await s.call(`/invoices/${invoice?.invoiceId}/payments?externalPayment=true`, "POST", {
        accountId,
        purchasedAmount: 100,
      })
      const cleared = await s.events()
      expect(cleared.map((n) => n.eventType)).toEqual([
        "PAYMENT_SUCCESS",
        "INVOICE_PAYMENT_SUCCESS",
        "OVERDUE_CHANGE",
        "BLOCKING_STATE",
      ])
      expect(JSON.parse(cleared[3]?.metaData as string).stateName).toBe(
        "__KILLBILL__CLEAR__OVERDUE_STATE__",
      )
    } finally {
      await s.close()
    }
  })

  test("a TRIAL phase bills a $0 fixed item, then SUBSCRIPTION_PHASE and the evergreen price", async () => {
    const s = await session()
    try {
      const accountId = await s.account([])
      const { id: subscriptionId } = await s.subscribe({ accountId, planName: "pro-trial-monthly" })
      const trial = (await s.call(`/subscriptions/${subscriptionId}`)).json
      expect(trial).toMatchObject({
        phaseType: "TRIAL",
        chargedThroughDate: "2026-11-27",
        billCycleDayLocal: 27,
      })
      expect(trial.prices).toEqual([
        {
          fixedPrice: 0,
          phaseName: "pro-trial-monthly-trial",
          phaseType: "TRIAL",
          planName: "pro-trial-monthly",
          recurringPrice: null,
          usagePrices: [],
        },
        {
          fixedPrice: null,
          phaseName: "pro-trial-monthly-evergreen",
          phaseType: "EVERGREEN",
          planName: "pro-trial-monthly",
          recurringPrice: 50,
          usagePrices: [],
        },
      ])
      expect((trial.events as Json[]).map((e) => [e.eventType, e.effectiveDate, e.phase])).toEqual([
        ["START_ENTITLEMENT", "2026-11-13T10:00:00.000Z", "pro-trial-monthly-trial"],
        ["START_BILLING", "2026-11-13T10:00:00.000Z", "pro-trial-monthly-trial"],
        ["PHASE", "2026-11-27T10:00:00.000Z", "pro-trial-monthly-evergreen"],
      ])
      const [first] = await s.invoices(accountId)
      expect(first).toMatchObject({ amount: 0, balance: 0 })
      expect(
        first?.items.map((i) => [i.itemType, i.amount, i.phaseName, i.startDate, i.endDate]),
      ).toEqual([["FIXED", 0, "pro-trial-monthly-trial", "2026-11-13", "2026-11-27"]])
      const created = await s.events()
      expect(created.map((n) => n.eventType)).not.toContain("PAYMENT_SUCCESS")
      await s.call("/test/clock?requestedDate=2026-11-28T00:00:00.000Z", "POST")
      expect((await s.call(`/subscriptions/${subscriptionId}`)).json).toMatchObject({
        phaseType: "EVERGREEN",
        chargedThroughDate: "2026-12-27",
      })
      const renewal = (await s.invoices(accountId))[1]
      expect(
        renewal?.items.map((i) => [i.itemType, i.amount, i.phaseName, i.startDate, i.endDate]),
      ).toEqual([["RECURRING", 50, "pro-trial-monthly-evergreen", "2026-11-27", "2026-12-27"]])
      const phased = await s.events()
      expect(phased.map((n) => n.eventType)).toEqual([
        "SUBSCRIPTION_PHASE",
        "INVOICE_CREATION",
        "PAYMENT_SUCCESS",
        "INVOICE_PAYMENT_SUCCESS",
      ])
      expect(JSON.parse(phased[0]?.metaData as string)).toEqual({
        actionType: "EFFECTIVE",
        bundleExternalKey: trial.bundleExternalKey,
        subscriptionChangeUndo: false,
      })
    } finally {
      await s.close()
    }
  })

  test("subscription, tag, payment and invoice payment notifications carry Kill Bill's metaData", async () => {
    const s = await session()
    try {
      const accountId = await s.account([])
      await s.events()
      const { id: subscriptionId } = await s.subscribe({
        accountId,
        planName: "pro-monthly",
        bundleExternalKey: "purchase-9",
      })
      const sent = await s.events()
      const meta = (type: string) =>
        sent
          .filter((n) => n.eventType === type)
          .map((n) => (n.metaData === null ? null : JSON.parse(n.metaData)))
      expect(meta("SUBSCRIPTION_CREATION")).toEqual([
        { actionType: "REQUESTED", bundleExternalKey: "purchase-9", subscriptionChangeUndo: false },
        { actionType: "EFFECTIVE", bundleExternalKey: "purchase-9", subscriptionChangeUndo: false },
      ])
      expect(meta("ENTITLEMENT_CREATION")).toEqual([null])
      expect(meta("INVOICE_CREATION")).toEqual([null])
      const [invoice] = await s.invoices(accountId)
      const payments = (await s.call(`/invoices/${invoice?.invoiceId}/payments`))
        .json as unknown as Array<Json & { transactions: Json[]; paymentId: string }>
      const payment = payments[0]
      const transaction = payment?.transactions[0]
      expect(meta("PAYMENT_SUCCESS")).toEqual([
        {
          paymentTransactionId: transaction?.transactionId,
          amount: 100,
          currency: "USD",
          status: "SUCCESS",
          transactionType: "PURCHASE",
          effectiveDate: "2026-11-13T10:00:00.000Z",
        },
      ])
      expect(sent.find((n) => n.eventType === "PAYMENT_SUCCESS")?.metaData).toContain(
        '"amount":100.00,',
      )
      expect(meta("INVOICE_PAYMENT_SUCCESS")).toEqual([
        {
          paymentId: payment?.paymentId,
          paymentAttemptId: expect.stringMatching(UUID),
          invoicePaymentType: "ATTEMPT",
          paymentDate: "2026-11-13T10:00:00.000Z",
          amount: 100,
          currency: "USD",
          linkedInvoicePaymentId: null,
          paymentCookieId: transaction?.transactionId,
          processedCurrency: "USD",
        },
      ])
      await s.call(`/subscriptions/${subscriptionId}`, "PUT", { planName: "pro-quarterly" })
      const changed = await s.events()
      expect(
        changed
          .filter((n) => n.eventType === "SUBSCRIPTION_CHANGE")
          .map((n) => JSON.parse(n.metaData as string).actionType),
      ).toEqual(["REQUESTED", "EFFECTIVE"])
      expect(changed.map((n) => n.eventType).slice(0, 3)).toEqual([
        "SUBSCRIPTION_CHANGE",
        "SUBSCRIPTION_CHANGE",
        "INVOICE_CREATION",
      ])
      await s.call(
        `/subscriptions/${subscriptionId}?entitlementPolicy=IMMEDIATE&billingPolicy=IMMEDIATE`,
        "DELETE",
      )
      const cancelled = await s.events()
      expect(
        cancelled
          .filter((n) => n.eventType === "SUBSCRIPTION_CANCEL")
          .map((n) => JSON.parse(n.metaData as string).actionType),
      ).toEqual(["REQUESTED", "EFFECTIVE"])
      await s.call(`/accounts/${accountId}/tags`, "POST", [AUTO_INVOICING_OFF])
      expect((await s.events()).map((n) => n.metaData)).toEqual([
        '{"tagDefinitionName":"AUTO_INVOICING_OFF"}',
      ])
    } finally {
      await s.close()
    }
  })

  test("tenant callbacks are delivered through the webhooks.fetch transport", async () => {
    const delivered: string[] = []
    const s = await session({
      webhooks: {
        fetch: async (request) => {
          delivered.push(`${request.method} ${request.url} ${(await request.json()).eventType}`)
          return new Response(null, { status: 200 })
        },
      },
    })
    try {
      await s.call(
        "/tenants/registerNotificationCallback?cb=http%3A%2F%2Fcallback.invalid%2Fkb",
        "POST",
      )
      await s.account([])
      await s.call("/test/queues?timeoutSec=10")
      expect(delivered).toEqual(["POST http://callback.invalid/kb ACCOUNT_CREATION"])
    } finally {
      await s.close()
    }
  })
})

describe("dry run UPCOMING_INVOICE (#740)", () => {
  test("previews the account's next invoice, ignoring targetDate, without creating it", async () => {
    const s = await session()
    try {
      const accountId = await s.account([])
      await s.subscribe({ accountId, planName: "pro-monthly" })
      await s.subscribe({ accountId, planName: "pro-quarterly" })
      const before = await s.invoices(accountId)
      const preview = await s.call(
        `/invoices/dryRun?accountId=${accountId}&targetDate=2099-01-01`,
        "POST",
        {
          dryRunType: "UPCOMING_INVOICE",
        },
      )
      expect(preview.status).toBe(200)
      expect(preview.json).toMatchObject({
        invoiceId: expect.stringMatching(UUID),
        invoiceNumber: null,
        invoiceDate: "2026-11-13",
        targetDate: "2026-12-13",
        amount: 100,
        balance: 100,
      })
      expect(
        (preview.json.items as Json[]).map((i) => [i.itemType, i.amount, i.startDate, i.endDate]),
      ).toEqual([["RECURRING", 100, "2026-12-13", "2027-01-13"]])
      expect(await s.invoices(accountId)).toEqual(before)
      const empty = await s.account([])
      const nothing = await s.call(`/invoices/dryRun?accountId=${empty}`, "POST", {
        dryRunType: "UPCOMING_INVOICE",
      })
      expect(nothing.status).toBe(204)
    } finally {
      await s.close()
    }
  })

  test("a trial on an account with a bill-cycle day bills its stub when the trial ends", async () => {
    // Best guess, not oracle-verified: the stub to the account's day bills on the trial's last day.
    const s = await session()
    try {
      const accountId = await s.account([])
      await s.subscribe({ accountId, planName: "pro-monthly" })
      await s.call("/test/clock?requestedDate=2026-11-15T10:00:00.000Z", "POST")
      const { id } = await s.subscribe({ accountId, planName: "pro-trial-monthly" })
      expect((await s.call(`/subscriptions/${id}`)).json).toMatchObject({
        phaseType: "TRIAL",
        chargedThroughDate: "2026-11-29",
        billCycleDayLocal: 13,
      })
      const preview = await s.call(`/invoices/dryRun?accountId=${accountId}`, "POST", {
        dryRunType: "UPCOMING_INVOICE",
      })
      expect(preview.json).toMatchObject({ targetDate: "2026-11-29" })
      expect((preview.json.items as Json[]).map((i) => [i.startDate, i.endDate])).toEqual([
        ["2026-11-29", "2026-12-13"],
      ])
    } finally {
      await s.close()
    }
  })

  test("during a trial the next invoice is the first evergreen period", async () => {
    const s = await session()
    try {
      const accountId = await s.account([])
      await s.subscribe({ accountId, planName: "pro-trial-monthly" })
      const preview = await s.call(`/invoices/dryRun?accountId=${accountId}`, "POST", {
        dryRunType: "UPCOMING_INVOICE",
      })
      expect(preview.json).toMatchObject({ targetDate: "2026-11-27", amount: 50 })
      expect(
        (preview.json.items as Json[]).map((i) => [i.itemType, i.amount, i.startDate, i.endDate]),
      ).toEqual([["RECURRING", 50, "2026-11-27", "2026-12-27"]])
    } finally {
      await s.close()
    }
  })
})

describe("object ids (#741)", () => {
  test("ids are UUIDs, and the same sequence of requests mints the same ids", async () => {
    const run = async () => {
      const s = await session()
      try {
        const accountId = await s.account()
        const { id: subscriptionId } = await s.subscribe({ accountId, planName: "pro-monthly" })
        const sub = (await s.call(`/subscriptions/${subscriptionId}`)).json
        const [invoice] = await s.invoices(accountId)
        await s.call(`/invoices/${invoice?.invoiceId}/payments?externalPayment=true`, "POST", {
          accountId,
        })
        const [payment] = (await s.call(`/invoices/${invoice?.invoiceId}/payments`))
          .json as unknown as Array<Json & { transactions: Json[] }>
        const [tag] = (await s.call(`/accounts/${accountId}/tags`)).json as unknown as Json[]
        const tenant = await s.call("/tenants", "POST", { apiKey: "other", apiSecret: "secret" })
        return [
          accountId,
          subscriptionId,
          sub.bundleId,
          invoice?.invoiceId,
          invoice?.items[0]?.invoiceItemId,
          payment?.paymentId,
          payment?.transactions[0]?.transactionId,
          payment?.paymentMethodId,
          tag?.tagId,
          tenant.id,
        ] as string[]
      } finally {
        await s.close()
      }
    }
    const first = await run()
    for (const id of first) expect(id).toMatch(UUID)
    expect(new Set(first).size).toBe(first.length)
    expect(await run()).toEqual(first)
  })
})

describe("catalog read-back (#742)", () => {
  test("GET /catalog returns the uploaded name, date, product categories and billing periods", async () => {
    const s = await session()
    try {
      const [version] = (await s.call("/catalog")).json as unknown as Array<
        Json & { products: Array<Json & { plans: Json[] }> }
      >
      expect(version?.name).toBe("acme")
      expect(version?.effectiveDate).toBe("2024-01-01T00:00:00.000+00:00")
      expect(
        version?.products.map((p) => [p.type, p.name, p.plans.map((plan) => plan.name)]),
      ).toEqual([
        ["BASE", "Lite", ["lite-monthly"]],
        ["BASE", "Pro", ["pro-monthly", "pro-quarterly", "pro-trial-monthly"]],
        ["ADD_ON", "Seats", ["seats-monthly"]],
      ])
      const pro = version?.products[1]
      expect(pro?.plans[1]?.billingPeriod).toBe("QUARTERLY")
      expect(pro?.available).toEqual(["Seats"])
      expect(pro?.plans[2]?.phases).toEqual([
        {
          type: "TRIAL",
          prices: [],
          fixedPrices: [],
          duration: { unit: "DAYS", number: 14 },
          usages: [],
        },
        {
          type: "EVERGREEN",
          prices: [{ currency: "USD", value: 50 }],
          fixedPrices: [],
          duration: { unit: "UNLIMITED", number: -1 },
          usages: [],
        },
      ])
      const accountId = await s.account([])
      const { id } = await s.subscribe({ accountId, planName: "pro-quarterly" })
      const sub = (await s.call(`/subscriptions/${id}`)).json
      expect(sub).toMatchObject({
        billingPeriod: "QUARTERLY",
        productName: "Pro",
        productCategory: "BASE",
        chargedThroughDate: "2027-02-13",
      })
    } finally {
      await s.close()
    }
  })
})
