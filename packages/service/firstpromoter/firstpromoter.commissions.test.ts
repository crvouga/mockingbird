import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

type Commission = { id: number; status: string; amount: number; unit: string }
type Batch = {
  id: number
  status: string
  processed_count: number
  failed_count: number
  progress: number
  processing_errors: string[]
}

const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  runtime.clock.set(Date.parse("2026-10-04T12:00:00Z"))
  const send = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    namespace = "default",
    auth = true,
  ) =>
    runtime.fetch(
      new Request(`http://firstpromoter.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-mockingbird-namespace": namespace,
          ...(auth ? { authorization: "Bearer fixture", "account-id": "fixture" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const json = async (path: string, body?: unknown, status = 200, method?: string) => {
    const response = await send(path, body, method)
    expect(response.status).toBe(status)
    return response.json()
  }
  const seed = async (count = 8) => {
    const promoter = (await json("/v2/company/promoters", {
      email: "commission@example.test",
    })) as { promoter_campaigns: { id: number }[] }
    const rows: Commission[] = []
    for (let i = 0; i < count; i++) {
      runtime.clock.advance(1000)
      rows.push(
        (await json(
          "/__admin/commissions",
          {
            promoter_campaign_id: promoter.promoter_campaigns[0]?.id,
            amount: i + 10,
            unit: "points",
            status: i === 0 ? "pending" : "approved",
            fulfilled: i === 1,
          },
          201,
        )) as Commission,
      )
    }
    return rows
  }
  return { runtime, send, json, seed }
}

describe("FirstPromoter commission reconciliation", () => {
  test("seeded nonmonetary commissions filter by approval and fulfillment", async () => {
    const { json, seed } = harness()
    const rows = await seed()
    expect(
      await json("/v2/company/commissions?filters[status]=approved&filters[fulfilled]=yes"),
    ).toEqual([rows[1]])
    const unfulfilled = (await json(
      "/v2/company/commissions?filters[status]=approved&filters[fulfilled]=no",
    )) as Commission[]
    expect(unfulfilled.map((row) => row.id)).toEqual(
      rows
        .slice(2)
        .reverse()
        .map((row) => row.id),
    )
    expect(await json("/v2/company/commissions?filters[status]=denied")).toEqual([])
  })

  test("repeated IDs, query search and numeric pages remain deterministic", async () => {
    const { json, seed } = harness()
    const rows = await seed()
    const ids: number[] = []
    for (let page = 1; page <= 5; page++) {
      ids.push(
        ...((await json(`/v2/company/commissions?page=${page}&per_page=2`)) as Commission[]).map(
          (row) => row.id,
        ),
      )
    }
    expect(ids).toEqual([...rows].reverse().map((row) => row.id))
    expect(
      await json(
        `/v2/company/commissions?ids[]=${rows[2]?.id}&ids[]=${rows[4]?.id}&per_page=1&page=2`,
      ),
    ).toEqual([rows[2]])
    expect(await json("/v2/company/commissions?q=COMMISSION%40example.test")).toHaveLength(8)
    expect(await json("/v2/company/commissions?q=absent")).toEqual([])
  })

  test("fulfillment mutates shared records and reports successful and failed items", async () => {
    const { json, seed } = harness()
    const rows = await seed()
    const batch = (await json("/v2/company/commissions/mark_fulfilled", {
      ids: [rows[2]?.id, rows[3]?.id, 99999999],
    })) as Batch
    expect(batch).toMatchObject({
      status: "completed",
      total: 3,
      selected_total: 3,
      processed_count: 2,
      failed_count: 1,
      progress: 100,
    })
    expect(batch.processing_errors).toHaveLength(1)
    expect(await json(`/v2/company/batch_processes/${batch.id}`)).toEqual(batch)
    expect(
      ((await json("/v2/company/commissions?filters[fulfilled]=yes")) as Commission[]).map(
        (row) => row.id,
      ),
    ).toEqual([rows[3], rows[2], rows[1]].map((row) => (row as Commission).id))
    const removed = (await json(
      "/v2/company/commissions/destroy",
      { ids: [rows[2]?.id] },
      200,
      "DELETE",
    )) as Batch
    expect(removed.processed_count).toBe(1)
    expect(await json(`/v2/company/commissions?ids[]=${rows[2]?.id}`)).toEqual([])
  })

  test("large batches progress on the mock clock, persist through snapshots, and expose partial failures", async () => {
    const { runtime, json, seed } = harness()
    const rows = await seed()
    runtime.applyPreset("batch_partial_failure", "default", { count: 1 })
    const ids = rows.slice(2).map((row) => row.id)
    const pending = (await json("/v2/company/commissions/mark_fulfilled", { ids }, 202)) as Batch
    expect(pending).toMatchObject({
      status: "pending",
      processed_count: 0,
      failed_count: 0,
      progress: 0,
    })
    expect(await json("/v2/company/batch_processes")).toEqual([pending])
    expect(await json("/v2/company/batch_processes/progress")).toEqual({ [pending.id]: 0 })
    const snapshot = (await json("/__admin/snapshots", {}, 201)) as { id: string }
    runtime.clock.advance(500)
    expect(await json(`/v2/company/batch_processes/${pending.id}`)).toMatchObject({
      status: "in_progress",
    })
    runtime.clock.advance(500)
    const complete = (await json(`/v2/company/batch_processes/${pending.id}`)) as Batch
    expect(complete).toMatchObject({
      status: "completed",
      processed_count: 5,
      failed_count: 1,
      progress: 100,
    })
    expect(complete.processing_errors).toHaveLength(1)
    expect(await json("/v2/company/batch_processes")).toEqual([])
    const fulfilled = (await json("/v2/company/commissions?filters[fulfilled]=yes")) as Commission[]
    expect(fulfilled).toHaveLength(6)
    expect(fulfilled.some((row) => row.id === ids[0])).toBe(false)
    await json(`/__admin/snapshots/${snapshot.id}/restore`, {})
    expect(await json(`/v2/company/batch_processes/${pending.id}`)).toEqual(pending)
    runtime.clock.advance(1000)
    expect(await json(`/v2/company/batch_processes/${pending.id}`)).toEqual(complete)
  })

  test("auth, faults, namespace isolation and reset protect commission writes", async () => {
    const { runtime, send, json, seed } = harness()
    const rows = await seed()
    const path = "/v2/company/commissions/mark_fulfilled"
    const body = { ids: [rows[2]?.id] }
    expect((await send(path, body, "POST", "default", false)).status).toBe(401)
    for (const [preset, status] of [
      ["rate_limited", 429],
      ["server_error", 500],
    ] as const) {
      runtime.applyPreset(preset, "default", { count: 1 })
      expect((await send(path, body)).status).toBe(status)
    }
    expect(await json("/v2/company/commissions?filters[fulfilled]=yes")).toEqual([rows[1]])
    expect(await (await send("/v2/company/commissions", undefined, "GET", "other")).json()).toEqual(
      [],
    )
    const invalid = await send("/__admin/commissions", { promoter_campaign_id: 999999, amount: 20 })
    expect(invalid.status).toBe(400)
    expect(await json("/v2/company/commissions")).toHaveLength(8)
    const pending = (await json(path, { ids: rows.slice(2).map((row) => row.id) }, 202)) as Batch
    await json("/__admin/reset", {})
    runtime.clock.advance(2000)
    expect(await json("/v2/company/commissions")).toEqual([])
    expect((await send(`/v2/company/batch_processes/${pending.id}`)).status).toBe(404)
  })

  test("PUT /v2/company/commissions/{id} updates the notes and listings reflect them", async () => {
    const { json, send, seed } = harness()
    const rows = await seed()
    const target = rows[3] as Commission
    const updated = await json(
      `/v2/company/commissions/${target.id}`,
      { internal_note: "audited", external_note: "paid in cash" },
      200,
      "PUT",
    )
    expect(updated).toMatchObject({
      id: target.id,
      status: target.status,
      amount: target.amount,
      internal_note: "audited",
      external_note: "paid in cash",
    })
    const listed = (await json(`/v2/company/commissions?ids[]=${target.id}`)) as unknown[]
    expect(listed).toEqual([updated])
    const partial = await json(
      `/v2/company/commissions/${target.id}`,
      { external_note: "revised" },
      200,
      "PUT",
    )
    expect(partial).toMatchObject({ internal_note: "audited", external_note: "revised" })
    expect(await json(`/v2/company/commissions?ids[]=${rows[4]?.id}`)).toEqual([rows[4]])
    const missing = await send("/v2/company/commissions/99999999", { internal_note: "x" }, "PUT")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ message: "Commission not found", code: "not_found" })
    const invalid = await send(`/v2/company/commissions/${target.id}`, { internal_note: 5 }, "PUT")
    expect(invalid.status).toBe(422)
    expect(
      (await send(`/v2/company/commissions/${target.id}`, {}, "PUT", "default", false)).status,
    ).toBe(401)
  })
})
