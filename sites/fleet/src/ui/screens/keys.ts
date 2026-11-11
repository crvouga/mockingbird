import { type Child, h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import { ApiError, action, api, day, justNow, land, link, removed } from "../runtime.js"
import type { Key, Org, Project } from "../types.js"
import { secretScreen } from "./members.js"
import { orgCrumbs, orgFor, type TabContext } from "./org.js"

/** Keys or tokens as a list; each row links to the screen that revokes it. */
export function keyList(
  label: string,
  list: Key[],
  revoke: (key: Key) => string,
  scope: (key: Key) => Child,
  empty: Child,
) {
  return list.length > 0
    ? h(
        ".list",
        { role: "list", "aria-label": label },
        list.map((key) =>
          h(
            ".row",
            { role: "listitem" },
            h(
              ".grow",
              {},
              h(".title", {}, key.name),
              h(
                ".meta.wrap",
                {},
                h("code", {}, `${key.prefix}…`),
                `Last used ${day(key.lastUsedAt)}`,
                key.expiresAt && `, expires ${day(key.expiresAt)}`,
              ),
            ),
            justNow(`key:${key.id}`),
            scope(key),
            h(
              ".row-links",
              {},
              link(revoke(key), { class: "danger", "aria-label": `Revoke ${key.name}` }, "Revoke"),
            ),
          ),
        ),
      )
    : h(".empty", {}, empty)
}

const listKeys = async (org: Org) =>
  (await api<{ data: Key[] }>("GET", `/orgs/${org.id}/api-keys`)).data
const listProjects = async (org: Org) =>
  (await api<{ data: Project[] }>("GET", `/orgs/${org.id}/projects`)).data

export async function keys({ org }: TabContext) {
  const [list, projects] = await Promise.all([listKeys(org), listProjects(org)])
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id
  return {
    action: action(to("key.new", { org: org.id }), "New API key", "primary"),
    body: h(
      "section",
      {},
      h(
        "p.sub",
        {},
        "Keys let CI and agents call the API and fleets that require a key. An organization key reaches every project; a project key reaches one.",
      ),
      removed(`keys:${org.id}`),
      keyList(
        "API keys",
        list,
        (key) => to("key.revoke", { org: org.id, key: key.id }),
        (key) =>
          h(
            "span.tag",
            {},
            key.projectId
              ? `${projectName(key.projectId)}: ${key.role}`
              : `organization: ${key.role}`,
          ),
        [h("strong", {}, "No API keys yet"), "Create one for CI or an agent."],
      ),
    ),
  }
}

export async function keyNew({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Creating API keys")
  const projects = await listProjects(org)
  const back = to("org.keys", { org: org.id })
  return mutation({
    title: route.title,
    crumbs: orgCrumbs(org, link(back, {}, "API keys"), "New"),
    lead: "The key is shown once, on the next screen. Only its first characters are kept to recognise it by.",
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        hint: "What will use it, for example ci or staging-deploy. Up to 80 characters.",
        required: "Enter a name for the key.",
        attrs: { maxlength: "80" },
      },
      {
        kind: "select",
        name: "projectId",
        label: "Scope",
        hint: "A project key can read and change one project only.",
        value: "",
        options: [
          { value: "", label: `All of ${org.name}` },
          ...projects.map((project) => ({ value: project.id, label: `Project: ${project.name}` })),
        ],
      },
      {
        kind: "choice",
        name: "role",
        label: "Role",
        value: "member",
        options: [
          {
            value: "viewer",
            label: "Viewer",
            description: "Can read. Cannot change anything or control emulators.",
          },
          {
            value: "member",
            label: "Member",
            description:
              "Can create and change fleets and emulators, and call fleets that require a key.",
          },
          {
            value: "admin",
            label: "Admin",
            description: "Can also manage members, invites and keys. Organization keys only.",
          },
        ],
      },
    ],
    check: ({ projectId, role }) =>
      projectId && role === "admin"
        ? {
            role: "A project key is at most a member. Choose Member or Viewer, or widen the scope.",
          }
        : {},
    place: (error) => (/project key/i.test(error.message) ? "role" : undefined),
    submit: "Create API key",
    pending: "Creating…",
    cancel: back,
    failed: "The API key was not created.",
    run: async ({ name, projectId, role }) => {
      const key = await api<Key>("POST", `/orgs/${org.id}/api-keys`, {
        name,
        role,
        ...(projectId ? { projectId } : {}),
      })
      await land(to("key.created", { org: org.id, key: key.id }), {
        secret: { id: key.id, value: key.key ?? "", for: key.name },
      })
    },
  })
}

export async function keyCreated({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Creating API keys")
  return secretScreen({
    id: params.key ?? "",
    title: route.title,
    what: "This API key",
    body: "Send it as Authorization: Bearer <key> to the API, or as x-mockingbird-api-key to a fleet that requires a key.",
    done: to("org.keys", { org: org.id }),
  })
}

export async function keyRevoke({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Revoking API keys")
  const key = (await listKeys(org)).find((entry) => entry.id === params.key)
  if (!key) throw new ApiError(404, "This API key does not exist, or was already revoked.")
  const back = to("org.keys", { org: org.id })
  return mutation({
    title: titleOf(route, { key: key.name }),
    crumbs: orgCrumbs(org, link(back, {}, "API keys"), "Revoke"),
    danger: true,
    lead: [
      "Anything still using ",
      h("code", {}, `${key.prefix}…`),
      ` is refused from its next request (last used ${day(key.lastUsedAt)}). A revoked key cannot be restored.`,
    ],
    submit: "Revoke API key",
    pending: "Revoking…",
    cancel: back,
    failed: "The API key was not revoked.",
    run: async () => {
      await api("DELETE", `/orgs/${org.id}/api-keys/${key.id}`)
      await land(back, {
        note: { about: `keys:${org.id}`, text: `${key.name} was revoked just now.` },
      })
    },
  })
}
