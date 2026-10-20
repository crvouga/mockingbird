import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  BATCH_KEY_ARTIFACT,
  type Credentials,
  credentialsReceived,
  generateKeyPair,
  handoverContext,
  type Issue,
  issueBatchId,
  MAX_ISSUES,
  open,
  parseIssueNumbers,
  pickFromQueue,
  seal,
} from "./resolve-issues.ts"

let day = 0
const issue = (number: number, labels: string[], over: Partial<Issue> = {}): Issue => ({
  number,
  createdAt: new Date(Date.UTC(2026, 0, 1 + day++)).toISOString(),
  labels: ["agent-reported", ...labels].map((name) => ({ name })),
  assignees: [],
  closedByPullRequestsReferences: [],
  ...over,
})

test("takes parity, then bug, then feature, oldest first", () => {
  const queue = [
    issue(1, ["feature"]),
    issue(2, ["bug"]),
    issue(3, ["parity"]),
    issue(4, ["bug"]),
    issue(5, ["parity"]),
  ]
  expect(pickFromQueue(queue, 10)).toEqual([3, 5, 2, 4, 1])
  expect(pickFromQueue(queue, 2)).toEqual([3, 5])
})

test("skips claimed, waiting, already-fixed, new-service and unreported issues", () => {
  const queue = [
    issue(1, ["bug"], { assignees: [{ login: "someone" }] }),
    issue(2, ["bug", "needs-info"]),
    issue(4, ["feature"], { closedByPullRequestsReferences: [{ number: 99 }] }),
    issue(5, ["new-service"]),
    { ...issue(6, []), labels: [{ name: "bug" }] },
    issue(7, ["feature"]),
  ]
  expect(pickFromQueue(queue, 10)).toEqual([7])
})

test("oracle-unverified issues remain eligible for documented fallback resolutions", () => {
  const queue = [
    issue(1, ["bug"]),
    issue(2, ["parity", "needs-oracle-check"]),
    issue(3, ["feature", "needs-oracle-check"]),
    issue(4, ["parity", "needs-oracle-check", "needs-info"]),
    issue(5, ["parity", "needs-oracle-check"], { assignees: [{ login: "someone" }] }),
  ]
  expect(pickFromQueue(queue, 10)).toEqual([2, 1, 3])
  expect(pickFromQueue(queue, 1)).toEqual([2])
})

test("parses issue numbers, with or without #, once each", () => {
  expect(parseIssueNumbers(["42", "#7", "42"])).toEqual([42, 7])
  expect(parseIssueNumbers([])).toEqual([])
  expect(() => parseIssueNumbers(["abc"])).toThrow("not an issue number: abc")
  expect(() => parseIssueNumbers(["0"])).toThrow()
  expect(() => parseIssueNumbers(["1.5"])).toThrow()
  for (const malformed of ["1e2", "+1", " 42", "0x2a", "9007199254740992", "42;echo injected"])
    expect(() => parseIssueNumbers([malformed])).toThrow()
})

// Obviously fake: the handover only checks the shape of a token.
const credentials: Credentials = {
  githubToken: "gh-token-for-tests-only",
  claudeCodeOAuthToken: "claude-token-for-tests-only",
}
const context = handoverContext("owner/repo", "123", 42)

test("credentials sealed to a job's key open only with that key and context", async () => {
  const job = await generateKeyPair()
  const sealed = await seal(credentials, job.publicKey, context)
  expect(JSON.stringify(sealed)).not.toContain(credentials.githubToken)
  expect(await open(sealed, job.privateKey, context)).toEqual(credentials)

  const other = await generateKeyPair()
  await expect(open(sealed, other.privateKey, context)).rejects.toThrow()
  await expect(
    open(sealed, job.privateKey, handoverContext("owner/repo", "123", 43)),
  ).rejects.toThrow()
  await expect(
    open(sealed, job.privateKey, handoverContext("owner/repo", "124", 42)),
  ).rejects.toThrow()
})

test("a token that could inject a line into $GITHUB_ENV is refused", async () => {
  const job = await generateKeyPair()
  const injected = { ...credentials, githubToken: "gh-token\nNODE_OPTIONS=--require=/tmp/x" }
  const sealed = await seal(injected, job.publicKey, context)
  await expect(open(sealed, job.privateKey, context)).rejects.toThrow("not well-formed tokens")
})

