import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CHECKS,
  failedTasks,
  type KnownIssue,
  keyOf,
  marker,
  type Needs,
  plan,
  taskCommand,
  titleOf,
} from "./check-issues.ts"

const run = {
  url: "https://github.com/acme/project/actions/runs/7/attempts/1",
  sha: "0123456789abcdef",
  repository: "acme/project",
  server: "https://github.com",
}
const needs = (results: Record<string, string>): Needs =>
  Object.fromEntries(Object.entries(results).map(([job, result]) => [job, { result }]))
const issue = (
  number: number,
  key: string,
  state = "OPEN",
  title = `Release check failing: ${key}`,
): KnownIssue => ({ number, title, state, body: `${marker(key)}\nThe check failed.` })
const job = (name: string, id: number, tasks?: string[]) => ({
  name,
  url: `https://github.com/acme/project/actions/runs/7/job/${id}`,
  ...(tasks ? { tasks } : {}),
})

test("a failing check opens one issue, with the failed jobs and how to run it", () => {
  const actions = plan(
    needs({ static: "success", smoke: "failure", shard: "skipped" }),
    [],
    [job("Consumer smoke", 3), job("Static", 1)],
    run,
  )
  expect(actions).toHaveLength(1)
  const [action] = actions
  if (action?.kind !== "open") throw new Error("expected an issue to be opened")
  expect(action.title).toBe("Release check failing: Consumer smoke")
  expect(action.body).toContain(marker("smoke"))
  expect(action.body).toContain(
    "[Consumer smoke](https://github.com/acme/project/actions/runs/7/job/3)",
  )
  expect(action.body).not.toContain("[Static]")
  expect(action.body).toContain(
    "[`0123456`](https://github.com/acme/project/commit/0123456789abcdef)",
  )
  expect(action.body).toContain("`bun run build && bun run release:smoke`")
  expect(action.body).toContain("Nothing is published from `main`")
})

test("a turbo check files one issue per failing task, named after it, with its command", () => {
  const actions = plan(
    needs({ shard: "failure" }),
    [],
    [
      job("Shard 1", 1, ["@crvouga/mockingbird-ui#test"]),
      job("Shard 3", 3, ["@crvouga/mockingbird-ui#test", "//#check:llms"]),
    ],
    run,
  )
  expect(actions.map((action) => action.kind === "open" && action.title)).toEqual([
    "Release check failing: //#check:llms",
    "Release check failing: @crvouga/mockingbird-ui#test",
  ])
  const ui = actions[1]
  expect(ui?.key).toBe(keyOf("shard", "@crvouga/mockingbird-ui#test"))
  expect(ui?.body).toContain("`bunx turbo run test --filter=@crvouga/mockingbird-ui`")
  expect(actions[0]?.body).toContain("`bunx turbo run check:llms --filter=//`")
})

test("a turbo job whose log names no task (a timeout, a setup failure) files the check's own issue", () => {
  const actions = plan(
    needs({ shard: "failure" }),
    [],
    [job("Shard 1", 1, ["@crvouga/a#test"]), job("Shard 2", 2, [])],
    run,
  )
  expect(actions.map((action) => action.key)).toEqual(["shard", keyOf("shard", "@crvouga/a#test")])
  // No job listed at all (the jobs could not be read): still the check's own issue.
  const unknown = plan(needs({ static: "timed_out" }), [], [], run)
  expect(unknown.map((action) => action.key)).toEqual(["static"])
})

test("a check that still fails comments on its open issue instead of opening another", () => {
  const actions = plan(
    needs({ static: "failure", "npm-names": "timed_out" }),
    [issue(12, "static", "OPEN", "A title someone edited")],
    [],
    run,
  )
  expect(actions.map((action) => action.kind)).toEqual(["comment", "open"])
  expect(actions[0]).toMatchObject({ kind: "comment", issue: 12 })
  expect(actions[0]?.body).toContain("Still failing.")
})

