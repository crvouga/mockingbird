import { describe, expect, test } from "bun:test"
import { createRuntime, DEFAULT_MARKETING_DOCS, PAYLOAD_CMS_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import { createDefault, type Fetch, PayloadCmsConsumer } from "./test/consumer.js"

const API = "http://payload.mock"

const harness = () => {
  const runtime = createRuntime()
  const fetchImpl: Fetch = (input, init) => runtime.fetch(new Request(input, init))
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const get = async (path: string) => {
    const response = await runtime.fetch(new Request(`${API}${path}`))
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return { runtime, fetchImpl, admin, get, consumer: new PayloadCmsConsumer(API, fetchImpl) }
}

describe("S25 Payload CMS acceptance: our referral-content client against the mock", () => {
  test("the consumer's exact query answers Payload's paginated envelope with the active referral card", async () => {
    const { consumer, get } = harness()
    const page = await get(
      "/api/marketing?where[type][equals]=referral&where[isActive][equals]=true&limit=1",
    )
    expect(page.status).toBe(200)
    expect(page.body).toMatchObject({
      totalDocs: 1,
      limit: 1,
      totalPages: 1,
      page: 1,
      pagingCounter: 1,
      hasPrevPage: false,
      hasNextPage: false,
      prevPage: null,
      nextPage: null,
    })
    const active = DEFAULT_MARKETING_DOCS[1]
    expect(await consumer.getReferralContent()).toEqual({
      card: {
        title: active?.cardTitle as string,
        subtitle: active?.cardSubtitle as string,
        description: active?.cardDescription as string,
      },
      cta: { title: active?.ctaTitle as string, actionText: active?.ctaActionText as string },
      share: { message: active?.shareMessage as string },
      message: active?.shareMessage as string,
    })
    expect(consumer.warnings).toEqual([])
  })

  test("admin-seeded docs drive the card; missing fields merge with the defaults", async () => {
    const { consumer, admin, runtime } = harness()
    runtime.clock.set(Date.parse("2026-09-01T00:00:00.000Z"))
    const created = await admin("/collections/marketing/docs", {
      name: "Fall referral",
      type: "referral",
      isActive: true,
      cardTitle: "Fall Rewards",
      shareMessage: "Fall share",
    })
    expect(created.status).toBe(201)
    expect(((await created.json()) as { id: number }).id).toBe(4)
    const content = await consumer.getReferralContent()
    // Newest first (-createdAt), so the new card wins over the June one.
    expect(content.card.title).toBe("Fall Rewards")
    expect(content.card.subtitle).toBe(createDefault().card.subtitle)
    expect(content.cta).toEqual(createDefault().cta)
    expect(content.share.message).toBe("Fall share")
    expect(content.message).toBe("Fall share")
    await admin("/collections/marketing/docs/4", { isActive: false }, "PATCH")
    expect((await consumer.getReferralContent()).card.title).toBe("Give $150, Get Rewarded")
    await admin("/collections/marketing/docs/2", undefined, "DELETE")
    expect(await consumer.getReferralContent()).toEqual(createDefault())
    expect(consumer.warnings.at(-1)).toBe(
      "No active referral content found in CMS. Falling back to default content.",
    )
  })

  test("the where subset: operators, and/or, sort, paging, and Payload's 400 for an unknown path", async () => {
    const { get, admin } = harness()
    await admin(
      "/collections/marketing",
      {
        docs: Array.from({ length: 12 }, (_, i) => ({
          id: i + 1,
          name: `Doc ${i + 1}`,
          type: i % 3 === 0 ? "banner" : "referral",
          isActive: i % 2 === 0,
          createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        })),
      },
      "PUT",
    )
    const ids = (body: Record<string, unknown>) => (body.docs as { id: number }[]).map((d) => d.id)
    expect(ids((await get("/api/marketing?limit=3&sort=id")).body)).toEqual([1, 2, 3])
    const second = (await get("/api/marketing?limit=5&page=2&sort=id")).body
    expect(ids(second)).toEqual([6, 7, 8, 9, 10])
    expect(second).toMatchObject({
      totalDocs: 12,
      totalPages: 3,
      pagingCounter: 6,
      prevPage: 1,
      nextPage: 3,
    })
    expect(ids((await get("/api/marketing?where[id][in]=2,4,6&sort=id")).body)).toEqual([2, 4, 6])
    expect(ids((await get("/api/marketing?where[id][greater_than]=10&sort=-id")).body)).toEqual([
      12, 11,
    ])
    expect(
      ids((await get("/api/marketing?where[type][not_equals]=referral&sort=id")).body),
    ).toEqual([1, 4, 7, 10])
    expect(ids((await get("/api/marketing?where[name][like]=doc 1&sort=id&limit=0")).body)).toEqual(
      [1, 10, 11, 12],
    )
    expect(
      ids(
        (await get("/api/marketing?where[or][0][id][equals]=1&where[or][1][id][equals]=12&sort=id"))
          .body,
      ),
    ).toEqual([1, 12])
    expect(
      ids(
        (
          await get(
            "/api/marketing?where[and][0][type][equals]=banner&where[and][1][isActive][equals]=true&sort=id",
          )
        ).body,
      ),
    ).toEqual([1, 7])
    const bad = await get("/api/marketing?where[nope][equals]=1")
    expect(bad).toEqual({
      status: 400,
      body: { errors: [{ message: "The following path cannot be queried: nope" }] },
    })
    expect((await get("/api/marketing/99")).status).toBe(404)
    expect((await get("/api/marketing/7")).body).toMatchObject({ id: 7, type: "banner" })
  })

  test("any other seeded collection is served under /api/<slug> too", async () => {
    const { get, admin } = harness()
    await admin("/collections/posts", { docs: [{ id: 1, title: "Hello", slug: "hello" }] }, "PUT")
    expect((await get("/api/posts?where[slug][equals]=hello")).body).toMatchObject({ totalDocs: 1 })
    expect((await get("/api/posts/1")).body).toMatchObject({ title: "Hello" })
    expect((await get("/api/unknown")).status).toBe(404)
  })

  test("every failure preset makes our client fall back to the default content", async () => {
    for (const preset of [
      "server_error",
      "forbidden",
      "collection_not_found",
      "no_active_docs",
      "malformed_json",
      "unavailable",
      "connection_drop",
    ]) {
      const { runtime, consumer } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      expect(await consumer.getReferralContent()).toEqual(createDefault())
      expect(consumer.warnings.length + consumer.errors.length).toBeGreaterThan(0)
      // One-shot: the next read reaches the CMS again.
      expect((await consumer.getReferralContent()).card.title).toBe("Give $150, Get Rewarded")
    }
    expect(Object.keys(PAYLOAD_CMS_PRESETS)).toEqual(
      expect.arrayContaining(["server_error", "no_active_docs", "malformed_json", "slow"]),
    )
  })

  test("with no PAYLOAD_CMS_API_URL the client never calls out", async () => {
    const calls: string[] = []
    const consumer = new PayloadCmsConsumer("", async (input) => {
      calls.push(input)
      return new Response("{}")
    })
    expect(await consumer.getReferralContent()).toEqual(createDefault())
    expect(calls).toEqual([])
  })

  test("namespaces by /ns/ prefix on the base URL and by header isolate workers", async () => {
    const { runtime, fetchImpl, admin } = harness()
    await admin("/collections/marketing/docs/2?namespace=w1", { cardTitle: "Worker one" }, "PATCH")
    expect(
      (await new PayloadCmsConsumer(`${API}/ns/w1`, fetchImpl).getReferralContent()).card.title,
    ).toBe("Worker one")
    expect((await new PayloadCmsConsumer(API, fetchImpl).getReferralContent()).card.title).toBe(
      "Give $150, Get Rewarded",
    )
    const viaHeader = await runtime.fetch(
      new Request(`${API}/api/marketing/2`, { headers: { "x-mockingbird-namespace": "w1" } }),
    )
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/^payload-cms@.*; ns=w1$/)
    expect(((await viaHeader.json()) as { cardTitle: string }).cardTitle).toBe("Worker one")
    const journal = await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=w1`))
    ).json()
    expect(JSON.stringify(journal)).toContain("FindDocuments")
  })
})

describe("served over HTTP", () => {
  test("our client works against the node server with plain fetch", async () => {
    const server = await createServer()
    try {
      const consumer = new PayloadCmsConsumer(server.url, (input, init) => fetch(input, init))
      expect((await consumer.getReferralContent()).card.title).toBe("Give $150, Get Rewarded")
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^payload-cms@/)
    } finally {
      await server.close()
    }
  })
})
