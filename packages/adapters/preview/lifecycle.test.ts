import { expect, test } from "bun:test"
import type { CloudflarePreview, createCloudflarePreviews } from "./src/cloudflare.js"
import {
  explainBranchAction,
  explainPreviewAction,
  planPreviewSweep,
  selectBranchAction,
  selectPreviewAction,
} from "./src/lifecycle.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <T extends true>(_: T) => {}

const open = (index: number, managed: boolean) => ({
  name: `${managed ? "pr" : "other"}-${index}`,
  updatedAt: 100 + index,
})
const sweep = {
  previews: [
    ...Array.from({ length: 5 }, (_, index) => open(index, false)),
    ...Array.from({ length: 10 }, (_, index) => open(index, true)),
  ],
  openNames: new Set([
    ...Array.from({ length: 5 }, (_, index) => `other-${index}`),
    ...Array.from({ length: 10 }, (_, index) => `pr-${index}`),
  ]),
  owns: (name: string) => name.startsWith("pr-"),
  now: 110,
  retentionMs: 1000,
  capacity: 12,
}

test("#854.1 capacityCounts all removes the least recently updated managed previews, never unmanaged ones", () => {
  expect(planPreviewSweep({ ...sweep, capacityCounts: "all" })).toEqual([
    { name: "pr-0", reason: "capacity" },
    { name: "pr-1", reason: "capacity" },
    { name: "pr-2", reason: "capacity" },
  ])
  const removed = planPreviewSweep({ ...sweep, capacity: 0, capacityCounts: "all" })
  expect(removed).toHaveLength(10)
  expect(removed.every(({ name }) => name.startsWith("pr-"))).toBe(true)
})

test("#854.2 without capacityCounts, capacity applies to managed previews only", () => {
  expect(planPreviewSweep(sweep)).toEqual([])
  expect(planPreviewSweep({ ...sweep, capacityCounts: "managed" })).toEqual([])
  expect(planPreviewSweep({ ...sweep, capacity: 8 })).toEqual([
    { name: "pr-0", reason: "capacity" },
    { name: "pr-1", reason: "capacity" },
  ])
  expect(() =>
    planPreviewSweep({ ...sweep, capacityCounts: "everything" as unknown as "all" }),
  ).toThrow("Invalid preview retention policy")
})

const facts = {
  state: "open" as const,
  repository: "org/repo",
  headRepository: "org/repo",
  head: "def4567890abcdef",
}

test("#855.1 a skip says why: fork, stale head or missing build; remove and deploy as before", () => {
  expect(explainPreviewAction({ ...facts, headRepository: "fork/repo" }, facts.head)).toEqual({
    action: "skip",
    reason: "fork",
    message: "head repository fork/repo is a fork of org/repo",
  })
  expect(explainPreviewAction(facts, "abc1234567890abc")).toEqual({
    action: "skip",
    reason: "stale-head",
    message: "commit abc123456789 is no longer the head (def4567890ab)",
  })
  expect(explainPreviewAction(facts, "")).toMatchObject({ action: "skip", reason: "no-build" })
  expect(explainPreviewAction({ ...facts, state: "closed" }, "")).toEqual({ action: "remove" })
  expect(explainPreviewAction(facts, facts.head)).toEqual({ action: "deploy" })
  expect(selectPreviewAction(facts, "abc")).toBe("skip")
  expect(selectPreviewAction(facts, facts.head)).toBe("deploy")
})

test("#855.2 selectBranchAction deploys only when the branch head is the built commit", () => {
  expect(selectBranchAction({ head: "new" }, "new")).toBe("deploy")
  expect(selectBranchAction({ head: "new" }, "old")).toBe("skip")
  expect(selectBranchAction({ head: "" }, "")).toBe("skip")
  expect(explainBranchAction({ head: "new" }, "old")).toMatchObject({ reason: "stale-head" })
  assertType<Equal<ReturnType<typeof selectBranchAction>, "deploy" | "skip">>(true)
})

test("#855.3 deploy() resolves to literal action arms that a consumer can narrow", () => {
  type Result = Awaited<ReturnType<ReturnType<typeof createCloudflarePreviews>["deploy"]>>
  assertType<
    Equal<
      Result,
      | { action: "remove" | "skip" }
      | { action: "unchanged"; preview: CloudflarePreview }
      | { action: "deployed"; preview: CloudflarePreview; deploymentId: string }
    >
  >(true)
  const narrow = (result: Result) => (result.action === "deployed" ? result.deploymentId : null)
  expect(narrow({ action: "skip" })).toBeNull()
})
