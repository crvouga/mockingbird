import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

// The v1 API, best guess from the vendor's published v1 OpenAPI (not oracle-verified):
// https://docs.firstpromoter.com/api-reference-v1/promoters-api/openapi-promoters.json
// https://docs.firstpromoter.com/api-reference-v1/tracking-api/leads-and-signups.md
// https://docs.firstpromoter.com/api-reference-v1/reports-api/campaign.md

type V1Promoter = {
  id: number
  status: string
  email: string
  cust_id: string | null
  auth_token: string
  default_ref_id: string
  default_promotion_id: number
  note: string | null
  earnings_balance: { cash: number }
  profile: { first_name: string | null; last_name: string | null }
  promotions: {
    id: number
    campaign_id: number
    ref_id: string
    referral_link: string
    campaign_name: string
    leads_count: number
    customers_count: number
    current_referral_reward: { default_promo_code: string } | null
  }[]
}

const harness = (settings: { autoConvert?: boolean } = {}) => {
  const runtime = createRuntime({ settings })
  runtime.clock.freeze()
  runtime.clock.set(Date.parse("2026-10-04T12:00:00Z"))
  const send = (path: string, method = "GET", key: string | null = "v1-key") =>
    runtime.fetch(
      new Request(`http://firstpromoter.test${path}`, {
        method,
        headers: key === null ? {} : { "x-api-key": key },
      }),
    )
  const json = async <T = unknown>(
    path: string,
    method = "GET",
    status = 200,
  ): Promise<NoInfer<T>> => {
    const response = await send(path, method)
    expect(response.status).toBe(status)
    return (await response.json()) as T
  }
  /** Every stored record and counter the routes could touch, as one comparable string. */
  const state = async () => {
    const read = async (path: string) =>
      (await runtime.fetch(new Request(`http://firstpromoter.test/__admin${path}`))).text()
    return [await read("/state"), await read("/promoters"), await read("/referrals")].join("\n")
  }
  const create = (query: string) => json<V1Promoter>(`/v1/promoters/create?${query}`, "POST")
  return { runtime, send, json, state, create }
}

describe("v1 auth", () => {
  test('every v1 route needs X-API-KEY; without it the documented 401 "Bad credentials"', async () => {
    const { send } = harness()
    const response = await send("/v1/promoters/list", "GET", null)
    expect(response.status).toBe(401)
    expect(await response.json()).toBe("Bad credentials")
    // A v2 Bearer token is not a v1 key.
    const bearer = await createRuntime().fetch(
      new Request("http://firstpromoter.test/v1/promoters/list", {
        headers: { authorization: "Bearer k", "account-id": "a" },
      }),
    )
    expect(bearer.status).toBe(401)
  })
})