test("a check that breaks again reopens the issue it closed, the newest one", () => {
  const key = keyOf("shard", "@crvouga/a#test")
  const actions = plan(
    needs({ shard: "failure" }),
    [issue(20, key, "CLOSED"), issue(31, key, "CLOSED")],
    [job("Shard 2", 2, ["@crvouga/a#test"])],
    run,
  )
  expect(actions).toEqual([expect.objectContaining({ kind: "reopen", issue: 31 })])
  expect(actions[0]?.body).toContain("Failing again.")
})

test("a passing check closes every issue it filed; skipped and cancelled leave theirs alone", () => {
  const actions = plan(
    needs({ shard: "success", smoke: "skipped", parity: "cancelled", static: "success" }),
    [
      issue(12, "shard"),
      issue(13, keyOf("shard", "@crvouga/a#test")),
      issue(14, keyOf("shard", "@crvouga/b#typecheck"), "CLOSED"),
      issue(15, "smoke"),
      issue(16, "parity"),
      issue(17, "static-extra"),
      { number: 18, title: titleOf("static"), state: "OPEN", body: "Filed before markers." },
    ],
    [],
    run,
  )
  expect(actions.map((action) => [action.kind, "issue" in action ? action.issue : 0])).toEqual([
    ["close", 12],
    ["close", 13],
    ["close", 18],
  ])
})

test("a task issue stays open while its check fails for another task", () => {
  const actions = plan(
    needs({ shard: "failure" }),
    [issue(13, keyOf("shard", "@crvouga/a#test"))],
    [job("Shard 1", 1, ["@crvouga/b#test"])],
    run,
  )
  expect(actions).toEqual([
    expect.objectContaining({ kind: "open", key: keyOf("shard", "@crvouga/b#test") }),
  ])
})

test("release jobs and live parity say what they hold back", () => {
  const [parity] = plan(needs({ parity: "failure" }), [], [], run)
  expect(parity?.body).toContain("live parity alone does not hold the publish")
  const [publish] = plan(needs({ publish: "failure" }), [], [job("Release shard 2", 9)], run)
  expect(publish?.body).toContain("the packages of the failing shard")
  expect(publish?.body).toContain("[Release shard 2]")
})

test("failedTasks reads turbo's summary out of an Actions log", () => {
  const log = [
    "2026-11-22T08:00:00.0000000Z \u001b[1m Tasks:\u001b[0m    10 successful, 12 total",
    "2026-11-22T08:00:00.0000000Z Failed:    @crvouga/mockingbird-ui#test, //#check:llms",
    "2026-11-22T08:00:01.0000000Z  ERROR  run failed: command  exited (1)",
    "2026-11-22T08:00:02.0000000Z Failed:    @crvouga/mockingbird-ui#test",
  ].join("\n")
  expect(failedTasks(log)).toEqual(["//#check:llms", "@crvouga/mockingbird-ui#test"])
  expect(failedTasks("no summary here\nFailed: to connect")).toEqual([])
})

test("taskCommand runs one task of one package, or a root task", () => {
  expect(taskCommand("@crvouga/x#typecheck")).toBe("bunx turbo run typecheck --filter=@crvouga/x")
  expect(taskCommand("//#check:format")).toBe("bunx turbo run check:format --filter=//")
})

test("every job the Report jobs wait for has a check here, and the reverse", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")
  const reported = ["report", "report-release"].flatMap((name) => {
    const list = new RegExp(`\\n {2}${name}:\\n[\\s\\S]*?\\n {4}needs: \\[([^\\]]+)\\]`).exec(
      workflow,
    )?.[1]
    if (!list) throw new Error(`ci.yml has no ${name} job with an inline needs list`)
    return list.split(",").map((job) => job.trim())
  })
  expect(reported.sort()).toEqual(Object.keys(CHECKS).sort())
})
