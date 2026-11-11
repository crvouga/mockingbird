import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { actionFor, failureReport, issueTitle, LABEL, newIssueBody, type Run } from "./ci-alert.ts"

const run: Run = {
  workflow: "Release",
  conclusion: "failure",
  url: "https://github.com/o/r/actions/runs/1",
  event: "push",
  sha: "cc1460ba0000000",
  attempt: "1",
}

describe("ci-alert", () => {
  test("only failures report and only success resolves", () => {
    expect(actionFor("failure")).toBe("report")
    expect(actionFor("timed_out")).toBe("report")
    expect(actionFor("startup_failure")).toBe("report")
    expect(actionFor("success")).toBe("resolve")
    expect(actionFor("cancelled")).toBe("ignore")
    expect(actionFor("skipped")).toBe("ignore")
  })

  test("one stable title per workflow, which issue-labels.yml does not treat as agent-reported", () => {
    expect(issueTitle("Release")).toBe("[ci-failure] Release is failing on main")
    expect(issueTitle("Release")).not.toMatch(/^\[[a-z0-9-]+\] *(parity|feature|bug):/i)
    expect(issueTitle("Release")).not.toMatch(/^\[new-service\]/i)
  })

  test("the report names the run, each failed job and its errors", () => {
    const report = failureReport(run, [
      {
        name: "Release shard 1/1",
        url: "https://j/1",
        errors: ["release failed", "x".repeat(700)],
      },
      { name: "Reconcile", url: "https://j/2", errors: [] },
    ])
    expect(report).toContain("**Release** failure on `main` at cc1460b")
    expect(report).toContain(run.url)
    expect(report).toContain("### [Release shard 1/1](https://j/1)")
    expect(report).toContain("release failed")
    expect(report).toContain(`${"x".repeat(600)}…`)
    expect(report).toContain("_No error annotations; see the job log._")
    expect(newIssueBody("o/r", run, [])).toContain(
      "https://github.com/o/r/blob/main/.github/workflows/ci-alerts.yml",
    )
  })

  test("the label is declared in .github/labels.json", () => {
    const labels = JSON.parse(
      readFileSync(join(import.meta.dir, "../.github/labels.json"), "utf8"),
    ) as { name: string }[]
    expect(labels.map((l) => l.name)).toContain(LABEL)
  })

  test("every important workflow on main is watched", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../.github/workflows/ci-alerts.yml"),
      "utf8",
    )
    for (const name of ["CI", "Release", "Publish image", "Verify", "Parity", "Cache cleanup"]) {
      expect(workflow).toContain(`- ${name}\n`)
    }
  })
})