describe("v1 promoters (best guess, not oracle-verified)", () => {
  test("create → show by every documented identifier → list", async () => {
    const { create, json } = harness()
    const created = await create(
      "email=ada@example.test&first_name=Ada&last_name=Lovelace&cust_id=cus_1&note=hi",
    )
    expect(created).toEqual(
      expect.objectContaining({
        email: "ada@example.test",
        cust_id: "cus_1",
        status: "approved",
        note: "hi",
        earnings_balance: { cash: 0 },
        profile: expect.objectContaining({ first_name: "Ada", last_name: "Lovelace" }),
      }),
    )
    const [promotion] = created.promotions
    expect(promotion?.campaign_id).toBe(1)
    expect(promotion?.campaign_name).toBe("Acme Referral Program")
    expect(promotion?.ref_id).toBe(created.default_ref_id)
    expect(promotion?.id).toBe(created.default_promotion_id)
    expect(promotion?.referral_link).toBe(
      `https://acme.example/referrals?fpr=${created.default_ref_id}`,
    )
    expect(promotion?.current_referral_reward?.default_promo_code).toBe("ACME50")
    for (const query of [
      `id=${created.id}`,
      "cust_id=cus_1",
      `ref_id=${created.default_ref_id}`,
      `auth_token=${created.auth_token}`,
      "promoter_email=ADA@example.test",
    ]) {
      expect((await json<V1Promoter>(`/v1/promoters/show?${query}`)).id).toBe(created.id)
    }
    expect((await json<V1Promoter[]>("/v1/promoters/list")).map((p) => p.id)).toEqual([created.id])
    expect(await json<V1Promoter[]>("/v1/promoters/list?campaign_id=2")).toEqual([])
    expect(await json("/v1/promoters/list?campaign_id=99", "GET", 422)).toEqual({
      error: "Campaign not found.",
    })
  })

  test("the v1 and v2 APIs share one promoter store", async () => {
    const { create, runtime } = harness()
    const created = await create("email=shared@example.test&cust_id=cus_shared&ref_id=shared7")
    const v2 = await runtime.fetch(
      new Request(`http://firstpromoter.test/v2/company/promoters/cus_shared?find_by=cust_id`, {
        headers: { authorization: "Bearer k", "account-id": "a" },
      }),
    )
    expect(v2.status).toBe(200)
    expect(await v2.json()).toEqual(
      expect.objectContaining({
        id: created.id,
        promoter_campaigns: [expect.objectContaining({ ref_token: "shared7" })],
      }),
    )
  })

  test("create rejects duplicates, a taken ref_id and an unknown campaign with {error}", async () => {
    const { create, json, state } = harness()
    await create("email=ada@example.test&cust_id=cus_1&ref_id=ada1")
    const before = await state()
    expect(await json("/v1/promoters/create?email=ADA@example.test", "POST", 422)).toEqual({
      error: "Email has already been taken",
    })
    expect(
      await json("/v1/promoters/create?email=b@example.test&cust_id=cus_1", "POST", 422),
    ).toEqual({ error: "Cust has already been taken" })
    expect(
      await json("/v1/promoters/create?email=b@example.test&ref_id=ada1", "POST", 422),
    ).toEqual({ error: "Ref has already been taken" })
    expect(
      await json("/v1/promoters/create?email=b@example.test&campaign_id=99", "POST", 422),
    ).toEqual({ error: "Campaign not found." })
    expect(await json("/v1/promoters/create", "POST", 422)).toEqual({
      error: "Email can't be blank",
    })
    expect(await state()).toBe(before)
  })

  test("update by id changes the profile, cust_id and ref token; by email when no id is given", async () => {
    const { create, json } = harness()
    const created = await create("email=ada@example.test")
    const updated = await json<V1Promoter>(
      `/v1/promoters/update?id=${created.id}&first_name=Augusta&new_cust_id=cus_9&new_ref_id=augusta1&email=augusta@example.test&note=n`,
      "PUT",
    )
    expect(updated).toEqual(
      expect.objectContaining({
        id: created.id,
        email: "augusta@example.test",
        cust_id: "cus_9",
        default_ref_id: "augusta1",
        note: "n",
        profile: expect.objectContaining({ first_name: "Augusta" }),
      }),
    )
    const byEmail = await json<V1Promoter>(
      "/v1/promoters/update?email=augusta@example.test&last_name=King",
      "PUT",
    )
    expect(byEmail.profile.last_name).toBe("King")
    expect(await json("/v1/promoters/update?id=1", "PUT", 404)).toEqual({
      error: "Promoter not found.",
    })
  })

  test("delete removes the promoter from v1 show/list (archived in the shared store)", async () => {
    const { create, json, runtime } = harness()
    const created = await create("email=ada@example.test&cust_id=cus_1")
    expect(await json("/v1/promoters/delete?cust_id=cus_1", "DELETE")).toEqual({
      message: "Promoter removed.",
    })
    expect(await json(`/v1/promoters/show?id=${created.id}`, "GET", 404)).toEqual({
      error: "Promoter not found.",
    })
    expect(await json("/v1/promoters/list")).toEqual([])
    expect(await json(`/v1/promoters/delete?id=${created.id}`, "DELETE", 404)).toEqual({
      error: "Promoter not found.",
    })
    const v2 = (await (
      await runtime.fetch(
        new Request(`http://firstpromoter.test/v2/company/promoters/${created.id}`, {
          headers: { authorization: "Bearer k", "account-id": "a" },
        }),
      )
    ).json()) as { state: string }
    expect(v2.state).toBe("archived")
    expect(await json("/v1/promoters/delete", "DELETE", 422)).toEqual({
      error: "One of id, cust_id, ref_id or auth_token is required",
    })
  })

  test("documented options the emulator does not model are an explicit 501 and change nothing", async () => {
    const { create, json, state } = harness()
    const created = await create("email=ada@example.test")
    const before = await state()
    const unsupported = {
      message: "Mockingbird: v1 promoter option paypal_email is not modelled",
      code: "mockingbird_unsupported",
    }
    expect(
      await json("/v1/promoters/create?email=b@example.test&paypal_email=x@y.z", "POST", 501),
    ).toEqual(unsupported)
    expect(
      await json(`/v1/promoters/update?id=${created.id}&paypal_email=x@y.z`, "PUT", 501),
    ).toEqual(unsupported)
    expect(await state()).toBe(before)
  })
})

