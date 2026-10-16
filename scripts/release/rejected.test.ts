import { expect, test } from "bun:test"
import { rejectedPackages, rejectedReleasePackages } from "./rejected.ts"

const alpha = "@crvouga/mockingbird-service-alpha"
const beta = "@crvouga/mockingbird-service-beta"
const names = new Set([alpha, beta])
const report = (name: string) =>
  `Check its Trusted Publisher (repo crvouga/mockingbird, workflow ci.yml): https://www.npmjs.com/package/${name}/access`

test("only explicit npm publisher rejections select packages for refresh", () => {
  const log = [
    `Release\tPublish\t2026-10-15T00:00:00Z \u001b[31m${report(alpha)}\u001b[0m`,
    report(alpha),
    `::error::release ${beta} failed`,
    report(beta).replace("workflow ci.yml", "workflow unrelated.yml"),
  ].join("\n")
  expect([...rejectedPackages(log, names)]).toEqual([alpha])
  expect([...rejectedPackages("build failed before publishing", names)]).toEqual([])
  expect(() => rejectedPackages(report("@other/unrelated"), names)).toThrow(
    "outside the current public catalog",
  )
})

test("a successful latest release never refreshes failures from older runs", async () => {
  const calls: string[][] = []
  const result = await rejectedReleasePackages(names, async (args) => {
    calls.push(args)
    return JSON.stringify([{ databaseId: 42, status: "completed", conclusion: "success" }])
  })
  expect([...result]).toEqual([])
  expect(calls).toHaveLength(1)
})

test("in-progress or cancelled releases cannot trigger a refresh", async () => {
  for (const run of [
    { databaseId: 42, status: "in_progress", conclusion: "" },
    { databaseId: 42, status: "completed", conclusion: "cancelled" },
  ]) {
    let calls = 0
    await expect(
      rejectedReleasePackages(names, async () => {
        calls++
        return JSON.stringify([run])
      }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  }
})

test("the latest failed main release supplies the bounded refresh set", async () => {
  const calls: string[][] = []
  const result = await rejectedReleasePackages(names, async (args) => {
    calls.push(args)
    return calls.length === 1
      ? JSON.stringify([{ databaseId: 42, status: "completed", conclusion: "failure" }])
      : `${report(alpha)}\n${report(beta)}`
  })
  expect([...result]).toEqual([alpha, beta])
  expect(calls[0]).toContain("ci.yml")
  expect(calls[0]).toContain("main")
  expect(calls[1]).toEqual(["run", "view", "42", "--repo", "crvouga/mockingbird", "--log-failed"])
})
