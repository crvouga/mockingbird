import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { createServer } from "./src/server.js"
import { WearablesConsumer } from "./test/consumer.js"

const origin = "http://wearables.mock"
const harness = () => {
  const runtime = createRuntime()
  const client = new WearablesConsumer(origin, "open_wearables_test", ((input, init) =>
    runtime.fetch(new Request(input, init))) as typeof fetch)
  return { runtime, client, request: client.request.bind(client) }
}
test("public provider filtering, users, connections, sync completion and revocation", async () => {
  const { runtime, request } = harness()
  const cloud = await (
    await request("/api/v1/oauth/providers?cloud_only=true&enabled_only=true")
  ).json()
  expect(cloud.map((p: { provider: string }) => p.provider)).not.toContain("apple")
  expect(await (await request("/api/v1/oauth/providers")).json()).toHaveLength(7)
  const userResponse = await request("/api/v1/users", {
    external_user_id: "fixture-1",
    email: "fixture@example.test",
  })
  expect(userResponse.status).toBe(201)
  const user = await userResponse.json()
  expect(user.id).toMatch(/^[a-f0-9-]{36}$/)
  expect((await request("/api/v1/users", { external_user_id: "fixture-1" })).status).toBe(409)
  const connections = `/api/v1/users/${user.id}/connections`
  expect(await (await request(connections)).json()).toEqual([])
  expect((await request("/api/v1/users/missing/connections")).status).toBe(404)
  await request(`/__admin/users/${user.id}/connections`, { provider: "garmin" })
  const sync = `/api/v1/providers/garmin/users/${user.id}/sync`
  const queued = await (await request(`${sync}?data_type=all`, {})).json()
  expect(queued.success).toBe(true)
  expect(runtime.instance().state.tasks.get(queued.task_id)?.status).toBe("pending")
  await request(`/__admin/tasks/${queued.task_id}/complete`, {})
  expect((await (await request(connections)).json())[0].last_synced_at).toBeString()
  expect((await request(`${connections}/garmin`, undefined, "DELETE")).status).toBe(204)
  expect((await (await request(connections)).json())[0].status).toBe("revoked")
  expect((await request(sync, {})).status).toBe(409)
  await request("/__admin/providers/garmin", { is_enabled: false }, "PUT")
  expect(
    (await (await request("/api/v1/oauth/providers?enabled_only=true")).json()).map(
      (p: { provider: string }) => p.provider,
    ),
  ).not.toContain("garmin")
  expect((await request(`/api/v1/providers/unknown/users/${user.id}/sync`, {})).status).toBe(422)
  await runtime.reset()
  expect((await request(`/api/v1/users/${user.id}`)).status).toBe(404)
})
test("deployment extensions reject explicitly without state changes", async () => {
  const { runtime, request } = harness()
  const before = runtime.instance().state.users.list()
  for (const [path, method] of [
    ["/api/v1/sdk/users", "POST"],
    ["/api/v1/sdk/users/id/sync/apple/healthion", "POST"],
    ["/api/v1/providers/apple/users/id/register", "POST"],
    ["/api/v1/providers/apple/users/id/deregister", "DELETE"],
    ["/api/v1/providers/apple/users/id/sync/task/receipt", "GET"],
  ] as const) {
    const response = await request(path, method === "POST" ? {} : undefined, method)
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ detail: { code: "mockingbird_unsupported" } })
  }
  expect(runtime.instance().state.users.list()).toEqual(before)
  expect(runtime.instance().state.connections.list()).toEqual([])
  expect(runtime.instance().state.tasks.list()).toEqual([])
})
test("strict authentication, namespaces, clock-driven task completion and standard faults", async () => {
  const { runtime, request } = harness()
  expect((await runtime.fetch(new Request(`${origin}/api/v1/oauth/providers`))).status).toBe(401)
  expect(
    (
      await runtime.fetch(
        new Request(`${origin}/api/v1/oauth/providers`, {
          headers: { "X-Open-Wearables-API-Key": "wrong" },
        }),
      )
    ).status,
  ).toBe(401)
  const user = await (await request("/api/v1/users", { external_user_id: "clock-user" })).json()
  await request(`/__admin/users/${user.id}/connections`, { provider: "oura" })
  await request("/__admin/settings", { autoCompleteAfterMs: 100 }, "PUT")
  const task = await (await request(`/api/v1/providers/oura/users/${user.id}/sync`, {})).json()
  runtime.clock.advance(100)
  await request("/api/v1/oauth/providers")
  expect(runtime.instance().state.tasks.get(task.task_id)?.status).toBe("completed")
  expect(runtime.instance("other").state.users.list()).toEqual([])
  await request("/__admin/faults", { preset: "unavailable", count: 1 })
  expect((await request("/api/v1/oauth/providers")).status).toBe(503)
})
test("served over HTTP with the raw-fetch consumer", async () => {
  const server = await createServer()
  try {
    const client = new WearablesConsumer(server.url, "open_wearables_test")
    expect((await client.request("/api/v1/oauth/providers")).status).toBe(200)
  } finally {
    await server.close()
  }
})