describe("POST /v1/track/signup (best guess, not oracle-verified)", () => {
  test("tracks a lead by ref_id or tid and returns {id, type: signup, lead, promoter}", async () => {
    const { create, json, runtime } = harness({ autoConvert: false })
    const created = await create("email=ada@example.test&ref_id=ada7")
    const tracked = await json<{
      type: string
      amount_cents: null
      lead: { id: number; email: string; uid: string | null; state: string }
      promoter: { id: number; default_ref_id: string }
    }>("/v1/track/signup?email=lead@example.test&uid=u1&ref_id=ada7", "POST")
    expect(tracked.type).toBe("signup")
    expect(tracked.amount_cents).toBeNull()
    expect(tracked.lead).toEqual(
      expect.objectContaining({ email: "lead@example.test", uid: "u1", state: "signup" }),
    )
    expect(tracked.promoter).toEqual(
      expect.objectContaining({ id: created.id, default_ref_id: "ada7" }),
    )
    const click = (await (
      await runtime.fetch(
        new Request("http://firstpromoter.test/__admin/clicks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref_token: "ada7" }),
        }),
      )
    ).json()) as { tid: string }
    const byTid = await json<{ lead: { email: string } }>(
      `/v1/track/signup?email=second@example.test&tid=${click.tid}`,
      "POST",
    )
    expect(byTid.lead.email).toBe("second@example.test")
    const shown = await json<V1Promoter>(`/v1/promoters/show?id=${created.id}`)
    expect(shown.promotions[0]?.leads_count).toBe(2)
  })

  test("documented errors: 400 blank, 404 unknown visitor, 422 already tracked", async () => {
    const { create, json, state } = harness()
    await create("email=ada@example.test&ref_id=ada7")
    await json("/v1/track/signup?email=lead@example.test&ref_id=ada7", "POST")
    const before = await state()
    expect(await json("/v1/track/signup?ref_id=ada7", "POST", 400)).toEqual({
      message: "Error. Email and uid can not be blank!",
    })
    expect(await json("/v1/track/signup?email=x@example.test&ref_id=nobody", "POST", 404)).toEqual({
      message:
        "Visitor  invalid, not found or you are trying to use the signup tracking test via API which doesn't work on API calls.",
    })
    expect(await json("/v1/track/signup?email=LEAD@example.test&ref_id=ada7", "POST", 422)).toEqual(
      { transaction_id: "there is already a signup event registered on this lead" },
    )
    expect(await state()).toBe(before)
  })

  test("a uid-only lead and unmodelled options are an explicit 501 and track nothing", async () => {
    const { create, json, state } = harness()
    await create("email=ada@example.test&ref_id=ada7")
    const before = await state()
    expect(await json("/v1/track/signup?uid=u1&ref_id=ada7", "POST", 501)).toEqual({
      message: "Mockingbird: v1 signup tracking without email is not modelled",
      code: "mockingbird_unsupported",
    })
    expect(
      await json("/v1/track/signup?email=x@example.test&ref_id=ada7&sub_id=s", "POST", 501),
    ).toEqual({
      message: "Mockingbird: v1 signup option sub_id is not modelled",
      code: "mockingbird_unsupported",
    })
    expect(await state()).toBe(before)
  })
})

