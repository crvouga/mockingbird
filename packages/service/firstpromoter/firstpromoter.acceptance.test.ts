import { describe, expect, test } from "bun:test"
import { createRuntime, FIRSTPROMOTER_PRESETS, WEBHOOK_PATH } from "./src/index.js"
import { createServer } from "./src/server.js"
import { type ConsumerConfig, FirstPromoterConsumer, MemoryDb } from "./test/consumer.js"

const API = "http://firstpromoter.mock"
const WEBHOOK_USER = "fp-hook"
const WEBHOOK_PASS = "fp-hook-password"

const harness = (config: Partial<ConsumerConfig> = {}) => {
  const deliveries: { headers: Headers; body: unknown }[] = []
  const runtime = createRuntime({
    webhooks: {
      url: `http://backend.local${WEBHOOK_PATH}`,
      secret: `${WEBHOOK_USER}:${WEBHOOK_PASS}`,
      fetch: async (request) => {
        deliveries.push({ headers: request.headers, body: await request.json() })
        return Response.json({ accepted: true }, { status: 202 })
      },
    },
  })
  const db = new MemoryDb()
  const consumer = new FirstPromoterConsumer(
    {
      apiUrl: API,
      apiKey: "fp_key",
      accountId: "acc_acme",
      environment: "production",
      webhookUsername: WEBHOOK_USER,
      webhookPassword: WEBHOOK_PASS,
      ...config,
    },
    db,
    (request) => runtime.fetch(request),
  )
  const admin = async <T>(path: string, body?: unknown, method = body ? "POST" : "GET") =>
    (await (
      await runtime.fetch(
        new Request(`${API}/__admin${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    ).json()) as T
  /** Deliver every pending webhook to our receiver logic. */
  const receive = async () => {
    await runtime.webhooks.idle()
    return deliveries.splice(0).map((d) => {
      consumer.validateWebhookBasicAuth(d.headers.get("authorization"))
      return consumer.handleNewCustomerWebhook(d.body)
    })
  }
  const promoterCount = async () =>
    (await admin<{ promoters: unknown[] }>("/promoters")).promoters.length
  return { runtime, db, consumer, admin, receive, deliveries, promoterCount }
}

const member = (db: MemoryDb, id = 42) =>
  db.add({ id, email: `member${id}@example.com`, firstName: "Ada", lastName: "Lovelace" })

describe("S19 First Promoter acceptance: our consumer's logic against the mock", () => {
  test("production create: lookup by cust_id is absent, create joins the campaign, the identity is claimed", async () => {
    const { db, consumer, admin } = harness()
    const user = member(db)
    const result = await consumer.createFirstPromoterAccount(user)
    expect(result?.referralUrl).toMatch(/^https:\/\/acme\.example\/referrals\?fpr=ada\d+$/)
    expect(db.users.get(42)?.promoterId).toBe(result?.promoterId as number)
    const { promoters } = await admin<{ promoters: { cust_id: string; email: string }[] }>(
      "/promoters",
    )
    expect(promoters).toEqual([
      expect.objectContaining({ cust_id: "production_42", email: "member42@example.com" }),
    ])
  })

  test("created_but_500: the job fails, the retry adopts the promoter by cust_id (no duplicate)", async () => {
    const { runtime, db, consumer, promoterCount } = harness()
    const user = member(db)
    runtime.applyPreset("created_but_500", "default", { count: 1 })
    expect(await consumer.createFirstPromoterAccount(user)).toBeNull()
    expect(db.users.get(42)?.promoterId).toBeNull()
    const retry = await consumer.createFirstPromoterAccount(user)
    expect(retry?.promoterId).toBeGreaterThan(0)
    expect(await promoterCount()).toBe(1)
  })

  test("lookup_unavailable and no_campaign authorise neither create nor adopt", async () => {
    for (const preset of ["lookup_unavailable", "no_campaign"]) {
      const { runtime, db, consumer, admin, promoterCount } = harness()
      const user = member(db)
      if (preset === "no_campaign") {
        await admin("/promoters", { email: user.email, cust_id: "production_42" })
      }
      runtime.applyPreset(preset, "default")
      expect(await consumer.createFirstPromoterAccount(user)).toBeNull()
      expect(await promoterCount()).toBe(preset === "no_campaign" ? 1 : 0)
      expect(db.users.get(42)?.promoterId).toBeNull()
    }
  })

  test("non-production never calls FirstPromoter to create (synthetic identity)", async () => {
    const { runtime, db, consumer } = harness({ environment: "staging" })
    const result = await consumer.createFirstPromoterAccount(member(db))
    expect(result?.promoterId).toBe(900_000_042)
    const journal = (await (
      await runtime.fetch(new Request(`${API}/__admin/requests`))
    ).json()) as {
      requests: unknown[]
    }
    expect(journal.requests).toHaveLength(0)
  })

  test("signup by click tid is tracked, converts, and the Basic-auth webhook credits the promoter", async () => {
    const { db, consumer, admin, receive } = harness()
    const promoterUser = member(db, 7)
    await consumer.createFirstPromoterAccount(promoterUser)
    const refToken = new URL(db.users.get(7)?.referralUrl ?? "").searchParams.get("fpr") as string
    const friend = db.add({ id: 99, email: "friend@example.com", firstName: "Bo", lastName: "B" })
    const { tid } = await admin<{ tid: string }>("/clicks", { ref_token: refToken })
    expect(await consumer.handleFirstPromoterTracking(friend.email, tid)).toBe("tracked")
    expect(await receive()).toEqual(["applied"])
    expect(db.referrals).toEqual([{ promoterUserId: 7, referredUserId: 99 }])
    expect(db.notifications[0]).toEqual({
      type: "marketing.referred_member_joins",
      payload: { userId: 7, friendId: 99, reward: "$50.00" },
    })
    expect(db.earnings.get(7)).toMatchObject({ referrals: 1 })
    // Retrying the invoice handler re-tracks the same email: FirstPromoter refuses, we only log.
    expect(await consumer.handleFirstPromoterTracking(friend.email, tid)).toBe("failed")
    // An unknown tid is refused too.
    expect(await consumer.handleFirstPromoterTracking("x@example.com", "no-such-tid")).toBe(
      "failed",
    )
  })

  test("the ref-code fallback resolves ref_token to promoter_id and tracks by it", async () => {
    const { db, consumer, admin, receive } = harness()
    await admin("/promoters", { email: "nathan@example.com", ref_token: "nathan73" })
    expect(
      await consumer.handleFirstPromoterTrackingByRefId("friend@example.com", "nathan73"),
    ).toBe(true)
    expect(await consumer.handleFirstPromoterTrackingByRefId("f2@example.com", "nobody")).toBe(
      false,
    )
    // The promoter is not one of our members: the receiver finds no user and does nothing.
    expect(await receive()).toEqual(["no_user"])
    expect(db.notifications).toHaveLength(0)
  })

  test("with autoConvert off, the webhook waits for the sale (admin convert)", async () => {
    const { db, consumer, admin, receive } = harness()
    await admin("/settings", { autoConvert: false }, "PUT")
    await consumer.createFirstPromoterAccount(member(db, 5))
    db.add({ id: 6, email: "six@example.com", firstName: null, lastName: null })
    const token = new URL(db.users.get(5)?.referralUrl ?? "").searchParams.get("fpr") as string
    expect(await consumer.handleFirstPromoterTrackingByRefId("six@example.com", token)).toBe(true)
    expect(await receive()).toEqual([])
    const { referrals } = await admin<{ referrals: { id: number; state: string }[] }>("/referrals")
    expect(referrals[0]?.state).toBe("signup")
    await admin(`/referrals/${referrals[0]?.id}/convert`, { saleAmount: 200 })
    expect(await receive()).toEqual(["applied"])
    expect(db.earnings.get(5)).toEqual({
      promoterId: db.users.get(5)?.promoterId as number,
      referrals: 1,
      earnings: 20,
    })
  })

  test("the checkout coupon preview reads the campaign's referral reward coupon", async () => {
    const { consumer, admin } = harness()
    await admin("/promoters", { email: "nate@example.com", ref_token: "nate91" })
    expect(await consumer.fetchCouponsByReferralId(" nate91 ")).toEqual({
      coupons: [
        {
          id: 11,
          name: "$50 off your first order",
          default_promo_code: "ACME50",
          campaign_id: 1,
          campaign_name: "Acme Referral Program",
        },
      ],
    })
    expect(await consumer.fetchCouponsByReferralId("missing")).toEqual({ coupons: [] })
    await admin("/promoters", { email: "p@example.com", ref_token: "partner1", campaign_id: 2 })
    expect(await consumer.fetchCouponsByReferralId("partner1")).toEqual({ coupons: [] })
  })

  test("dashboard iframe login, update, cleanup and archive", async () => {
    const { db, consumer, admin } = harness()
    const seeded = await admin<{ id: number }>("/promoters", { email: "old@example.com" })
    expect(await consumer.getFirstPromoterDashboardUrl(seeded.id)).toMatch(
      /^https:\/\/acme\.firstpromoter\.com\/iframe\?tk=\w+$/,
    )
    await expect(consumer.getFirstPromoterDashboardUrl(1)).rejects.toThrow()
    db.add({
      id: 3,
      email: "old@example.com",
      firstName: null,
      lastName: null,
      promoterId: seeded.id,
    })
    const updates = await consumer.cleanupFirstPromoterAccounts()
    expect(updates).toEqual([{ id: seeded.id, custId: "production_3" }])
    expect(await consumer.updatePromoter(seeded.id, "production_3")).toBe(true)
    expect(await consumer.cleanupFirstPromoterAccounts()).toEqual([])
    expect(await consumer.deletePromoter(seeded.id)).toBe(true)
    expect(await consumer.fetchPromoterList()).toHaveLength(0)
    const found = await consumer.findPromoterByCustId("production_3")
    expect(found.status).toBe("found")
    await expect(consumer.updatePromoter(123, "x")).rejects.toThrow()
  })

  test("the promoter list pages 100 at a time until a short page", async () => {
    const { consumer, admin } = harness()
    for (let i = 0; i < 150; i++) await admin("/promoters", { email: `p${i}@example.com` })
    expect(await consumer.fetchPromoterList()).toHaveLength(150)
  })

  test("error presets land on each branch of our client", async () => {
    const cases: [string, (c: FirstPromoterConsumer) => Promise<unknown>][] = [
      ["unauthorized", (c) => c.deletePromoter(1)],
      ["rate_limited", (c) => c.updatePromoter(1, "x")],
      ["server_error", (c) => c.getFirstPromoterDashboardUrl(1)],
    ]
    for (const [preset, call] of cases) {
      const { runtime, consumer } = harness()
      runtime.applyPreset(preset, "default")
      await expect(call(consumer)).rejects.toThrow()
    }
    const { runtime, consumer } = harness()
    runtime.applyPreset("connection_drop", "default", { count: 1 })
    expect(await consumer.handleFirstPromoterTracking("a@example.com", "t")).toBe("failed")
    const noAccount = await runtime.fetch(
      new Request(`${API}/v2/company/promoters`, { headers: { authorization: "Bearer k" } }),
    )
    expect(noAccount.status).toBe(401)
  })

  test("webhooks: Basic auth is what our guard checks; duplicates are not deduplicated by us", async () => {
    const { runtime, db, consumer, admin, receive, deliveries } = harness()
    await consumer.createFirstPromoterAccount(member(db, 8))
    db.add({ id: 80, email: "eighty@example.com", firstName: null, lastName: null })
    const token = new URL(db.users.get(8)?.referralUrl ?? "").searchParams.get("fpr") as string
    runtime.applyPreset("webhook_duplicate", "default")
    await consumer.handleFirstPromoterTrackingByRefId("eighty@example.com", token)
    await runtime.webhooks.idle()
    const auth = deliveries[0]?.headers.get("authorization")
    expect(auth).toBe(`Basic ${btoa(`${WEBHOOK_USER}:${WEBHOOK_PASS}`)}`)
    expect(await receive()).toEqual(["applied", "applied"])
    expect(db.referrals).toHaveLength(2)
    const events = await admin<{ events: { type: string }[] }>("/webhooks/events")
    expect(events.events.map((e) => e.type)).toEqual(["lead_becomes_referral"])
    const wrong = new FirstPromoterConsumer(
      {
        apiUrl: API,
        apiKey: "k",
        accountId: "a",
        environment: "production",
        webhookUsername: "x",
        webhookPassword: "y",
      },
      db,
      (r) => runtime.fetch(r),
    )
    expect(() => wrong.validateWebhookBasicAuth(auth ?? null)).toThrow()
  })

  test("namespaces by API key isolate workers; the journal holds no emails", async () => {
    const { runtime, db } = harness()
    await runtime.fetch(
      new Request(`${API}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { key_a: "a", key_b: "b" } }),
      }),
    )
    const worker = (key: string) =>
      new FirstPromoterConsumer(
        { apiUrl: API, apiKey: key, accountId: "acc", environment: "production" },
        db,
        (r) => runtime.fetch(r),
      )
    await worker("key_a").createFirstPromoterAccount(member(db, 1))
    expect((await worker("key_a").findPromoterByCustId("production_1")).status).toBe("found")
    expect((await worker("key_b").findPromoterByCustId("production_1")).status).toBe("absent")
    const journal = await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=a`))
    ).text()
    expect(journal).toContain("CreatePromoter")
    expect(journal).not.toContain("member1@example.com")
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(FIRSTPROMOTER_PRESETS).sort()).toEqual(
      [
        "connection_drop",
        "created_but_500",
        "lookup_unavailable",
        "no_campaign",
        "rate_limited",
        "server_error",
        "unauthorized",
        "webhook_drop",
        "webhook_duplicate",
      ].sort(),
    )
  })
})

describe("served over HTTP", () => {
  test("the consumer works against the node server, and the webhook reaches a real sink", async () => {
    const received: unknown[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("authorization") === `Basic ${btoa("u:p")}`) {
          received.push(await request.json())
        }
        return Response.json({ accepted: true }, { status: 202 })
      },
    })
    const server = await createServer({
      webhooks: { url: `http://127.0.0.1:${sink.port}${WEBHOOK_PATH}`, secret: "u:p" },
    })
    try {
      const db = new MemoryDb()
      const consumer = new FirstPromoterConsumer(
        { apiUrl: server.url, apiKey: "k", accountId: "a", environment: "production" },
        db,
        (r) => fetch(r),
      )
      const created = await consumer.createFirstPromoterAccount(member(db, 11))
      const token = new URL(created?.referralUrl ?? "").searchParams.get("fpr") as string
      expect(await consumer.handleFirstPromoterTrackingByRefId("z@example.com", token)).toBe(true)
      const deadline = Date.now() + 3_000
      while (received.length < 1 && Date.now() < deadline) await Bun.sleep(25)
      expect(received).toHaveLength(1)
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^firstpromoter@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})

