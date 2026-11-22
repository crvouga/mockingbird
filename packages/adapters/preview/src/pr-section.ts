/**
 * The block of a pull request's description that the preview workflow owns, between
 * `<!-- preview:start -->` and `<!-- preview:end -->`, kept at the very top. Everything outside it
 * is the author's and is never changed.
 */
export const PREVIEW_SECTION_START = "<!-- preview:start -->"
export const PREVIEW_SECTION_END = "<!-- preview:end -->"
const DATA = "<!-- preview:data "

export type PreviewSectionState =
  | "deploying"
  | "live"
  | "failing-checks"
  | "failed"
  | "removed"
  | "expired"

export const PREVIEW_SECTION_STATES: readonly PreviewSectionState[] = [
  "deploying",
  "live",
  "failing-checks",
  "failed",
  "removed",
  "expired",
]

export type PreviewSectionSite = { name: string; url?: string; state?: PreviewSectionState }

export type PreviewSectionFacts = {
  state: PreviewSectionState
  sites: readonly PreviewSectionSite[]
  /** The commit this run tried to deploy. */
  attempted?: string
  /** The commit being served. Omitted: the one the previous block recorded keeps serving. */
  deployed?: string
  runUrl?: string
  /** `owner/name`, to link commits. */
  repository?: string
  serverUrl?: string
}

type SectionData = { deployed?: string; sites?: PreviewSectionSite[] }

const LABELS: Record<PreviewSectionState, string> = {
  deploying: "Deploying",
  live: "Live",
  "failing-checks": "Deployed, but failing its checks",
  failed: "Failed (the previous deploy keeps serving)",
  removed: "Removed",
  expired: "Expired (removed by retention; push a commit to deploy it again)",
}

/** The overall state of several sites: the worst one wins. */
export function summarizePreviewState(
  states: readonly (PreviewSectionState | undefined)[],
): PreviewSectionState {
  const order: PreviewSectionState[] = [
    "failed",
    "failing-checks",
    "deploying",
    "expired",
    "removed",
    "live",
  ]
  for (const state of order) if (states.includes(state)) return state
  return "live"
}

const find = (body: string) => {
  const start = body.indexOf(PREVIEW_SECTION_START)
  if (start < 0) return undefined
  const end = body.indexOf(PREVIEW_SECTION_END, start)
  if (end < 0) return undefined
  return { start, end: end + PREVIEW_SECTION_END.length }
}

/** What an earlier block recorded (served commit, site links), or undefined. */
export function readPreviewSection(body: string | null | undefined): SectionData | undefined {
  const text = body ?? ""
  const range = find(text)
  if (!range) return undefined
  const block = text.slice(range.start, range.end)
  const at = block.indexOf(DATA)
  if (at < 0) return {}
  const close = block.indexOf(" -->", at)
  try {
    const parsed = JSON.parse(block.slice(at + DATA.length, close)) as SectionData
    return {
      ...(typeof parsed.deployed === "string" ? { deployed: parsed.deployed } : {}),
      ...(Array.isArray(parsed.sites)
        ? {
            sites: parsed.sites.filter(
              (site): site is PreviewSectionSite =>
                typeof site?.name === "string" &&
                (site.url === undefined || typeof site.url === "string"),
            ),
          }
        : {}),
    }
  } catch {
    return {}
  }
}

/** The author's text: the body without the block (and the blank line the block adds after it). */
export function stripPreviewSection(body: string | null | undefined): string {
  let text = body ?? ""
  for (let range = find(text); range; range = find(text)) {
    let end = range.end
    for (let breaks = 0; breaks < 2; breaks++) {
      if (text.startsWith("\r\n", end)) end += 2
      else if (text[end] === "\n") end += 1
    }
    text = text.slice(0, range.start) + text.slice(end)
  }
  return text
}

const short = (sha: string) => sha.slice(0, 7)
const httpsUrl = (value: string | undefined) => {
  if (!value) return undefined
  try {
    return new URL(value).protocol === "https:" ? value : undefined
  } catch {
    return undefined
  }
}
const cell = (text: string) => text.replace(/[|\r\n]/g, " ")

/**
 * Puts the preview block at the very top of `body` with `facts`, replacing an earlier block and
 * leaving every character of the author's text as it was. A site without a `url` keeps the link
 * the earlier block had, and without `deployed` the earlier served commit is kept.
 */
export function upsertPreviewSection(
  body: string | null | undefined,
  facts: PreviewSectionFacts,
): string {
  const previous = readPreviewSection(body) ?? {}
  const author = stripPreviewSection(body)
  const deployed = facts.deployed ?? previous.deployed
  const sites = facts.sites.map((site) => {
    const url = httpsUrl(site.url) ?? previous.sites?.find((old) => old.name === site.name)?.url
    return {
      name: site.name,
      ...(url ? { url } : {}),
      ...(site.state ? { state: site.state } : {}),
    }
  })
  const server = facts.serverUrl ?? "https://github.com"
  const commit = (sha: string) =>
    facts.repository
      ? `[\`${short(sha)}\`](${server}/${facts.repository}/commit/${sha})`
      : `\`${short(sha)}\``
  const gone = facts.state === "removed" || facts.state === "expired"
  const lines = [
    PREVIEW_SECTION_START,
    `${DATA}${JSON.stringify({ deployed, sites }).replace(/>/g, "\\u003e")} -->`,
    `**Preview:** ${LABELS[facts.state]}`,
    "",
  ]
  if (sites.length > 0) {
    lines.push("| Site | Link | Status |", "| --- | --- | --- |")
    for (const site of sites) {
      const link = site.url && !gone ? `[Open](${site.url})` : "-"
      lines.push(`| ${cell(site.name)} | ${link} | ${LABELS[site.state ?? facts.state]} |`)
    }
    lines.push("")
  }
  const footer = [
    deployed ? `Deployed ${commit(deployed)}` : undefined,
    facts.attempted && facts.attempted !== deployed
      ? `attempted ${commit(facts.attempted)}`
      : undefined,
    httpsUrl(facts.runUrl) ? `[run](${facts.runUrl})` : undefined,
  ].filter(Boolean)
  if (footer.length > 0) lines.push(footer.join(" · "))
  lines.push(PREVIEW_SECTION_END)
  return `${lines.join("\n")}\n\n${author}`
}
