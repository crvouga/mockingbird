import { createHash } from "node:crypto"

export const version = "2026-03-10"
export const operations = [
  "repos/get",
  "git/get-ref",
  "git/list-matching-refs",
  "git/create-ref",
  "git/update-ref",
  "pulls/create",
  "pulls/get",
  "pulls/list",
  "pulls/update",
]
export function preparePlan({ repository, runId, apiVersion, comparedOperations }) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split("/")[1].startsWith(".")
  )
    throw new Error("Explicit disposable owner/repo required")
  if (
    typeof runId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)
  )
    throw new Error("Explicit fresh UUIDv4 runId required")
  if (apiVersion !== version) throw new Error("Explicit API version2026-03-10 required")
  if (
    !Array.isArray(comparedOperations) ||
    JSON.stringify(comparedOperations) !== JSON.stringify(operations)
  )
    throw new Error("Explicit supported nine-operation subset required in documented order")
  const prefix = `mockingbird-oracle/${runId}`
  return {
    repository,
    runId,
    apiVersion,
    comparedOperations: [...operations],
    origin: "https://api.github.com",
    branches: { base: `${prefix}/base`, head: `${prefix}/head` },
    file: `${prefix}.txt`,
    title: `Mockingbird oracle ${runId}`,
    fixtureOperations: ["git/get-commit", "git/create-tree", "git/create-commit"],
    cleanupOperations: [
      "pulls/update:close-owned-pr",
      "git/delete-ref:owned-head",
      "git/delete-ref:owned-base",
    ],
    limits: { trees: 2, commits: 2, branches: 2, pullRequests: 1, requests: 48 },
    ownership:
      "Exclusive fresh prefix; only acknowledged creations are eligible for automatic cleanup, subject to unchanged identity/tip checks",
    retained:
      "Closed pull request history and unreachable Git objects remain; no repository deletion or default-branch mutation",
    notifications:
      "GitHub may notify watchers and trigger repository workflows/webhooks on branch and PR events",
  }
}
export const digest = (plan) => createHash("sha256").update(JSON.stringify(plan)).digest("hex")
export function validateScope(plan, { confirmedDigest, writes, notifications, cleanup }) {
  if (JSON.stringify(preparePlan(plan)) !== JSON.stringify(plan))
    throw new Error("Plan differs from canonical bounded scope")
  if (
    confirmedDigest !== digest(plan) ||
    writes !== true ||
    notifications !== true ||
    cleanup !== true
  )
    throw new Error("Exact plan digest and separate write/notification/cleanup approvals required")
}
export function validateExecution(plan, grants) {
  validateScope(plan, grants)
  const { token } = grants
  if (typeof token !== "string" || token.trim() === "")
    throw new Error("Missing credential key: MOCKINGBIRD_GITHUB_TOKEN")
}
