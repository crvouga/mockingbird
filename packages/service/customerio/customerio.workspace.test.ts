import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

/**
 * Workspace reads and customer exports (#759). Best guess from Customer.io's App API reference
 * (https://docs.customer.io/integrations/api/app/), not oracle-verified: no parity keys.
 */
const harness = () => {
  const runtime = createRuntime()
  runtime.clock.freeze()
  const call = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    headers: Record<string, string> = { authorization: "Bearer fixture-key" },
  ) =>
    runtime.fetch(
      new Request(`http://mock.test${path}`, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const read = async (path: string) => {
    const response = await call(path)
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const content = (body: unknown) => call("/__admin/content", body, "PUT")
  return { runtime, call, read, content }
}

const LISTS = [
  ["/v1/reporting_webhooks", "reporting_webhooks"],
  ["/v1/subscription_topics", "topics"],
  ["/v1/snippets", "snippets"],
  ["/v1/campaigns", "campaigns"],
  ["/v1/newsletters", "newsletters"],
  ["/v1/sender_identities", "sender_identities"],
] as const

describe("workspace reads (#759, best guess)", () => {
  for (const [path, key] of LISTS) {
    test(`GET ${path} answers {${key}: []} for an empty workspace`, async () => {
      const { read } = harness()
      expect(await read(path)).toEqual({ status: 200, body: { [key]: [] } })
    })

    test(`GET ${path} needs the App API bearer key`, async () => {
      const { call } = harness()
      const response = await call(path, undefined, "GET", {})
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ meta: { error: "Unauthorized request" } })
    })
  }

  test("PUT /__admin/content seeds every list, which the App API reads back", async () => {
    const { read, content } = harness()
    const seeded = {
      reporting_webhooks: [
        { name: "backend", endpoint: "https://backend.example/hook", events: ["email_sent"] },
      ],
      topics: [{ identifier: "topic_1", name: "Product Updates", subscribed_by_default: true }],
      snippets: [{ name: "footer", value: "<p>Bye</p>" }],
      campaigns: [{ name: "Welcome", type: "event", state: "running", active: true }],
      newsletters: [{ name: "October digest", type: "email", send_state: "sent" }],
      sender_identities: [{ name: "Acme", email: "hello@acme.example", template_type: "email" }],
    }
    const response = await content(seeded)
    expect(response.status).toBe(200)
    expect((await read("/v1/reporting_webhooks")).body).toEqual({
      reporting_webhooks: [
        {
          id: 1,
          name: "backend",
          endpoint: "https://backend.example/hook",
          events: ["email_sent"],
          type: "webhook",
          disabled: false,
          full_resolution: true,
          with_content: false,
        },
      ],
    })
    expect((await read("/v1/subscription_topics")).body).toEqual({
      topics: [
        { id: 1, identifier: "topic_1", name: "Product Updates", subscribed_by_default: true },
      ],
    })
    expect((await read("/v1/snippets")).body).toMatchObject({
      snippets: [{ name: "footer", value: "<p>Bye</p>" }],
    })
    expect((await read("/v1/campaigns")).body).toMatchObject({
      campaigns: [{ id: 1, name: "Welcome", type: "event", state: "running" }],
    })
    expect((await read("/v1/newsletters")).body).toMatchObject({
      newsletters: [{ id: 1, name: "October digest", send_state: "sent" }],
    })
    expect((await read("/v1/sender_identities")).body).toMatchObject({
      sender_identities: [{ id: 1, name: "Acme", email: "hello@acme.example" }],
    })
  })

  test("PUT /__admin/content refuses a reporting webhook without name, endpoint and events", async () => {
    const { content, read } = harness()
    const response = await content({ reporting_webhooks: [{ name: "x" }] })
    expect(response.status).toBe(400)
    expect((await read("/v1/reporting_webhooks")).body).toEqual({ reporting_webhooks: [] })
  })

  test("newsletters page with limit and start, newest first with sort=desc", async () => {
    const { read, content } = harness()
    await content({ newsletters: [1, 2, 3].map((n) => ({ name: `n${n}` })) })
    const first = await read("/v1/newsletters?limit=2")
    expect((first.body.newsletters as { name: string }[]).map((n) => n.name)).toEqual(["n1", "n2"])
    expect(typeof first.body.next).toBe("string")
    const second = await read(`/v1/newsletters?limit=2&start=${first.body.next}`)
    expect(second.body).toMatchObject({ newsletters: [{ name: "n3" }] })
    expect(second.body.next).toBeUndefined()
    const desc = await read("/v1/newsletters?sort=desc")
    expect((desc.body.newsletters as { name: string }[]).map((n) => n.name)).toEqual([
      "n3",
      "n2",
      "n1",
    ])
    expect((await read("/v1/newsletters?start=garbage")).status).toBe(400)
  })

  test("sender identities omit hidden senders unless hidden=true", async () => {
    const { read, content } = harness()
    await content({
      sender_identities: [
        { name: "Shown", email: "a@acme.example" },
        { name: "Hidden", email: "b@acme.example", hidden: true },
      ],
    })
    const names = async (path: string) =>
      ((await read(path)).body.sender_identities as { name: string }[]).map((s) => s.name)
    expect(await names("/v1/sender_identities")).toEqual(["Shown"])
    expect(await names("/v1/sender_identities?hidden=true")).toEqual(["Shown", "Hidden"])
  })
})

