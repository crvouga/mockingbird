import { h } from "../dom.js"
import { api } from "../runtime.js"
import type { Org } from "../types.js"

export async function auditLog(org: Org) {
  const entries = (
    await api<{
      data: { id: string; actor: string; action: string; target: string; at: string }[]
    }>("GET", `/orgs/${org.id}/audit`)
  ).data
  return h(
    "section",
    {},
    h("p.sub", {}, "The 200 most recent changes, newest first. Entries are kept for 90 days."),
    entries.length > 0
      ? h(
          ".list",
          { role: "list", "aria-label": "Audit log" },
          entries.map((entry) =>
            h(
              ".row",
              { role: "listitem" },
              h(
                ".grow",
                {},
                h(".title.mono", {}, entry.action),
                h(
                  ".meta",
                  {},
                  `${entry.actor.split(":").slice(2).join(":") || entry.actor} · ${entry.target}`,
                ),
              ),
              h("span.meta", {}, new Date(entry.at).toLocaleString()),
            ),
          ),
        )
      : h(".empty", {}, "Nothing has been changed yet."),
  )
}
