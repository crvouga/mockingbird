import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CHECKS, type Needs, plan, titleOf } from "./check-issues.ts"

const run = {
  url: "https://github.com/acme/project/actions/runs/7/attempts/1",
  sha: "0123456789abcdef",
  repository: "acme/project",
  server: "https://github.com",
}
const needs = (results: Record<string, string>): Needs =>
  Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }]))

test("a failing check opens one issue, with the failed jobs and how to run it", () => {
  const actions = plan(
    needs({ static: "success", shard: "failure", smoke: "skipped" }),
    [],
    [
      { name: "Shard 2", url: "https://github.com/acme/project/actions/runs/7/job/2" },
      { name: "Static", url: "https://github.com/acme/project/actions/runs/7/job/1" },
    ],
    run,
  )
  expect(actions).toHaveLength(1)
  const [action] = actions
  if (action?.kind !== "open") throw new Error("expected an issue to be opened")
  expect(action.title).toBe(
    "Release check failing: Shards (build, typecheck, test, pack, portability)",
  )
  expect(action.body).toContain("[Shard 2](https://github.com/acme/project/actions/runs/7/job/2)")
  expect(action.body).not.toContain("[Static]")
  expect(action.body).toContain(
    "[`0123456`](https://github.com/acme/project/commit/0123456789abcdef)",
  )
  expect(action.body).toContain("`bun run check`")
})

test("a check that still fails comments on its open issue instead of opening another", () => {
  const actions = plan(
    needs({ static: "failure", "npm-names": "timed_out" }),
    [{ number: 12, title: titleOf("static") }],
    [],
    run,
  )
  expect(actions.map((action) => action.kind)).toEqual(["comment", "open"])
  expect(actions[0]).toMatchObject({ kind: "comment", issue: 12 })
  expect(actions[0]?.body).toContain("Still failing.")
})

test("a check that passes again closes its issue; skipped and cancelled leave it alone", () => {
  const open = [
    { number: 12, title: titleOf("static") },
    { number: 13, title: titleOf("smoke") },
    { number: 14, title: titleOf("parity") },
    { number: 15, title: "Release check failing: something retired" },
  ]
  const actions = plan(
    needs({ static: "success", smoke: "skipped", parity: "cancelled", shard: "success" }),
    open,
    [],
    run,
  )
  expect(actions).toHaveLength(1)
  expect(actions[0]).toMatchObject({ kind: "close", issue: 12 })
})

test("live parity says it does not hold the publish", () => {
  const [action] = plan(needs({ parity: "failure" }), [], [], run)
  expect(action?.body).toContain("live parity alone does not hold the publish")
})

test("every job the Report job waits for has a check here, and the reverse", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")
  const report = /\n {2}report:\n[\s\S]*?\n {4}needs: \[([^\]]+)\]/.exec(workflow)?.[1]
  if (!report) throw new Error("ci.yml has no report job with an inline needs list")
  const reported = report.split(",").map((job) => job.trim())
  expect(reported.sort()).toEqual(Object.keys(CHECKS).sort())
})
