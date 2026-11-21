import { Table } from "@heroui/react"
import type { ReactNode } from "react"
import { mutation } from "../form.js"
import { action, type Child, Code, Empty, JustNow, Removed, Sub, Tag } from "../kit.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import { ApiError, api, day, land } from "../runtime.js"
import type { Key, Org, Project } from "../types.js"
import { secretScreen } from "./members.js"
import { orgCrumbs, orgFor, type TabContext } from "./org.js"

/** A link that leads to a screen that destroys something: in the danger colour. */
export const DangerLink = ({
  href,
  label,
  children,
}: {
  href: string
  label?: string
  children: ReactNode
}) => (
  <a
    href={href}
    {...(label ? { "aria-label": label } : {})}
    className="text-sm font-medium text-danger no-underline hover:underline"
  >
    {children}
  </a>
)

/** Keys or tokens as a table; each row links to the screen that revokes it. */
export function keyList(
  label: string,
  list: Key[],
  revoke: (key: Key) => string,
  scope: ((key: Key) => Child) | undefined,
  empty: { title: string; body: string },
) {
  if (list.length === 0) return <Empty title={empty.title}>{empty.body}</Empty>
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label={label}>
          <Table.Header>
            <Table.Column isRowHeader>Name</Table.Column>
            {scope ? <Table.Column>Scope</Table.Column> : null}
            <Table.Column>
              <span className="sr-only">Actions</span>
            </Table.Column>
          </Table.Header>
          <Table.Body>
            {list.map((key) => (
              <Table.Row key={key.id} id={key.id}>
                <Table.Cell className="whitespace-normal">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span data-title="" className="font-medium">
                      {key.name}
                    </span>
                    <JustNow about={`key:${key.id}`} />
                  </span>
                  <span className="mt-0.5 block text-sm break-words text-muted">
                    <Code>{`${key.prefix}…`}</Code> Last used {day(key.lastUsedAt)}
                    {key.expiresAt ? `, expires ${day(key.expiresAt)}` : null}
                  </span>
                </Table.Cell>
                {scope ? <Table.Cell>{scope(key)}</Table.Cell> : null}
                <Table.Cell className="text-right">
                  <DangerLink href={revoke(key)} label={`Revoke ${key.name}`}>
                    Revoke
                  </DangerLink>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  )
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
    body: (
      <section className="flex flex-col gap-4">
        <Sub>
          Keys let CI and agents call the API and fleets that require a key. An organization key
          reaches every project; a project key reaches one.
        </Sub>
        <Removed about={`keys:${org.id}`} />
        {keyList(
          "API keys",
          list,
          (key) => to("key.revoke", { org: org.id, key: key.id }),
          (key) => (
            <Tag>
              {key.projectId
                ? `${projectName(key.projectId)}: ${key.role}`
                : `organization: ${key.role}`}
            </Tag>
          ),
          { title: "No API keys yet", body: "Create one for CI or an agent." },
        )}
      </section>
    ),
  }
}

export async function keyNew({ route, params }: Context) {
  const org = await orgFor(params.org ?? "", "admin", "Creating API keys")
  const projects = await listProjects(org)
  const back = to("org.keys", { org: org.id })
  return mutation({
    title: route.title,
    crumbs: orgCrumbs(org, { href: back, label: "API keys" }, "New"),
    lead: "The key is shown once, on the next screen. Only its first characters are kept to recognise it by.",
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        hint: "What will use it, for example ci or staging-deploy. Up to 80 characters.",
        required: "Enter a name for the key.",
        attrs: { maxLength: 80 },
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
    crumbs: orgCrumbs(org, { href: back, label: "API keys" }, "Revoke"),
    danger: true,
    lead: (
      <>
        Anything still using <Code>{`${key.prefix}…`}</Code> is refused from its next request (last
        used {day(key.lastUsedAt)}). A revoked key cannot be restored.
      </>
    ),
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