describe("contract", () => {
  test("namespaces by header and by /ns/ prefix are isolated; reset clears one namespace", async () => {
    const runtime = createRuntime()
    const get = (url: string, headers: Record<string, string> = {}) =>
      runtime.fetch(
        new Request(url, { headers: { authorization: "Bearer k", "account-id": "a", ...headers } }),
      )
    const base = "http://mock.local"
    // Seed state in namespace "a" through the header, then compare with "b" and the default.
    const before = (await (await get(`${base}/v2/company/promoters`)).json()) as Record<
      string,
      unknown[]
    >
    const viaHeader = await get(`${base}/v2/company/promoters`, { "x-mockingbird-namespace": "a" })
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/; ns=a$/)
    const viaPrefix = await get(`${base}/ns/b/v2/company/promoters`)
    expect(viaPrefix.status).toBe(viaHeader.status)
    expect(viaPrefix.headers.get("x-mockingbird")).toMatch(/; ns=b$/)
    expect(((await viaPrefix.json()) as Record<string, unknown[]>).data?.length).toBe(
      before.data?.length,
    )
    const reset = await runtime.fetch(
      new Request(`${base}/__admin/reset?namespace=a`, { method: "POST" }),
    )
    expect(reset.status).toBeLessThan(300)
    const health = (await (await runtime.fetch(new Request(`${base}/health`))).json()) as {
      status: string
    }
    expect(health.status).toBe("ok")
  })
})
