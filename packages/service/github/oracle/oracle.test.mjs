import assert from "node:assert/strict"
import { test } from "node:test"
import { digest, operations, preparePlan, validateExecution } from "./plan.mjs"

const input = {
  repository: "synthetic-org/disposable",
  runId: "12345678-1234-4234-9234-123456789abc",
  apiVersion: "2026-03-10",
  comparedOperations: operations,
}
const grants = (plan) => ({
  confirmedDigest: digest(plan),
  writes: true,
  notifications: true,
  cleanup: true,
  token: "synthetic-test-token",
})
test("plan constrains repository, version, operation subset and unique owned branches", () => {
  const plan = preparePlan(input)
  assert.notEqual(plan.branches.head, plan.branches.base)
  assert.ok(plan.branches.head.startsWith("mockingbird-oracle/"))
  assert.deepEqual(plan.limits, {
    trees: 2,
    commits: 2,
    branches: 2,
    pullRequests: 1,
    requests: 48,
  })
  for (const change of [
    { repository: "owner/repo/../other" },
    { repository: "https://elsewhere/repo" },
    { runId: "main" },
    { apiVersion: "2022-11-28" },
    { comparedOperations: ["repos/get"] },
  ])
    assert.throws(() => preparePlan({ ...input, ...change }))
})
test("execution requires exact unchanged plan and all grants before credential use", () => {
  const plan = preparePlan(input)
  assert.doesNotThrow(() => validateExecution(plan, grants(plan)))
  for (const key of ["writes", "notifications", "cleanup"])
    assert.throws(() => validateExecution(plan, { ...grants(plan), [key]: false }), /approvals/)
  assert.throws(
    () => validateExecution(plan, { ...grants(plan), confirmedDigest: "changed" }),
    /approvals/,
  )
  assert.throws(
    () =>
      validateExecution({ ...plan, branches: { ...plan.branches, head: "main" } }, grants(plan)),
    /bounded scope/,
  )
  assert.throws(
    () => validateExecution(plan, { ...grants(plan), token: "" }),
    /Missing credential key: MOCKINGBIRD_GITHUB_TOKEN/,
  )
})

import { executeOracle } from "./execute.mjs"

test("missing execution authorization prevents all network activity", async () => {
  const plan = preparePlan(input)
  let calls = 0
  await assert.rejects(
    executeOracle(
      plan,
      { ...grants(plan), cleanup: false },
      {
        fetch: async () => {
          calls++
          throw new Error("network must not run")
        },
      },
    ),
    /approvals/,
  )
  assert.equal(calls, 0)
})

import { GitHubAPI } from "../dist/index.js"

const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40),
  tree = "d".repeat(40)
