import { h } from "../dom.js"
import {
  api,
  atLeast,
  confirmThen,
  crumbs,
  field,
  flash,
  flashSlot,
  link,
  navigate,
  ui,
} from "../runtime.js"
import type { Fleet, Org, Project } from "../types.js"

export async function projectScreen(projectId: string) {
  const project = await api<Project>("GET", `/projects/${projectId}`)
  const [org, fleets] = await Promise.all([
    api<Org>("GET", `/orgs/${project.orgId}`).catch(() => undefined),
    api<{ data: Fleet[] }>("GET", `/projects/${projectId}/fleets`),
  ])
  // Without the organization the role is unknown: offer what a member may do and let the API decide.
  const canChange = !org || atLeast(org.role, "member")
  return [
    crumbs(org ? link(`/orgs/${org.id}`, {}, org.name) : "Organization", project.name),
    h(
      ".head",
      {},
      h(
        "div",
        {},
        h("h1", {}, project.name),
        h("p.sub", {}, "Each fleet is a set of emulators behind one stable URL."),
        !canChange && h("p.sub", {}, "You are a viewer: you can look at fleets, not change them."),
      ),
      org &&
        atLeast(org.role, "admin") &&
        h(
          "button.danger",
          {
            type: "button",
            onclick: confirmThen(
              `Delete ${project.name} and all of its fleets?`,
              () => api("DELETE", `/projects/${projectId}`),
              () => ui.address.replace(`/orgs/${project.orgId}`),
            ),
          },
          "Delete project",
        ),
    ),
    flashSlot(),
    fleets.data.length > 0
      ? h(
          "nav.list",
          { "aria-label": "Fleets" },
          fleets.data.map((fleet) =>
            link(
              `/fleets/${fleet.id}`,
              { class: "row" },
              h(".grow", {}, h(".title", {}, fleet.name), h(".meta.mono", {}, fleet.url)),
              h(
                "span.tag",
                {},
                `${Object.keys(fleet.emulators).length} emulator${Object.keys(fleet.emulators).length === 1 ? "" : "s"}`,
              ),
            ),
          ),
        )
      : h(
          ".empty",
          {},
          h("strong", {}, "No fleets yet"),
          canChange
            ? "Create one, then pick the emulators it should run."
            : "A member of the organization can create one.",
        ),
    canChange &&
      h(
        "form.inline",
        {
          onsubmit: async (event) => {
            event.preventDefault()
            const form = event.target as HTMLFormElement
            try {
              const slug = field(form, "slug")
              const fleet = await api<Fleet>("POST", `/projects/${projectId}/fleets`, {
                name: field(form, "name"),
                ...(slug ? { slug } : {}),
              })
              navigate(undefined, `/fleets/${fleet.id}`)
            } catch (error) {
              flash((error as Error).message)
            }
          },
        },
        h("input", {
          name: "name",
          required: true,
          maxlength: "80",
          placeholder: "Fleet name, e.g. Staging",
          "aria-label": "Fleet name",
        }),
        h("input", {
          name: "slug",
          pattern: "[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?",
          placeholder: "URL slug (optional, permanent)",
          "aria-label": "URL slug",
        }),
        h("button.primary", {}, "Create fleet"),
      ),
  ]
}
