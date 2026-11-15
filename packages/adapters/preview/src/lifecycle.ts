export type PullRequestFacts = {
  state: "open" | "closed"
  repository: string
  headRepository: string
  head: string
}
export function selectPreviewAction(
  facts: PullRequestFacts,
  builtCommit: string,
): "deploy" | "remove" | "skip" {
  if (facts.state === "closed") return "remove"
  if (!builtCommit || facts.head !== builtCommit || facts.repository !== facts.headRepository)
    return "skip"
  return "deploy"
}
export type ManagedPreview = { name: string; updatedAt: number }
export function planPreviewSweep(options: {
  previews: ManagedPreview[]
  openNames: ReadonlySet<string>
  owns: (name: string) => boolean
  now: number
  retentionMs: number
  capacity: number
}) {
  if (
    !Number.isFinite(options.now) ||
    !Number.isFinite(options.retentionMs) ||
    options.retentionMs < 0 ||
    !Number.isSafeInteger(options.capacity) ||
    options.capacity < 0
  )
    throw new Error("Invalid preview retention policy")
  const candidates = options.previews.filter((preview) => options.owns(preview.name))
  if (candidates.some((preview) => !Number.isFinite(preview.updatedAt)))
    throw new Error("Invalid preview timestamp")
  const removed = new Map<string, "orphaned" | "expired" | "capacity">()
  for (const preview of candidates) {
    if (!options.openNames.has(preview.name)) removed.set(preview.name, "orphaned")
    else if (options.now - preview.updatedAt > options.retentionMs)
      removed.set(preview.name, "expired")
  }
  const retained = candidates
    .filter((preview) => !removed.has(preview.name))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  for (const preview of retained.slice(options.capacity)) removed.set(preview.name, "capacity")
  return [...removed]
    .map(([name, reason]) => ({ name, reason }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
