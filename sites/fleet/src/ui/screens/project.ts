import { type Child, h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import {
  action,
  api,
  aRole,
  atLeast,
  count,
  crumbs,
  deny,
  head,
  justNow,
  land,
  link,
  properties,
  removed,
  section,
} from "../runtime.js"
import type { Fleet, Org, Project } from "../types.js"

export type ProjectContext = { project: Project; org: Org | undefined; role: string | undefined }

/**
 * Read a project and the caller's role in its organization. When the organization cannot be read
 * the role is unknown: offer what a member may do and let the API decide.
 */
export async function projectFor(projectId: string, minimum?: string, what = "This") {
  const project = await api<Project>("GET", `/projects/${projectId}`)
  const org = await api<Org>("GET", `/orgs/${project.orgId}`).catch(() => undefined)
  if (minimum && org && !atLeast(org.role, minimum))
    deny(`${what} is for ${minimum}s and above of ${org.name}. You are ${aRole(org.role)}.`)
  return { project, org, role: org?.role }
}

export const projectCrumbs = ({ project, org }: ProjectContext, ...rest: Child[]) =>
  crumbs(
    link(to("orgs"), {}, "Organizations"),
    org ? link(to("org", { org: org.id }), {}, org.name) : "Organization",
    rest.length > 0 ? link(to("project", { project: project.id }), {}, project.name) : project.name,
    ...rest,
  )

export async function projectScreen({ params }: Context) {
  const context = await projectFor(params.project ?? "")
  const { project, org } = context
  const fleets = (await api<{ data: Fleet[] }>("GET", `/projects/${project.id}/fleets`)).data
  const canChange = !org || atLeast(org.role, "member")
  const canDelete = org !== undefined && atLeast(org.role, "admin")
  const at = { project: project.id }
  return [
    projectCrumbs(context),
    head(
      project.name,
      [
        canChange
          ? "A project groups the fleets of one application."
          : "You are a viewer: you can look at this project and its fleets, not change them.",
        justNow(`project:${project.id}`),
      ],
      canChange && action(to("fleet.new", at), "New fleet", "primary"),
    ),
    properties("Project settings", [
      {
        name: "Name",
        value: project.name,
        about: `project-name:${project.id}`,
        change:
          canChange &&
          link(to("project.rename", at), { "aria-label": "Rename the project" }, "Rename"),
      },
      { name: "Slug", value: [h("code", {}, project.slug), h("span.aside", {}, "Permanent")] },
      { name: "ID", value: h("code", {}, project.id) },
    ]),
    section(
      "Fleets",
      null,
      h("p.sub", {}, "Each fleet is a set of emulators behind one stable URL."),
      removed(`fleets:${project.id}`),
      fleets.length > 0
        ? h(
            "nav.list",
            { "aria-label": "Fleets" },
            fleets.map((fleet) =>
              link(
                to("fleet", { fleet: fleet.id }),
                { class: "row" },
                h(".grow", {}, h(".title", {}, fleet.name), h(".meta.mono", {}, fleet.url)),
                h("span.tag", {}, count(Object.keys(fleet.emulators).length, "emulator")),
                h("span.chevron", { "aria-hidden": "true" }, "›"),
              ),
            ),
          )
        : h(
            ".empty",
            {},
            h("strong", {}, "No fleets yet"),
            canChange
              ? "Create one, then add the emulators it should run."
              : "A member of the organization can create one.",
          ),
    ),
    canDelete &&
      section(
        "Delete this project",
        null,
        h("p.sub", {}, "Deletes the project, its fleets and all of their stored emulator state."),
        h("p", {}, action(to("project.delete", at), "Delete project…", "danger")),
      ),
  ]
}

export async function projectNew({ route, params }: Context) {
  const org = await api<Org>("GET", `/orgs/${params.org}`)
  if (!atLeast(org.role, "member"))
    deny(`Creating projects is for members and above of ${org.name}. You are ${aRole(org.role)}.`)
  const back = to("org", { org: org.id })
  return mutation({
    title: route.title,
    crumbs: crumbs(link(to("orgs"), {}, "Organizations"), link(back, {}, org.name), "New project"),
    lead: `A project in ${org.name} groups the fleets of one application.`,
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        hint: "The application these fleets are for, for example Web app. Up to 80 characters.",
        required: "Enter a name for the project.",
        attrs: { maxlength: "80" },
      },
    ],
    submit: "Create project",
    pending: "Creating…",
    cancel: back,
    failed: "The project was not created.",
    run: async ({ name }) => {
      const project = await api<Project>("POST", `/orgs/${org.id}/projects`, { name })
      await land(to("project", { project: project.id }), {
        note: { about: `project:${project.id}`, text: "Created just now" },
      })
    },
  })
}

export async function projectRename({ route, params }: Context) {
  const context = await projectFor(params.project ?? "", "member", "Renaming a project")
  const { project } = context
  const back = to("project", { project: project.id })
  return mutation({
    title: titleOf(route, { project: project.name }),
    crumbs: projectCrumbs(context, "Rename"),
    lead: "Only the name changes. The slug and every fleet URL stay the same.",
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        value: project.name,
        hint: "Up to 80 characters.",
        required: "Enter a name for the project.",
        attrs: { maxlength: "80" },
      },
    ],
    submit: "Rename project",
    pending: "Renaming…",
    cancel: back,
    failed: "The project was not renamed.",
    run: async ({ name }) => {
      await api("PATCH", `/projects/${project.id}`, { name })
      await land(back, {
        note: { about: `project-name:${project.id}`, text: "Renamed just now" },
      })
    },
  })
}

export async function projectDelete({ route, params }: Context) {
  const context = await projectFor(params.project ?? "", "admin", "Deleting a project")
  const { project } = context
  const fleets = (await api<{ data: Fleet[] }>("GET", `/projects/${project.id}/fleets`)).data
  const back = to("project", { project: project.id })
  return mutation({
    title: titleOf(route, { project: project.name }),
    crumbs: projectCrumbs(context, "Delete"),
    danger: true,
    lead:
      fleets.length > 0
        ? `This deletes the project and its ${count(fleets.length, "fleet")} (${fleets.map((fleet) => fleet.name).join(", ")}) with all of their stored emulator state. Their URLs stop answering at once. It cannot be undone.`
        : "This deletes the project. It has no fleets. It cannot be undone.",
    submit: "Delete project",
    pending: "Deleting…",
    cancel: back,
    failed: "The project was not deleted.",
    run: async () => {
      await api("DELETE", `/projects/${project.id}`)
      await land(to("org", { org: project.orgId }), {
        note: { about: `projects:${project.orgId}`, text: `${project.name} was deleted just now.` },
      })
    },
  })
}
