import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"

const origin = "http://plane.mock"
const base = "/api/v1/workspaces/acme/projects/33333333-3333-4333-8333-333333333333/work-items/"
const harness = () => {
  const runtime = createRuntime({ settings: { apiKeys: ["plane_test"] } })
  const call = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    key = "plane_test",
  ) =>
    runtime.fetch(
      new Request(origin + path, {
        method,
        headers: { "X-API-Key": key, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, call }
}

test("external identity lookup, conflict atomicity, partial fields and project scope", async () => {
  const { runtime, call } = harness()
  const pair = { external_source: "test-app", external_id: "report-1" }
  const lookup = `${base}?external_source=test-app&external_id=report-1`
  expect(await (await call(lookup)).json()).toEqual({
    error: "The requested resource does not exist.",
  })
  const item = await (await call(base, { name: "Bug", ...pair })).json()
  expect(item).toMatchObject({ ...pair, sequence_id: 1 })
  expect(await (await call(lookup)).json()).toEqual(item)
  const duplicate = await call(base, { name: "Duplicate", ...pair })
  expect(duplicate.status).toBe(409)
  expect(await duplicate.json()).toMatchObject({ id: item.id })
  const other = await (await call(base, { name: "Other", external_id: "report-1" })).json()
  expect(other.sequence_id).toBe(2)
  expect((await call(base, { name: "Again", external_id: "report-1" })).status).toBe(201)
  expect((await call(`${base + other.id}/`, { external_source: "test-app" }, "PATCH")).status).toBe(
    409,
  )
  expect((await (await call(`${base + other.id}/`)).json()).external_source).toBeNull()
  expect(
    (await call(base, { name: "Different source", ...pair, external_source: "other" })).status,
  ).toBe(201)
  expect(
    (await call(base.replace("33333333", "44444444"), { name: "Other project", ...pair })).status,
  ).toBe(201)
  expect((await (await call(`${base}?external_id=report-1`)).json()).results).toHaveLength(4)
  const api = runtime.instance()
  api.state.items.insert("seeded-duplicate", { ...item, id: "seeded-duplicate" })
  expect((await call(lookup)).status).toBe(500)
})

test("attachments require slot, ordered multipart upload and confirmation; admin exposes hash", async () => {
  const { runtime, call } = harness()
  const item = await (await call(base, { name: "Screenshot" })).json()
  const path = `${base + item.id}/attachments/`
  const slot = await (
    await call(path, { name: "screenshot.png", type: "image/png", size: 10 })
  ).json()
  expect(slot.upload_data.url).toBe(`${origin}/__admin/blobs/plane/uploads?namespace=default`)
  expect(await (await call(path)).json()).toEqual([])
  expect((await call(`${path + slot.asset_id}/`, { is_uploaded: true }, "PATCH")).status).toBe(400)
  const upload = (mode = "valid") => {
    const form = new FormData()
    if (mode === "early") form.append("file", new Blob(["screenshot"]))
    for (const [key, value] of Object.entries(slot.upload_data.fields)) {
      if (mode === "missing" && key === "policy") continue
      form.append(key, mode === "wrong" && key === "key" ? "wrong-key" : String(value))
    }
    if (mode !== "early") form.append("file", new Blob(["screenshot"]))
    return runtime.fetch(new Request(slot.upload_data.url, { method: "POST", body: form }))
  }
  for (const mode of ["missing", "wrong", "early"]) expect((await upload(mode)).status).toBe(403)
  expect((await upload()).status).toBe(204)
  expect(await (await call(path)).json()).toEqual([])
  expect((await call(`${path + slot.asset_id}/`, { is_uploaded: true }, "PATCH")).status).toBe(204)
  expect(await (await call(path)).json()).toEqual([
    expect.objectContaining({
      id: slot.asset_id,
      attributes: { name: "screenshot.png", type: "image/png", size: 10 },
      is_uploaded: true,
    }),
  ])
  const admin = await (await call(`/__admin/work-items/${item.id}/attachments`)).json()
  expect(admin[0]).toMatchObject({
    byte_length: 10,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  for (const body of [
    { type: "image/png", size: 10 },
    { name: "a", type: "image/png" },
    { name: "a", type: "invalid", size: 10 },
  ])
    expect((await call(path, body)).status).toBe(400)
  expect(
    (await call(path, { name: "a", type: "image/png", size: 1 }, "POST", "wrong")).status,
  ).toBe(401)
  expect((await call(`${base}missing/attachments/`)).status).toBe(404)
  expect((await call(`${path}missing/`, { is_uploaded: true }, "PATCH")).status).toBe(404)
  await runtime.reset()
  expect(runtime.instance().attachmentsOf(item.id)).toEqual([])
})

test("attachment namespace URLs survive a custom admin prefix; faults leave no false confirmation", async () => {
  const runtime = createRuntime({ adminPrefix: "/_control", adminKey: "admin-test" })
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          "X-API-Key": "plane_test",
          "x-mockingbird-namespace": "worker",
          "x-mockingbird-admin-key": "admin-test",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const item = await (await request(base, { name: "Namespaced" })).json()
  const path = `${base}${item.id}/attachments/`
  const slotBody = { name: "a.png", type: "image/png", size: 3 }
  await request("/_control/faults", { preset: "attachment_slot_malformed", count: 1 })
  expect(await (await request(path, slotBody)).json()).not.toHaveProperty("upload_data")
  const slot = await (await request(path, slotBody)).json()
  expect(slot.upload_data.url).toContain("/_control/blobs/plane/uploads?namespace=worker")
  const upload = () => {
    const form = new FormData()
    for (const [key, value] of Object.entries(slot.upload_data.fields))
      form.append(key, String(value))
    form.append("file", new Blob(["abc"]))
    return runtime.fetch(new Request(slot.upload_data.url, { method: "POST", body: form }))
  }
  await request("/_control/faults", { preset: "attachment_upload_denied", count: 1 })
  expect((await upload()).status).toBe(403)
  expect(
    runtime
      .instance("worker")
      .attachmentsOf(item.id)
      .find((a) => a.id === slot.asset_id)?.bytes,
  ).toBeNull()
  expect((await upload()).status).toBe(204)
  await request("/_control/faults", { preset: "attachment_confirm_failed", count: 1 })
  expect((await request(`${path}${slot.asset_id}/`, { is_uploaded: true }, "PATCH")).status).toBe(
    500,
  )
  expect(await (await request(path)).json()).toEqual([])
  expect((await request(`${path}${slot.asset_id}/`, { is_uploaded: true }, "PATCH")).status).toBe(
    204,
  )
  expect(runtime.instance().attachmentsOf(item.id)).toEqual([])
  expect(
    runtime
      .instance("worker")
      .attachmentsOf(item.id)
      .find((a) => a.id === slot.asset_id)?.sha256,
  ).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})