describe("GET /v1/reports/campaigns (best guess, not oracle-verified)", () => {
  test("per-campaign totals and month periods from clicks, leads, customers and sales", async () => {
    const { create, json, runtime } = harness()
    await create("email=ada@example.test&ref_id=ada7")
    await runtime.fetch(
      new Request("http://firstpromoter.test/__admin/clicks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref_token: "ada7" }),
      }),
    )
    await json("/v1/track/signup?email=lead@example.test&ref_id=ada7", "POST")
    const sale = await runtime.fetch(
      new Request("http://firstpromoter.test/v2/track/sale", {
        method: "POST",
        headers: {
          authorization: "Bearer k",
          "account-id": "a",
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_id: "e1", amount: 61317, email: "lead@example.test" }),
      }),
    )
    expect(sale.status).toBe(200)
    const report = await json<
      {
        campaign_id: number
        campaign_name: string
        revenue_amount: string
        clicks_count: number
        referrals_count: number
        customers_count: number
        items: Record<string, unknown>[]
      }[]
    >("/v1/reports/campaigns?start_date=2026-08-15&end_date=2026-10-31")
    expect(report.map((c) => [c.campaign_id, c.campaign_name])).toEqual([
      [1, "Acme Referral Program"],
      [2, "Partner Program"],
    ])
    expect(report[0]).toEqual(
      expect.objectContaining({
        revenue_amount: "$613.17",
        clicks_count: 1,
        referrals_count: 1,
        customers_count: 1,
      }),
    )
    expect(report[0]?.items).toEqual([
      {
        period: "Aug 2026",
        revenue_amount: "$0.00",
        clicks_count: 0,
        referrals_count: 0,
        customers_count: 0,
      },
      {
        period: "Sep 2026",
        revenue_amount: "$0.00",
        clicks_count: 0,
        referrals_count: 0,
        customers_count: 0,
      },
      {
        period: "Oct 2026",
        revenue_amount: "$613.17",
        clicks_count: 1,
        referrals_count: 1,
        customers_count: 1,
      },
    ])
    const fields = await json<Record<string, unknown>[]>(
      "/v1/reports/campaigns?selected_fields[]=referrals_count&group_by=year&start_date=2026-01-01&end_date=2026-12-31",
    )
    expect(fields[0]).toEqual({
      campaign_name: "Acme Referral Program",
      campaign_id: 1,
      referrals_count: 1,
      items: [{ period: "2026", referrals_count: 1 }],
    })
  })

  test("invalid fields or grouping are 422 {message, code}; unmodelled fields are 501", async () => {
    const { json } = harness()
    expect(await json("/v1/reports/campaigns?selected_fields[]=bogus", "GET", 422)).toEqual({
      message: "Selected Fields invalid !",
      code: "invalid_params",
    })
    expect(await json("/v1/reports/campaigns?group_by=week", "GET", 422)).toEqual({
      message: "Group by invalid !",
      code: "invalid_params",
    })
    expect(
      await json(
        "/v1/reports/campaigns?group_by=day&start_date=2026-01-01&end_date=2026-10-04",
        "GET",
        422,
      ),
    ).toEqual({ message: "Day grouping is limited to 90 days", code: "invalid_params" })
    expect(await json("/v1/reports/campaigns?selected_fields[]=monthly_churn", "GET", 501)).toEqual(
      {
        message: "Mockingbird: v1 report field monthly_churn is not modelled",
        code: "mockingbird_unsupported",
      },
    )
  })
})

describe("POST /v1/promoters/iframe_login (emulator limitation)", () => {
  test("is an explicit 501 unsupported error, not a fabricated token, and changes nothing", async () => {
    const { create, send, state } = harness()
    const created = await create("email=ada@example.test")
    const before = await state()
    const response = await send(`/v1/promoters/iframe_login?id=${created.id}`, "POST")
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({
      message: "Mockingbird: V1IframeLogin is not implemented",
      code: "mockingbird_unsupported",
    })
    expect(await state()).toBe(before)
  })
})

describe("v1 namespaces", () => {
  test("PUT /__admin/credentials maps an X-API-KEY to a namespace", async () => {
    const runtime = createRuntime()
    const call = (path: string, key: string, method = "GET") =>
      runtime.fetch(
        new Request(`http://firstpromoter.test${path}`, { method, headers: { "x-api-key": key } }),
      )
    await runtime.fetch(
      new Request("http://firstpromoter.test/__admin/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { worker_1: "w1" } }),
      }),
    )
    expect(
      (await call("/v1/promoters/create?email=a@example.test", "worker_1", "POST")).status,
    ).toBe(200)
    expect(await (await call("/v1/promoters/list", "worker_1")).json()).toHaveLength(1)
    expect(await (await call("/v1/promoters/list", "other")).json()).toHaveLength(0)
  })
})