const fixtureTransport = (plan, mode = "success") => {
  const upstream = new GitHubAPI()
  upstream.state.seed({
    owner: "synthetic-org",
    name: "disposable",
    commits: [
      { sha: a, parents: [] },
      { sha: b, parents: [a] },
      { sha: c, parents: [b] },
    ],
    branches: { main: a },
  })
  const calls = []
  let createdCommits = 0,
    createdRefs = 0
  return {
    calls,
    fetch: async (request) => {
      const url = new URL(request.url)
      assert.equal(url.origin, "https://api.github.com")
      assert.equal(request.redirect, "error")
      assert.equal(request.headers.get("X-GitHub-Api-Version"), "2026-03-10")
      const body =
        request.method === "GET" || request.method === "DELETE"
          ? undefined
          : await request.clone().json()
      calls.push({ method: request.method, path: url.pathname, body })
      const reply = (body, status = 200) =>
        Response.json(body, { status, headers: { "x-github-api-version-selected": "2026-03-10" } })
      if (url.pathname.includes("/git/commits/") && request.method === "GET")
        return reply({ tree: { sha: tree } })
      if (url.pathname.endsWith("/git/trees")) return reply({ sha: tree }, 201)
      if (url.pathname.endsWith("/git/commits"))
        return reply({ sha: ++createdCommits === 1 ? b : c }, 201)
      if (url.pathname.endsWith("/git/refs") && request.method === "POST") {
        createdRefs++
        if (createdRefs === 2 && mode === "lost-ref-ack")
          throw new Error("synthetic-test-token must never be logged")
        if (createdRefs === 2 && mode === "ref-rejected")
          return reply({ message: "synthetic-test-token" }, 403)
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      if (
        mode === "moved-ref" &&
        request.method === "GET" &&
        url.pathname.endsWith(`/git/ref/heads/${plan.branches.head}`) &&
        calls.some((call) => call.method === "PATCH" && call.body?.state === "closed")
      )
        return reply({
          ref: `refs/heads/${plan.branches.head}`,
          object: { type: "commit", sha: b },
        })
      const response = await upstream.fetch(request)
      if (
        ["mismatched-ref-name", "mismatched-ref-sha"].includes(mode) &&
        createdRefs === 2 &&
        request.method === "POST" &&
        url.pathname.endsWith("/git/refs")
      ) {
        const value = await response.json()
        if (mode === "mismatched-ref-name") value.ref = "refs/heads/unrelated"
        else value.object.sha = c
        return reply(value, 201)
      }
      if (
        mode === "accepted-pr-500" &&
        request.method === "POST" &&
        url.pathname.endsWith("/pulls") &&
        response.status === 201
      )
        return reply({ message: "Synthetic upstream failure" }, 500)
      if (
        mode === "duplicate-pr-500" &&
        request.method === "POST" &&
        url.pathname.endsWith("/pulls") &&
        response.status === 422
      )
        return reply({ message: "Synthetic uncertain duplicate outcome" }, 502)
      if (
        mode === "accepted-ref-500" &&
        createdRefs === 2 &&
        request.method === "POST" &&
        url.pathname.endsWith("/git/refs")
      )
        return reply({ message: "Synthetic uncertain ref outcome" }, 503)

      if (
        mode === "lost-pr-ack" &&
        request.method === "POST" &&
        url.pathname.endsWith("/pulls") &&
        response.status === 201
      )
        throw new Error("synthetic-test-token response lost after acceptance")
      if (
        mode === "changed-pr-identity" &&
        request.method === "GET" &&
        /\/pulls\/\d+$/.test(url.pathname)
      ) {
        const value = await response.json()
        value.head.ref = "unrelated"
        return reply(value)
      }
      return response
    },
  }
}
test("offline successful oracle stays within manifest, compares all operations and cleans only receipts", async () => {
  const plan = preparePlan(input),
    fixture = fixtureTransport(plan)
  const report = await executeOracle(plan, grants(plan), {
    fetch: fixture.fetch,
    mock: new GitHubAPI(),
  })
  assert.equal(report.complete, true)
  assert.deepEqual(
    [...new Set(report.comparisons.map((item) => item.operation))].sort(),
    [...operations].sort(),
  )
  assert.ok(fixture.calls.length <= plan.limits.requests)
  assert.equal(
    fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/trees"))
      .length,
    2,
  )
  assert.equal(
    fixture.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/commits"))
      .length,
    2,
  )
  assert.deepEqual(
    fixture.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    [plan.branches.head, plan.branches.base].map(
      (name) => `/repos/${plan.repository}/git/refs/heads/${name}`,
    ),
  )
  assert.ok(
    fixture.calls
      .filter((call) => call.method === "PATCH" && call.path.includes("/git/refs/"))
      .every((call) => call.body.force === false && call.path.endsWith(plan.branches.head)),
  )
  assert.ok(!JSON.stringify(report).includes("synthetic-test-token"))
})
for (const mode of ["ref-rejected", "lost-ref-ack", "moved-ref"])
  test(`offline cleanup preserves unowned or changed state: ${mode}`, async () => {
    const plan = preparePlan(input),
      fixture = fixtureTransport(plan, mode)
    const report = await executeOracle(plan, grants(plan), {
      fetch: fixture.fetch,
      mock: new GitHubAPI(),
    })
    assert.equal(report.complete, false)
    assert.ok(!JSON.stringify(report).includes("synthetic-test-token"))
    const deletions = fixture.calls.filter((call) => call.method === "DELETE")
    assert.equal(deletions.length, 1)
    assert.ok(deletions[0].path.endsWith(plan.branches.base))
    if (mode === "lost-ref-ack") assert.equal(report.uncertainWrites.length, 1)
    if (mode === "moved-ref")
      assert.ok(
        report.cleanup.some(
          (item) => item.resource === plan.branches.head && item.result.startsWith("preserved"),
        ),
      )
  })

for (const mode of ["lost-pr-ack", "changed-pr-identity"])
  test(`uncertain or changed PR preserves associated branches: ${mode}`, async () => {
    const plan = preparePlan(input),
      fixture = fixtureTransport(plan, mode)
    const report = await executeOracle(plan, grants(plan), {
      fetch: fixture.fetch,
      mock: new GitHubAPI(),
    })
    assert.equal(report.complete, false)
    assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 0)
    assert.ok(
      report.cleanup
        .filter((item) => item.resource.startsWith("mockingbird-oracle/"))
        .every((item) => item.result.startsWith("preserved")),
    )
    assert.ok(!JSON.stringify(report).includes("synthetic-test-token"))
    if (mode === "lost-pr-ack") assert.equal(report.uncertainWrites.length, 1)
  })

