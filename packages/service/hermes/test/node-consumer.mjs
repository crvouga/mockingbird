import assert from "node:assert/strict"
import { Agent, request } from "node:http"
import { createServer } from "../dist/server.js"

// Server import owns fixture setup only. The consumer uses Node HTTP and literal
// public contracts, never provider state, response builders or consumer policy.
const server = await createServer()
const agent = new Agent({ keepAlive: true })
const call = (method, path, body, key = "", deadline = 2000) =>
  new Promise((resolve, reject) => {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
    const req = request(
      {
        host: server.host,
        port: server.port,
        method,
        path,
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": bytes.length,
          "Idempotency-Key": key,
        },
      },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.once("error", reject)
        res.once("aborted", () => reject(new Error("response aborted")))
        res.once("end", () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            })
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.once("error", reject)
    req.setTimeout(deadline, () =>
      req.destroy(Object.assign(new Error("consumer deadline"), { code: "CLIENT_TIMEOUT" })),
    )
    req.end(bytes)
  })
const checked = async (method, path, body, key = "", status = 200) => {
  const response = await call(method, path, body, key)
  assert.equal(response.status, status, `${method} ${path}`)
  return response.body
}
const submit = (key) => checked("POST", "/v1/runs", { input: "synthetic consumer input" }, key, 202)
try {
  await checked("POST", "/__admin/clock", { set: 1700000000000, freeze: true })
  await checked("POST", "/__admin/faults", { preset: "hermes_submit_accepted_drop" }, "", 201)
  await assert.rejects(
    call("POST", "/v1/runs", { input: "synthetic consumer input" }, "delivery"),
    { code: "ECONNRESET" },
  )
  const replay = await call("POST", "/v1/runs", { input: "synthetic consumer input" }, "delivery")
  assert.equal(replay.status, 202)
  assert.equal(replay.headers["idempotency-replayed"], "true")
  assert.equal(replay.body.replayed, true)
  const id = replay.body.run_id
  assert.match(id, /^run_[a-f0-9]{32}$/)
  assert.equal((await checked("GET", `/v1/runs/${id}`)).status, "queued")
  assert.deepEqual(await checked("POST", `/v1/runs/${id}/stop`, {}), {
    run_id: id,
    status: "stopping",
  })
  await checked("POST", `/__admin/hermes/runs/${id}/observe`, { status: "cancelled" })
  assert.equal((await checked("GET", `/v1/runs/${id}`)).status, "cancelled")
  assert.deepEqual(await submit("delivery"), { run_id: id, status: "cancelled", replayed: true })
  await checked("POST", "/__admin/faults", { preset: "hermes_poll_timeout" }, "", 201)
  await assert.rejects(call("GET", `/v1/runs/${id}`, undefined, "", 30), { code: "CLIENT_TIMEOUT" })
  assert.equal((await checked("GET", `/v1/runs/${id}`)).status, "cancelled")
  await checked("POST", "/__admin/clock", { advance: 86400001 })
  await submit("prune-trigger")
  await checked("POST", "/__admin/hermes/sweep", {})
  const missing = await checked("GET", `/v1/runs/${id}`, undefined, "", 404)
  assert.equal(missing.error.code, "run_not_found")
  const replacement = await submit("delivery")
  assert.equal(replacement.replayed, false)
  assert.notEqual(replacement.run_id, id)
  console.log("native HTTP: response loss, replay, poll, stop, timeout and expiry passed")
} finally {
  agent.destroy()
  await server.close()
}
