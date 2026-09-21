import { describe, expect, test } from "bun:test"
import { createRuntime, PLANE_PRESETS } from "./src/index.js"
import { createServer } from "./src/server.js"
import { type PlaneConnection, PlaneConsumer, type PlaneFetch } from "./test/consumer.js"

const API = "http://plane.mock"
const PROJECT = "33333333-3333-4333-8333-333333333333"
const connection: PlaneConnection = {
  accessToken: "plane_api_test",
  workspaceSlug: "geviti",
  projectId: PROJECT,
}

const harness = (overrides: Partial<PlaneConnection> = {}, baseUrl = API) => {
  const runtime = createRuntime()
  const sleeps: number[] = []
  const fetchImpl: PlaneFetch = (input, init) => runtime.fetch(new Request(input, init))
  const consumer = (extra: Partial<PlaneConnection> = {}, base = baseUrl) =>
    new PlaneConsumer(base, { ...connection, ...overrides, ...extra }, fetchImpl, async (ms) => {
      sleeps.push(ms)
    })
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const journal = async (query = "") =>
    (
      (await (await runtime.fetch(new Request(`${API}/__admin/requests${query}`))).json()) as {
        requests: { operationId?: string; status: number; ids?: Record<string, string> }[]
      }
    ).requests
  return { runtime, plane: consumer(), consumer, sleeps, admin, journal }
}