for (const mode of ["accepted-pr-500", "duplicate-pr-500", "accepted-ref-500"])
  test(`HTTP5xx writes are uncertain even with parsed JSON: ${mode}`, async () => {
    const plan = preparePlan(input),
      fixture = fixtureTransport(plan, mode)
    const report = await executeOracle(plan, grants(plan), {
      fetch: fixture.fetch,
      mock: new GitHubAPI(),
    })
    assert.equal(report.complete, false)
    assert.equal(report.uncertainWrites.length, 1)
    const deletions = fixture.calls.filter((call) => call.method === "DELETE")
    assert.equal(deletions.length, mode === "accepted-ref-500" ? 1 : 0)
    if (deletions.length) assert.ok(deletions[0].path.endsWith(plan.branches.base))
  })

import { ghCredential } from "./auth.mjs"
import { validateScope } from "./plan.mjs"

for (const mode of ["mismatched-ref-name", "mismatched-ref-sha"])
  test(`unverified ref success retains the expected identity for reconciliation: ${mode}`, async () => {
    const plan = preparePlan(input),
      fixture = fixtureTransport(plan, mode)
    const report = await executeOracle(plan, grants(plan), {
      fetch: fixture.fetch,
      mock: new GitHubAPI(),
    })
    assert.equal(report.complete, false)
    assert.equal(report.uncertainWrites.length, 1)
    assert.equal(report.uncertainWrites[0].ref, `refs/heads/${plan.branches.head}`)
    assert.equal(report.uncertainWrites[0].sha, b)
    assert.deepEqual(
      fixture.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
      [`/repos/${plan.repository}/git/refs/heads/${plan.branches.base}`],
    )
    assert.equal(report.receipts.refs.length, 1)
    assert.equal(report.receipts.pull, null)
  })

test("gh authentication is explicit and errors never expose credential output", async () => {
  const plan = preparePlan(input)
  assert.throws(() => validateScope(plan, { ...grants(plan), writes: false }), /approvals/)
  let seen
  const token = await ghCredential(async (...args) => {
    seen = args
    return { stdout: "synthetic-test-token\n" }
  })
  assert.equal(token, "synthetic-test-token")
  assert.deepEqual(seen.slice(0, 2), ["gh", ["auth", "token", "--hostname", "github.com"]])
  await assert.rejects(
    ghCredential(async () => {
      throw new Error("synthetic-test-token")
    }),
    (error) =>
      !error.message.includes("synthetic-test-token") &&
      /authentication unavailable/.test(error.message),
  )
})
