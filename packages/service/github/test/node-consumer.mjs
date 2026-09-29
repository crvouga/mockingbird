import assert from "node:assert/strict"
import { Agent, request } from "node:http"
import { createServer } from "../dist/server.js"

// The import owns server lifecycle only. Fixture setup and consumer behavior use
// literal HTTP contracts, with no handler/state/response-builder imports.
const server = await createServer()
const agent = new Agent({ keepAlive: true })
const call = (method, path, body) =>
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
          "x-mockingbird-namespace": "consumer",
          "X-GitHub-Api-Version": "2026-03-10",
          "Idempotency-Key": "same-consumer-operation",
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
    req.setTimeout(2000, () => req.destroy(new Error("consumer timeout")))
    req.end(bytes)
  })
const checked = async (method, path, body, status = 200) => {
  const response = await call(method, path, body)
  assert.equal(response.status, status, `${method} ${path}`)
  return response
}
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40),
  d = "d".repeat(40)
const root = "/repos/synthetic-org/example"
const pr = { title: "Synthetic consumer PR", head: "topic", base: "main" }
const configure = (preset) => checked("POST", "/__admin/faults", { preset }, 201)
try {
  await checked(
    "POST",
    "/__admin/github/repositories",
    {
      owner: "synthetic-org",
      name: "example",
      commits: [
        { sha: a, parents: [] },
        { sha: b, parents: [a] },
        { sha: c, parents: [b] },
        { sha: d, parents: [a] },
      ],
      branches: {
        main: a,
        topic: b,
        other: c,
        third: d,
        fourth: b,
        ...Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`page-${i}`, b])),
      },
    },
    201,
  )
  await configure("github_pr_create_accepted_drop")
  await assert.rejects(call("POST", `${root}/pulls`, pr), { code: "ECONNRESET" })
  const found = await checked("GET", `${root}/pulls?head=synthetic-org:topic&base=main`)
  assert.equal(found.body.length, 1)
  const number = found.body[0].number
  assert.equal((await checked("GET", `${root}/pulls/${number}`)).body.head.sha, b)
  const duplicate = await checked("POST", `${root}/pulls`, pr, 422)
  assert.equal(duplicate.body.errors[0].resource, "PullRequest")
  assert.equal(duplicate.body.errors[0].code, "custom")
  // Same idempotency header does not prevent a distinct head from creating a PR.
  const second = await checked("POST", `${root}/pulls`, { ...pr, head: "other" }, 201)
  assert.notEqual(second.body.number, number)
  await checked("POST", `${root}/pulls`, { ...pr, head: "third" }, 201)

  for (let i = 0; i < 28; i++)
    await checked("POST", `${root}/pulls`, { ...pr, head: `page-${i}` }, 201)
  const numbers = []
  let path = `${root}/pulls?base=main&direction=asc`
  while (path) {
    const response = await checked("GET", path)
    numbers.push(...response.body.map((pull) => pull.number))
    const next = /<([^>]+)>; rel="next"/.exec(response.headers.link ?? "")?.[1]
    if (next) {
      const url = new URL(next)
      assert.equal(url.origin, server.url)
      assert.equal(url.searchParams.get("base"), "main")
      assert.match(url.pathname, /^\/ns\/consumer\//)
      path = url.pathname + url.search
    } else path = undefined
  }
  assert.equal(numbers.length, 31)
  assert.equal(new Set(numbers).size, 31)
  assert.deepEqual(
    numbers,
    Array.from({ length: 31 }, (_, i) => i + 1),
  )

  const old = (await checked("GET", `${root}/git/ref/heads/main`)).body.object.sha
  await checked("POST", "/__admin/github/refs/move", {
    owner: "synthetic-org",
    repo: "example",
    ref: "refs/heads/main",
    sha: b,
  })
  await checked("PATCH", `${root}/git/refs/heads/main`, { sha: d, expected_sha: old }, 422)
  assert.equal((await checked("GET", `${root}/git/ref/heads/main`)).body.object.sha, b)
  // A stale expected_sha does not block a real fast-forward: it is no REST lease.
  await checked("PATCH", `${root}/git/refs/heads/main`, { sha: c, expected_sha: old })
  assert.equal((await checked("GET", `${root}/git/ref/heads/main`)).body.object.sha, c)

  // Test the consumer scheduler with logical time, avoiding a real60second delay.
  let logicalNow = 0
  const waits = []
  const sleep = async (milliseconds) => {
    waits.push(milliseconds)
    logicalNow += milliseconds
  }
  const retry = async (action) => {
    const first = await action()
    if (first.status !== 429) return first
    const seconds = Number(first.headers["retry-after"])
    assert.ok(Number.isFinite(seconds) && seconds >= 0)
    const deadline = logicalNow + seconds * 1000
    await sleep(seconds * 1000)
    assert.ok(logicalNow >= deadline)
    return action()
  }
  await configure("github_rate_limited")
  let attempts = 0
  const edited = await retry(() => {
    attempts++
    return call("PATCH", `${root}/pulls/${number}`, { title: "Retried edit" })
  })
  assert.equal(edited.status, 200)
  assert.equal(edited.body.title, "Retried edit")
  assert.equal(attempts, 2)
  assert.deepEqual(waits, [60000])
  assert.equal((await checked("GET", `${root}/pulls/${number}`)).body.title, "Retried edit")
  console.log(
    "native HTTP: lost PR response, duplicates, pagination, ref movement and retry-after passed",
  )
} finally {
  agent.destroy()
  await server.close()
}