describe("S25 Plane acceptance: our bug-report client against the mock", () => {
  test("the full dedup flow: states, labels, create, label merge, state patch, comment, link", async () => {
    const { plane, journal } = harness()
    const states = await plane.listStates()
    expect(states.map((s) => [s.name, s.group])).toEqual([
      ["Backlog", "backlog"],
      ["Todo", "unstarted"],
      ["In Progress", "started"],
      ["Done", "completed"],
      ["Cancelled", "cancelled"],
    ])
    expect(await plane.listLabels()).toEqual([])
    const bug = await plane.createLabel("bug")
    const auto = await plane.createLabel("auto-reported")
    await expect(plane.createLabel("bug")).rejects.toThrow(
      /^Plane POST \/api\/v1\/workspaces\/geviti\/projects\/.+\/labels\/ failed with HTTP 409: .*Label with the same name already exists/,
    )
    const todo = states.find((s) => s.name === "Todo")?.id as string
    const item = await plane.createWorkItem({
      name: "Checkout fails on Safari",
      descriptionHtml: "<p>Steps</p>",
      stateId: todo,
      labelIds: [bug.id],
    })
    expect(item).toMatchObject({
      sequenceId: 1,
      name: "Checkout fails on Safari",
      descriptionHtml: "<p>Steps</p>",
      stateId: todo,
      labelIds: [bug.id],
      expandedLabels: [],
    })
    expect(await plane.getWorkItem(item.id)).toEqual(item)
    const merged = await plane.addLabelsToWorkItem(item.id, [bug.id, auto.id])
    expect(merged.labelIds).toEqual([bug.id, auto.id])
    // Already carrying every label: our client skips the PATCH.
    const before = (await journal("?operationId=UpdateWorkItem")).length
    await plane.addLabelsToWorkItem(item.id, [auto.id])
    expect((await journal("?operationId=UpdateWorkItem")).length).toBe(before)
    const inProgress = states.find((s) => s.name === "In Progress")?.id as string
    expect((await plane.patchWorkItemState(item.id, inProgress)).stateId).toBe(inProgress)
    const comment = await plane.createComment(item.id, "<p>Seen again by 3 members</p>")
    expect(comment.commentHtml).toBe("<p>Seen again by 3 members</p>")
    const link = await plane.createWorkItemLink(item.id, {
      url: "https://admin.gogeviti.com/bug-reports/42",
      title: "Report #42",
    })
    expect(link).toMatchObject({
      url: "https://admin.gogeviti.com/bug-reports/42",
      title: "Report #42",
    })
    await expect(
      plane.createWorkItemLink(item.id, { url: "https://admin.gogeviti.com/bug-reports/42" }),
    ).rejects.toThrow(/HTTP 409: .*URL already exists for this Issue/)
    // The journal carries ids, never the comment text.
    const entries = await journal()
    expect(JSON.stringify(entries)).not.toContain("Seen again")
    expect(entries.find((e) => e.operationId === "CreateComment")?.ids?.workItemId).toBe(item.id)
  })

  test("work items page by Plane's cursor, newest first, until next_page_results is false", async () => {
    const { plane, runtime } = harness()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      runtime.clock.advance(1_000)
      ids.push((await plane.createWorkItem({ name: `Bug ${i}` })).id)
    }
    const seen: string[] = []
    const cursors: (string | null)[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await plane.listWorkItems({ perPage: 2, ...(cursor ? { cursor } : {}) })
      expect(page.totalCount).toBe(5)
      seen.push(...page.results.map((r) => r.id))
      cursors.push(page.nextCursor)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(cursors).toEqual(["2:1:0", "2:2:0", null])
    expect(seen).toEqual([...ids].reverse())
    const oldest = await plane.listWorkItems({ orderBy: "created_at" })
    expect(oldest.results.map((r) => r.id)).toEqual(ids)
    expect(oldest.results.map((r) => r.sequenceId)).toEqual([1, 2, 3, 4, 5])
  })

  test("listAll walks every page of labels (per_page 100)", async () => {
    const { plane } = harness()
    for (let i = 0; i < 205; i++) await plane.createLabel(`label-${i}`)
    const labels = await plane.listLabels()
    expect(labels).toHaveLength(205)
    expect(new Set(labels.map((l) => l.name)).size).toBe(205)
  })

  test("GETs retry 429 / 5xx / network failures at 0, 2 and 8 s; writes are never retried", async () => {
    for (const preset of ["rate_limited", "server_error", "bad_gateway", "network_drop"]) {
      const { runtime } = harness()
      const sleeps: number[] = []
      const fetchImpl: PlaneFetch = (input, init) => runtime.fetch(new Request(input, init))
      const plane = new PlaneConsumer(API, connection, fetchImpl, async (ms) => {
        sleeps.push(ms)
      })
      runtime.applyPreset(preset, "default", { count: 2 })
      expect(await plane.listStates()).toHaveLength(5)
      expect(sleeps).toEqual([2_000, 8_000])
      expect(plane.http.warnings).toHaveLength(2)
      runtime.applyPreset(preset, "default", { count: 3 })
      await expect(plane.listStates()).rejects.toThrow(
        preset === "network_drop"
          ? /^Plane GET .*\/states\/ failed after retries: /
          : /^Plane GET .*\/states\/ failed with HTTP (429|500|502) after retries$/,
      )
      runtime.applyPreset(preset, "default", { count: 1 })
      await expect(plane.createLabel("once")).rejects.toThrow(
        preset === "network_drop"
          ? /^Plane POST .*\/labels\/ failed: /
          : /^Plane POST .*\/labels\/ failed with HTTP (429|500|502)$/,
      )
      // The write was not retried: the next call goes through and creates the label once.
      expect((await plane.createLabel("once")).name).toBe("once")
    }
  })

  test("the real 60-per-minute limit: the 61st request is throttled until the minute rolls over", async () => {
    const { plane, admin, runtime } = harness()
    await admin("/settings", { rateLimitPerMinute: 60 }, "PUT")
    runtime.clock.set(Date.parse("2026-09-20T00:00:00.000Z"))
    for (let i = 0; i < 60; i++) await plane.createLabel(`l${i}`)
    await expect(plane.createLabel("over")).rejects.toThrow(/HTTP 429/)
    runtime.clock.advance(60_000)
    expect((await plane.createLabel("over")).name).toBe("over")
  })

  test("client-visible failures: 401 detail, invalid JSON, pagination without or with repeated cursors", async () => {
    const cases: [string, RegExp][] = [
      ["unauthorized", /failed with HTTP 401: \{"detail":"Given API token is not valid"\}$/],
      ["invalid_json", /returned invalid JSON: /],
      ["pagination_missing_cursor", /pagination indicated another page without a cursor/],
      ["pagination_repeated_cursor", /pagination repeated cursor/],
    ]
    for (const [preset, message] of cases) {
      const { runtime, plane } = harness()
      runtime.applyPreset(preset, "default", preset.startsWith("pagination") ? {} : { count: 1 })
      await expect(plane.listStates()).rejects.toThrow(message)
    }
    const { runtime, plane } = harness()
    runtime.applyPreset("pagination_missing_cursor", "default", { count: 1 })
    await expect(plane.listWorkItems()).rejects.toThrow(
      "Plane work-item pagination indicated another page without a cursor",
    )
  })

  test("validation and lookups answer Plane's shapes (DRF 400, 404, 401 without a key)", async () => {
    const { plane, runtime } = harness()
    await expect(
      plane.createWorkItem({ name: "x", stateId: "44444444-4444-4444-8444-444444444444" }),
    ).rejects.toThrow(
      /HTTP 400: \{"state":\["Invalid pk \\"44444444-4444-4444-8444-444444444444\\" - object does not exist."\]\}/,
    )
    await expect(plane.getWorkItem("44444444-4444-4444-8444-444444444444")).rejects.toThrow(
      /HTTP 404: \{"error":"The requested resource does not exist."\}/,
    )
    const raw = await runtime.fetch(
      new Request(`${API}/api/v1/workspaces/geviti/projects/${PROJECT}/work-items/`, {
        method: "POST",
        headers: { "x-api-key": "k", "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(raw.status).toBe(400)
    expect(await raw.json()).toEqual({ name: ["This field is required."] })
    const anonymous = await runtime.fetch(
      new Request(`${API}/api/v1/workspaces/geviti/projects/${PROJECT}/states/`),
    )
    expect(anonymous.status).toBe(401)
  })

  test("an admin state move (e.g. Done) is what the resolution watcher reads back", async () => {
    const { plane, admin } = harness()
    const item = await plane.createWorkItem({ name: "Fixed soon" })
    const moved = await admin(`/work-items/${item.id}/state`, { state: "Done" })
    expect(moved.status).toBe(200)
    expect(((await moved.json()) as { completed_at: string | null }).completed_at).not.toBeNull()
    const states = await plane.listStates()
    const reread = await plane.getWorkItem(item.id)
    expect(states.find((s) => s.id === reread.stateId)?.group).toBe("completed")
  })

  test("pinned projects: an unknown workspace/project is a 404", async () => {
    const { plane, admin, consumer } = harness()
    await admin("/settings", { projects: [`geviti/${PROJECT}`] }, "PUT")
    expect(await plane.listStates()).toHaveLength(5)
    await expect(
      consumer({ projectId: "55555555-5555-4555-8555-555555555555" }).listStates(),
    ).rejects.toThrow(/HTTP 404/)
  })

  test("namespaces by API key, by header and by /ns/ prefix isolate workers", async () => {
    const { runtime, consumer, admin } = harness()
    await admin("/credentials", { credentials: { key_a: "a", key_b: "b" } }, "PUT")
    await consumer({ accessToken: "key_a" }).createWorkItem({ name: "only in a" })
    expect((await consumer({ accessToken: "key_a" }).listWorkItems()).totalCount).toBe(1)
    expect((await consumer({ accessToken: "key_b" }).listWorkItems()).totalCount).toBe(0)
    expect(
      (await consumer({ accessToken: "other" }, `${API}/ns/a`).listWorkItems()).totalCount,
    ).toBe(1)
    const viaHeader = await runtime.fetch(
      new Request(`${API}/api/v1/workspaces/geviti/projects/${PROJECT}/work-items/`, {
        headers: { "x-api-key": "other", "x-mockingbird-namespace": "a" },
      }),
    )
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/^plane@.*; ns=a$/)
    expect(((await viaHeader.json()) as { total_count: number }).total_count).toBe(1)
    expect(Object.keys(PLANE_PRESETS)).toEqual(
      expect.arrayContaining(["rate_limited", "server_error", "bad_gateway", "network_drop"]),
    )
  })
})

describe("served over HTTP", () => {
  test("our client works against the node server with plain fetch", async () => {
    const server = await createServer()
    try {
      const plane = new PlaneConsumer(server.url, connection, (input, init) => fetch(input, init))
      const item = await plane.createWorkItem({ name: "Over HTTP" })
      expect((await plane.getWorkItem(item.id)).name).toBe("Over HTTP")
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^plane@/)
    } finally {
      await server.close()
    }
  })
})