test("one bounded canonical batch binds credentials to every selected issue", async () => {
  expect(issueBatchId([42, 7, 42])).toBe("7-42")
  expect(() => issueBatchId([])).toThrow()
  expect(() => issueBatchId([0])).toThrow()
  expect(() => issueBatchId([Number.MAX_SAFE_INTEGER + 1])).toThrow()
  expect(() => issueBatchId(Array.from({ length: MAX_ISSUES + 1 }, (_, i) => i + 1))).toThrow()
  const key = await generateKeyPair()
  const context = handoverContext("owner/repo", "123", [42, 7])
  const sealed = await seal(credentials, key.publicKey, context)
  expect(await open(sealed, key.privateKey, handoverContext("owner/repo", "123", [7, 42]))).toEqual(
    credentials,
  )
  for (const changed of [[7], [42], [7, 43], [7, 42, 99]])
    await expect(
      open(sealed, key.privateKey, handoverContext("owner/repo", "123", changed)),
    ).rejects.toThrow()
})

test("handover acknowledgment requires successful receipt by the one coordinator", () => {
  const step = { name: "Receive credentials", status: "completed", conclusion: "success" }
  expect(
    credentialsReceived([{ name: "Batch coordinator", status: "in_progress", steps: [step] }]),
  ).toBe(true)
  expect(
    credentialsReceived([{ name: "Batch coordinator", status: "completed", steps: [step] }]),
  ).toBe(true)
  expect(
    credentialsReceived([
      {
        name: "Batch coordinator",
        status: "completed",
        steps: [{ ...step, conclusion: "failure" }],
      },
    ]),
  ).toBe(false)
  expect(credentialsReceived([{ name: "Batch coordinator", status: "completed" }])).toBe(false)
  expect(credentialsReceived([{ name: "#42", status: "completed", steps: [step] }])).toBe(false)
})

test("multi-issue workflow launches one coordinator and one batch PR with a single handover", () => {
  const text = readFileSync(
    new URL("../.github/workflows/resolve-issues.yml", import.meta.url),
    "utf8",
  )
  const workflow = Bun.YAML.parse(text) as {
    jobs: Record<
      string,
      {
        name: string
        strategy?: unknown
        steps: {
          name?: string
          uses?: string
          run?: string
          env?: Record<string, string>
          with?: Record<string, unknown>
        }[]
      }
    >
  }
  const coordinators = Object.values(workflow.jobs).filter((job) =>
    job.steps.some((step) => step.run?.includes("claude -p")),
  )
  expect(coordinators).toHaveLength(1)
  const coordinator = coordinators[0]
  expect(coordinator?.name).toBe("Batch coordinator")
  expect(coordinator?.strategy).toBeUndefined()
  expect(
    coordinator?.steps.filter((step) => step.uses?.startsWith("actions/checkout@")),
  ).toHaveLength(1)
  const upload =
    coordinator?.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@")) ?? []
  expect(upload).toHaveLength(1)
  expect(upload[0]?.with?.name).toBe(BATCH_KEY_ARTIFACT)
  expect(coordinator?.steps.filter((step) => step.name === "Receive credentials")).toHaveLength(1)
  const draft = coordinator?.steps.find((step) => step.name === "Draft PR")
  expect(draft?.run?.match(/gh pr create/g)).toHaveLength(1)
  expect(draft?.run).toContain("resolve-issues/batch-$GITHUB_RUN_ID")
  const agent = coordinator?.steps.find((step) => step.run?.includes("claude -p"))
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub Actions expression, evaluated by the runner.
  expect(agent?.env?.ISSUES).toBe("${{ needs.plan.outputs.issues }}")
  expect(agent?.run).toContain('claude -p "/resolve-issues $issue_numbers"')
  expect(agent?.run).toContain("native subagents")
  expect(agent?.run).toContain("single branch, this existing worktree and this single PR")
  expect(text).not.toContain("matrix.issue")
  expect(text).not.toContain("git worktree add")
})
