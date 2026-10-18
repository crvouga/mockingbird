import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  const send = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`http://firstpromoter.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture",
          "account-id": "fixture",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const json = async (path: string, body?: unknown, status = 200, method?: string) => {
    const response = await send(path, body, method)
    expect(response.status).toBe(status)
    return response.json()
  }
  return { runtime, send, json }
}

type Promoter = { id: number; promoter_campaigns: { id: number }[] }

describe("FirstPromoter promoter lookup by find_by", () => {
  test("promo_code finds the promoter that owns the seeded code", async () => {
    const { json } = harness()
    const promoter = (await json(
      "/__admin/promoters",
      { email: "code@example.test" },
      201,
    )) as Promoter
    await json(
      "/__admin/promo-codes",
      { promo_code: "SYNTH10", promoter_campaign_id: promoter.promoter_campaigns[0]?.id },
      201,
    )
    const found = (await json("/v2/company/promoters/SYNTH10?find_by=promo_code")) as Promoter
    expect(found.id).toBe(promoter.id)
    expect(await json("/v2/company/promoters/UNSEEDED?find_by=promo_code", undefined, 404)).toEqual(
      {
        message: "Promoter not found",
      },
    )
  })

  test("auth_token finds the promoter by the token the admin routes expose", async () => {
    const { json } = harness()
    const promoter = (await json(
      "/__admin/promoters",
      { email: "token@example.test" },
      201,
    )) as Promoter & {
      auth_token: string
    }
    const other = (await json(
      "/__admin/promoters",
      { email: "other@example.test" },
      201,
    )) as Promoter & {
      auth_token: string
    }
    expect(promoter.auth_token).not.toBe(other.auth_token)
    const found = (await json(
      `/v2/company/promoters/${promoter.auth_token}?find_by=auth_token`,
    )) as Promoter
    expect(found.id).toBe(promoter.id)
    await json("/v2/company/promoters/nope?find_by=auth_token", undefined, 404)
    const listed = (await json("/__admin/promoters")) as { promoters: { auth_token: string }[] }
    expect(listed.promoters.map((p) => p.auth_token)).toContain(promoter.auth_token)
  })

  test("unlisted find_by values still answer 400 with the full list", async () => {
    const { json } = harness()
    expect(await json("/v2/company/promoters/1?find_by=name", undefined, 400)).toEqual({
      message: "find_by must be one of id, cust_id, auth_token, ref_token, promo_code, email",
    })
  })
})
