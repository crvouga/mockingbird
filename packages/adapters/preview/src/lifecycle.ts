export type PullRequestFacts = {
  state: "open" | "closed"
  repository: string
  headRepository: string
  head: string
}
export type PreviewSkipReason = "fork" | "stale-head" | "no-build"
export type PreviewSkip = { action: "skip"; reason: PreviewSkipReason; message: string }
export type PreviewDecision = { action: "deploy" } | { action: "remove" } | PreviewSkip
export type BranchFacts = { head: string }
export type BranchDecision = { action: "deploy" } | PreviewSkip

const short = (commit: string) => commit.slice(0, 12)
const skip = (reason: PreviewSkipReason, message: string): PreviewSkip => ({
  action: "skip",
  reason,
  message,
})
const headDecision = (head: string, builtCommit: string): BranchDecision => {
  if (!builtCommit) return skip("no-build", "no build commit was provided")
  if (head !== builtCommit)
    return skip(
      "stale-head",
      `commit ${short(builtCommit)} is no longer the head (${short(head) || "none"})`,
    )
  return { action: "deploy" }
}

/** Decides a pull request preview from current facts, and says why it skips. */
export function explainPreviewAction(
  facts: PullRequestFacts,
  builtCommit: string,
): PreviewDecision {
  if (facts.state === "closed") return { action: "remove" }
  if (facts.repository !== facts.headRepository)
    return skip("fork", `head repository ${facts.headRepository} is a fork of ${facts.repository}`)
  return headDecision(facts.head, builtCommit)
}
export function selectPreviewAction(
  facts: PullRequestFacts,
  builtCommit: string,
): "deploy" | "remove" | "skip" {
  return explainPreviewAction(facts, builtCommit).action
}

/** Decides a deploy of the branch the Worker itself serves: only its current head deploys. */
export function explainBranchAction(facts: BranchFacts, builtCommit: string): BranchDecision {
  return headDecision(facts.head, builtCommit)
}
export function selectBranchAction(facts: BranchFacts, builtCommit: string): "deploy" | "skip" {
  return explainBranchAction(facts, builtCommit).action
}

export type ManagedPreview = { name: string; updatedAt: number }
export function planPreviewSweep(options: {
  previews: ManagedPreview[]
  openNames: ReadonlySet<string>
  owns: (name: string) => boolean
  now: number
  retentionMs: number
  capacity: number
  /**
   * `"managed"` (default) applies `capacity` to managed previews only. `"all"` counts every
   * preview, including ones `owns` rejects, against `capacity`; unmanaged previews are still
   * never removed.
   */
  capacityCounts?: "managed" | "all"
}) {
  const counts = options.capacityCounts ?? "managed"
  if (
    !Number.isFinite(options.now) ||
    !Number.isFinite(options.retentionMs) ||
    options.retentionMs < 0 ||
    !Number.isSafeInteger(options.capacity) ||
    options.capacity < 0 ||
    (counts !== "managed" && counts !== "all")
  )
    throw new Error("Invalid preview retention policy")
  const candidates = options.previews.filter((preview) => options.owns(preview.name))
  if (candidates.some((preview) => !Number.isFinite(preview.updatedAt)))
    throw new Error("Invalid preview timestamp")
  const unmanaged = counts === "all" ? options.previews.length - candidates.length : 0
  const removed = new Map<string, "orphaned" | "expired" | "capacity">()
  for (const preview of candidates) {
    if (!options.openNames.has(preview.name)) removed.set(preview.name, "orphaned")
    else if (options.now - preview.updatedAt > options.retentionMs)
      removed.set(preview.name, "expired")
  }
  const retained = candidates
    .filter((preview) => !removed.has(preview.name))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  for (const preview of retained.slice(Math.max(0, options.capacity - unmanaged)))
    removed.set(preview.name, "capacity")
  return [...removed]
    .map(([name, reason]) => ({ name, reason }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
