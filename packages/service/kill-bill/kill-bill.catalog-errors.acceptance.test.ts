import { describe, expect, test } from "bun:test"
import { createServer } from "./src/server.js"

// Captured from Kill Bill 0.24.10 (POST /1.0/kb/subscriptions) on 2026-11-05: a tenant with no
// catalog uploaded, then the same tenant after a one-plan catalog upload.
const NO_CATALOG_MESSAGE =
  /^No existing versions in the VersionedCatalog catalog for input date (Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{2}:\d{2}:\d{2} GMT \d{4}$/

const CATALOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<catalog>
  <effectiveDate>2024-01-01T00:00:00+00:00</effectiveDate>
  <catalogName>probe</catalogName>
  <currencies><currency>USD</currency></currencies>
  <products><product name="Probe"><category>BASE</category></product></products>
  <plans>
    <plan name="probe-monthly">
      <product>Probe</product>
      <finalPhase type="EVERGREEN">
        <duration><unit>UNLIMITED</unit></duration>
        <recurring>
          <billingPeriod>MONTHLY</billingPeriod>
          <recurringPrice><price><currency>USD</currency><value>10.00</value></price></recurringPrice>
        </recurring>
      </finalPhase>
    </plan>
  </plans>
  <priceLists><defaultPriceList name="DEFAULT"><plans><plan>probe-monthly</plan></plans></defaultPriceList></priceLists>
</catalog>`

const headers = {
  authorization: `Basic ${btoa("admin:password")}`,
  "content-type": "application/json",
  "x-killbill-apikey": "bob",
  "x-killbill-apisecret": "lazar",
  "x-killbill-createdby": "acceptance-test",
}

async function withServer(
  options: Parameters<typeof createServer>[0],
  run: (api: {
    post: (path: string, body: unknown) => Promise<Response>
    uploadCatalog: (xml: string) => Promise<Response>
    account: () => Promise<string>
  }) => Promise<void>,
) {
  const server = await createServer(options)
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}/1.0/kb${path}`, { ...init, headers: { ...headers, ...init.headers } })
  const post = (path: string, body: unknown) =>
    request(path, { method: "POST", body: JSON.stringify(body) })
  const uploadCatalog = (xml: string) =>
    request("/catalog/xml", { method: "POST", headers: { "content-type": "text/xml" }, body: xml })
  let accounts = 0
  const account = async () => {
    accounts += 1
    const created = await post("/accounts", { externalKey: `acct-${accounts}`, currency: "USD" })
    return created.headers.get("location")?.split("/").at(-1) as string
  }
  try {
    await run({ post, uploadCatalog, account })
  } finally {
    await server.close()
  }
}

describe("Kill Bill catalog errors on subscription create", () => {
  test("a tenant with no catalog answers as Kill Bill does, so a client knows to upload one", async () => {
    await withServer({ plans: [] }, async ({ post, account }) => {
      const response = await post("/subscriptions", {
        accountId: await account(),
        planName: "premium-monthly",
      })
      expect(response.status).toBe(500)
      const body = (await response.json()) as Record<string, unknown>
      expect(body).toEqual({
        className: "java.lang.IllegalStateException",
        code: null,
        message: expect.stringMatching(NO_CATALOG_MESSAGE),
        causeClassName: null,
        causeMessage: null,
        stackTrace: [],
      })
    })
  })

  test("after a catalog upload, an unknown plan is refused and a known plan subscribes", async () => {
    await withServer({ plans: [] }, async ({ post, uploadCatalog, account }) => {
      expect((await uploadCatalog(CATALOG_XML)).status).toBe(201)
      const accountId = await account()

      const unknown = await post("/subscriptions", { accountId, planName: "premium-monthly" })
      expect(unknown.status).toBe(400)
      expect(await unknown.json()).toEqual({
        className: "org.killbill.billing.subscription.api.user.SubscriptionBaseApiException",
        code: 2021,
        message: "Could not find any plans named 'premium-monthly'",
        causeClassName: "org.killbill.billing.catalog.api.CatalogApiException",
        causeMessage: "Could not find any plans named 'premium-monthly'",
        stackTrace: [],
      })

      const known = await post("/subscriptions", { accountId, planName: "probe-monthly" })
      expect(known.status).toBe(201)
    })
  })

  test("the default seeded catalog keeps its plan and refuses an unknown one with the catalog error", async () => {
    await withServer({}, async ({ post, account }) => {
      const accountId = await account()
      expect(
        (await post("/subscriptions", { accountId, planName: "standard-monthly" })).status,
      ).toBe(201)
      const unknown = await post("/subscriptions", { accountId, planName: "premium-monthly" })
      expect(unknown.status).toBe(400)
      expect(((await unknown.json()) as { code: number }).code).toBe(2021)
    })
  })

  test("a missing account is still refused as before", async () => {
    await withServer({}, async ({ post }) => {
      const response = await post("/subscriptions", {
        accountId: "missing",
        planName: "standard-monthly",
      })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { code: string }).code).toBe("INVALID_SUBSCRIPTION")
    })
  })
})
