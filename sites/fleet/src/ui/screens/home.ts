import { h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { to } from "../routes.js"
import { action, api, head, justNow, land, link, removed, ui } from "../runtime.js"
import type { Org } from "../types.js"

/** The organizations the caller belongs to. `/` opens the first one when there is one. */
export function home({ me }: Context) {
  const [first] = me.orgs
  if (first && ui.address.path() === "/") {
    ui.address.replace(to("org", { org: first.id }))
    return undefined
  }
  return [
    head(
      "Organizations",
      "An organization owns projects; a project owns fleets.",
      action(to("org.new"), "New organization", "primary"),
    ),
    removed("orgs"),
    me.orgs.length > 0
      ? h(
          "nav.list",
          { "aria-label": "Organizations" },
          me.orgs.map((org) =>
            link(
              to("org", { org: org.id }),
              { class: "row" },
              h(".grow", {}, h(".title", {}, org.name), h(".meta", {}, org.slug)),
              justNow(`org:${org.id}`),
              org.suspended && h("span.tag.warn", {}, "suspended"),
              h("span.tag", {}, org.role ?? ""),
            ),
          ),
        )
      : h(
          ".empty",
          {},
          h("strong", {}, "You are not in any organization yet"),
          "Create one to start hosting fleets, or open an invite link to join one.",
        ),
  ]
}

export function orgNew({ route }: Context) {
  return mutation({
    title: route.title,
    lead: "An organization holds your projects, the people who work on them and their API keys. You become its owner.",
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        hint: "Your company or team. Up to 80 characters; you can rename it later.",
        required: "Enter a name for the organization.",
        attrs: { maxlength: "80" },
      },
    ],
    submit: "Create organization",
    pending: "Creating…",
    cancel: to("orgs"),
    failed: "The organization was not created.",
    run: async ({ name }) => {
      const org = await api<Org>("POST", "/orgs", { name })
      await land(to("org", { org: org.id }), {
        note: { about: `org:${org.id}`, text: "Created just now" },
      })
    },
  })
}
