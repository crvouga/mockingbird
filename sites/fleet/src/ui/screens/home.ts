import { h } from "../dom.js"
import { api, field, flash, flashSlot, link, navigate, ui } from "../runtime.js"
import type { Me, Org } from "../types.js"
import { orgScreen } from "./org.js"

export async function home(me: Me) {
  if (me.orgs[0] && ui.address.path() === "/") {
    ui.address.replace(`/orgs/${me.orgs[0].id}`)
    return orgScreen(me, me.orgs[0].id, "projects")
  }
  return [
    h(
      ".head",
      {},
      h(
        "div",
        {},
        h("h1", {}, "Organizations"),
        h("p.sub", {}, "An organization owns projects; a project owns fleets."),
      ),
    ),
    flashSlot(),
    me.orgs.length > 0
      ? h(
          "nav.list",
          { "aria-label": "Organizations" },
          me.orgs.map((org) =>
            link(
              `/orgs/${org.id}`,
              { class: "row" },
              h(".grow", {}, h(".title", {}, org.name), h(".meta", {}, org.slug)),
              h("span.tag", {}, org.role ?? ""),
            ),
          ),
        )
      : h(
          ".empty",
          {},
          h("strong", {}, "No organizations yet"),
          "Create one to start hosting fleets, or open an invite link to join one.",
        ),
    h(
      "form.inline",
      {
        onsubmit: async (event) => {
          event.preventDefault()
          try {
            const org = await api<Org>("POST", "/orgs", {
              name: field(event.target as HTMLFormElement, "name"),
            })
            navigate(undefined, `/orgs/${org.id}`)
          } catch (error) {
            flash((error as Error).message)
          }
        },
      },
      h("input", {
        name: "name",
        required: true,
        maxlength: "80",
        placeholder: "Organization name",
        "aria-label": "Organization name",
      }),
      h("button.primary", {}, "Create organization"),
    ),
  ]
}
