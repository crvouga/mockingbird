import { h } from "../dom.js"
import { api } from "../runtime.js"
import type { Org } from "../types.js"

/** Limit → its label and, when the organization has a running count against it, that count. */
export const LIMIT_LABELS: [string, string, string?][] = [
  ["projectsPerOrg", "Projects", "projects"],
  ["fleetsPerOrg", "Fleets", "fleets"],
  ["membersPerOrg", "Members and pending invites", "members"],
  ["apiKeysPerOrg", "API keys", "apiKeys"],
  ["requestsPerMonth", "Emulator requests this month", "requestsThisMonth"],
  ["emulatorsPerFleet", "Emulators per fleet"],
  ["fleetRequestsPerMinute", "Requests per fleet per minute"],
  ["stateBytes", "Stored state per emulator (bytes)"],
]

export async function usage(org: Org) {
  const report = await api<{
    limits: Record<string, number>
    usage: Record<string, number>
    daily: { day: string; requests: number }[]
  }>("GET", `/orgs/${org.id}/usage`)
  const number = (value: number) => value.toLocaleString()
  return [
    h(
      "section",
      {},
      h(
        "p.sub",
        {},
        "Limits are set by the operator of this server. Requests are counted per calendar month (UTC).",
      ),
      h(
        ".list",
        { role: "list", "aria-label": "Limits" },
        LIMIT_LABELS.map(([limit, label, used]) => {
          const max = report.limits[limit] ?? 0
          const current = used ? (report.usage[used] ?? 0) : undefined
          const full = current !== undefined && max > 0 && current >= max
          return h(
            ".row",
            { role: "listitem" },
            h(".grow", {}, h(".title", {}, label)),
            h(
              `span.tag${full ? ".warn" : ""}`,
              full ? { title: "Limit reached" } : {},
              current === undefined
                ? max === 0
                  ? "unlimited"
                  : `up to ${number(max)}`
                : `${number(current)} of ${max === 0 ? "unlimited" : number(max)}`,
            ),
          )
        }),
      ),
    ),
    h(
      "section",
      {},
      h("h2", {}, "Requests per day"),
      report.daily.length > 0
        ? h(
            ".list",
            { role: "list", "aria-label": "Requests per day" },
            [...report.daily]
              .reverse()
              .map((entry) =>
                h(
                  ".row",
                  { role: "listitem" },
                  h(".grow.mono", {}, entry.day),
                  h("span.tag", {}, number(entry.requests)),
                ),
              ),
          )
        : h(".empty", {}, "No emulator requests in the last 31 days."),
    ),
  ]
}
