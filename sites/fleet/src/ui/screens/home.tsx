import { StatusChip } from "@crvouga/mockingbird-ui/react"
import { mutation } from "../form.js"
import { action, Empty, Head, JustNow, LinkList, LinkRow, Removed, Tag } from "../kit.js"
import type { Context } from "../router.js"
import { to } from "../routes.js"
import { api, land, ui } from "../runtime.js"
import type { Org } from "../types.js"

/** The organizations the caller belongs to. `/` opens the first one when there is one. */
export function home({ me }: Context) {
  const [first] = me.orgs
  if (first && ui.address.path() === "/") {
    ui.address.replace(to("org", { org: first.id }))
    return undefined
  }
  return (
    <>
      <Head
        title="Organizations"
        sub="An organization owns projects; a project owns fleets."
        actions={action(to("org.new"), "New organization", "primary")}
      />
      <Removed about="orgs" />
      {me.orgs.length > 0 ? (
        <LinkList label="Organizations">
          {me.orgs.map((org) => (
            <LinkRow
              key={org.id}
              href={to("org", { org: org.id })}
              title={org.name}
              meta={org.slug}
              tags={
                <>
                  <JustNow about={`org:${org.id}`} />
                  {org.suspended ? <StatusChip status="warning">suspended</StatusChip> : null}
                  <Tag>{org.role ?? ""}</Tag>
                </>
              }
            />
          ))}
        </LinkList>
      ) : (
        <Empty title="You are not in any organization yet">
          Create one to start hosting fleets, or open an invite link to join one.
        </Empty>
      )}
    </>
  )
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
        attrs: { maxLength: 80 },
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