describe("customer exports (#759, best guess)", () => {
  const seedPeople = async (call: ReturnType<typeof harness>["call"]) => {
    await call("/__admin/profiles/p1", { traits: { plan: "pro", email: "a@x.example" } }, "PUT")
    await call("/__admin/profiles/p2", { traits: { plan: "free" } }, "PUT")
    await call("/__admin/profiles/p3", { traits: { plan: "pro" } }, "PUT")
  }

  test("POST /v1/exports/customers creates a done export counting the matching people", async () => {
    const { call } = harness()
    await seedPeople(call)
    const response = await call("/v1/exports/customers", {
      filters: { and: [{ attribute: { field: "plan", operator: "eq", value: "pro" } }] },
      attributes: ["plan"],
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { export: Record<string, unknown> }
    expect(body.export).toMatchObject({
      id: 1,
      type: "customers",
      status: "done",
      failed: false,
      total: 2,
      downloads: 0,
    })
    expect(typeof body.export.created_at).toBe("number")
  })

  test("GET /v1/exports/{id} reads the export; an unknown id is 404", async () => {
    const { call, read } = harness()
    await seedPeople(call)
    await call("/v1/exports/customers", {
      filters: { attribute: { field: "plan", operator: "exists" } },
    })
    expect(await read("/v1/exports/1")).toMatchObject({
      status: 200,
      body: { export: { id: 1, status: "done", total: 3 } },
    })
    expect(await read("/v1/exports/999")).toEqual({
      status: 404,
      body: { meta: { error: "not found" } },
    })
    expect((await read("/v1/exports/999/download")).status).toBe(404)
  })

  test("download returns a URL the emulator serves as CSV, counting downloads", async () => {
    const { call, read, runtime } = harness()
    await seedPeople(call)
    await call("/v1/exports/customers", {
      filters: { not: { attribute: { field: "plan", operator: "eq", value: "free" } } },
      attributes: ["plan"],
    })
    const link = await read("/v1/exports/1/download")
    expect(link.status).toBe(200)
    const url = link.body.url as string
    expect(url).toStartWith("http://mock.test/")
    const file = await runtime.fetch(new Request(url))
    expect(file.status).toBe(200)
    expect(file.headers.get("content-type")).toContain("text/csv")
    const lines = (await file.text()).trim().split("\n")
    expect(lines[0]).toBe("id,cio_id,email,plan")
    expect(lines.slice(1).map((line) => line.split(",")[0])).toEqual(["p1", "p3"])
    expect(await read("/v1/exports/1")).toMatchObject({ body: { export: { downloads: 1 } } })
  })

  test("the download URL routes back to the export's namespace", async () => {
    const { call, runtime } = harness()
    const ns = { authorization: "Bearer fixture-key", "x-mockingbird-namespace": "team-a" }
    await call("/__admin/profiles/p1", { traits: { plan: "pro" } }, "PUT", ns)
    await call(
      "/v1/exports/customers",
      { filters: { attribute: { field: "plan", operator: "exists" } } },
      "POST",
      ns,
    )
    const link = (await (await call("/v1/exports/1/download", undefined, "GET", ns)).json()) as {
      url: string
    }
    const file = await runtime.fetch(new Request(link.url))
    expect(file.status).toBe(200)
    expect((await file.text()).trim().split("\n")).toEqual([
      "id,cio_id,email",
      expect.stringMatching(/^p1,/),
    ])
  })

  test("a missing or malformed filter is 400 and creates no export", async () => {
    const { call, read } = harness()
    expect((await call("/v1/exports/customers", {})).status).toBe(400)
    expect(
      (
        await call("/v1/exports/customers", {
          filters: { attribute: { field: "x", operator: "gt" } },
        })
      ).status,
    ).toBe(400)
    expect((await read("/v1/exports/1")).status).toBe(404)
  })

  test("segment filters are an explicit emulator limitation (400), not an empty export", async () => {
    const { call, read } = harness()
    const response = await call("/v1/exports/customers", { filters: { segment: { id: 4 } } })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      meta: { error: "filters: segment filters are not supported by the emulator" },
    })
    expect((await read("/v1/exports/1")).status).toBe(404)
  })

  test("exports need the App API bearer key", async () => {
    const { call } = harness()
    const response = await call("/v1/exports/customers", { filters: {} }, "POST", {})
    expect(response.status).toBe(401)
  })
})
