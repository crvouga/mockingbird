/**
 * The dashboard. It holds no logic of its own: every screen is a rendering of control-API
 * responses and every action is one API call, the same calls an agent makes with an API key.
 */

type Json = Record<string, unknown>
type Child = Node | string | false | null | undefined | Child[]
type Props = Record<string, string | boolean | ((event: Event) => void) | undefined>

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path.startsWith("/auth/") ? path : `/api/v1${path}`, {
    method,
    headers: {
      "x-mockingbird-csrf": "1",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!response.ok)
    throw new ApiError(response.status, payload.error?.message ?? `HTTP ${response.status}`)
  return payload as T
}

function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split(".")
  const element = document.createElement(name || "div")
  if (classes.length > 0) element.className = classes.join(" ")
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function") element.addEventListener(key.slice(2), value)
    else if (value === true) element.setAttribute(key, "")
    else if (typeof value === "string") element.setAttribute(key, value)
  }
  const append = (child: Child) => {
    if (Array.isArray(child)) child.forEach(append)
    else if (child !== false && child !== null && child !== undefined) element.append(child)
  }
  append(children)
  return element
}

const root = document.getElementById("app") as HTMLElement
const link = (href: string, props: Props, ...children: Child[]) =>
  h("a", { href, ...props, onclick: (event) => navigate(event, href) }, ...children)

function navigate(event: Event | undefined, href: string) {
  const mouse = event as MouseEvent | undefined
  if (mouse && (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.button !== 0)) return
  event?.preventDefault()
  history.pushState(null, "", href)
  void render()
}

/** Run an action, then redraw the current screen from the API; show a failure where it happened. */
function act(work: () => Promise<unknown>, after?: () => void) {
  return async (event: Event) => {
    event.preventDefault()
    const control = ((event as SubmitEvent).submitter ??
      event.currentTarget) as HTMLButtonElement | null
    if (control) control.disabled = true
    try {
      await work()
      after?.()
      await render()
    } catch (error) {
      if (control) control.disabled = false
      flash((error as Error).message)
    }
  }
}

let flashed: string | undefined
function flash(message: string) {
  flashed = message
  document.querySelector(".notice.error")?.remove()
  document.querySelector("main")?.prepend(h("p.notice.error", { role: "alert" }, message))
}

const confirmThen =
  (question: string, work: () => Promise<unknown>, after?: () => void) => (event: Event) => {
    event.preventDefault()
    if (window.confirm(question)) void act(work, after)(event)
  }

function copyable(value: string, label = "Copy") {
  const button = h("button.small", { type: "button" }, label)
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value)
    button.textContent = "Copied"
    setTimeout(() => (button.textContent = label), 1500)
  })
  return h(".copy", {}, h("code", { title: value }, value), button)
}

/** Breadcrumb trail; the last item is the current page. */
const crumbs = (...items: Child[]) =>
  h(
    "nav.crumbs",
    { "aria-label": "Breadcrumb" },
    items.map((item, index) => [
      index > 0 && h("span", { "aria-hidden": "true" }, "/"),
      h("span", {}, item),
    ]),
  )

const field = (form: HTMLFormElement, name: string) =>
  (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value.trim()
const day = (value: unknown) =>
  typeof value === "string"
    ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "never"

/** A secret the API returns exactly once, kept on screen until the next navigation. */
let revealed: { label: string; value: string } | undefined
const secretNotice = () =>
  revealed &&
  h(
    ".notice.secret",
    {},
    h("p", {}, h("strong", {}, revealed.label), " Copy it now; it will not be shown again."),
    copyable(revealed.value),
  )

// ---- screens -----------------------------------------------------------------------------

type Me = { kind: string; user?: { email: string | null; name: string | null }; orgs: Org[] }
type Org = { id: string; slug: string; name: string; role?: string; suspended: string | null }
type Project = { id: string; orgId: string; slug: string; name: string }
type Emulator = {
  target: string
  durability: string
  url: string
  flushIntervalMs?: number
  status: {
    loaded: boolean
    dirty: boolean
    lastSavedAt: string | null
    storedBytes: number | null
    lastError: string | null
  }
}
type Fleet = {
  id: string
  orgId: string
  projectId: string
  slug: string
  name: string
  access: string
  requestsPerMinute: number | null
  url: string
  emulators: Record<string, Emulator>
}
type Key = {
  id: string
  name: string
  scope: string
  role: string | null
  projectId: string | null
  prefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  key?: string
}
type CatalogEntry = { target: string; displayName: string; category: string; description: string }

const DURABILITY: Record<string, [string, string]> = {
  strict: [
    "Strict",
    "Committed to storage before every response. Slowest; nothing acknowledged is ever lost.",
  ],
  buffered: [
    "Buffered",
    "Served from memory, saved moments later. Fast; a crash loses the last seconds.",
  ],
  ephemeral: ["Ephemeral", "Memory only. Fastest; state is gone when the service restarts."],
}

async function signIn(config: { auth: { oidc: boolean; devLogin: boolean; tokenLogin: boolean } }) {
  const back = encodeURIComponent(location.pathname + location.search)
  return h(
    ".signin",
    {},
    h("h1", {}, "Mockingbird Fleet"),
    h(
      "p",
      {},
      "Hosted fleets of vendor-API emulators at stable URLs, with their state kept in object storage.",
    ),
    config.auth.oidc &&
      h(
        "a",
        { href: `/auth/login?return_to=${back}` },
        h("button.primary", { type: "button" }, "Sign in"),
      ),
    config.auth.devLogin &&
      h(
        "form.inline",
        {
          onsubmit: act(async () => {
            await api("POST", "/auth/dev-login", {
              email: field(document.forms[0] as HTMLFormElement, "email"),
            })
          }),
        },
        h("input", {
          name: "email",
          type: "email",
          required: true,
          placeholder: "you@example.test",
          "aria-label": "Email",
        }),
        h("button.primary", {}, "Sign in locally"),
      ),
    config.auth.devLogin &&
      h("p.sub", {}, "Local sign-in is available because this server runs on a loopback address."),
    config.auth.tokenLogin &&
      h(
        "form.inline.tokenlogin",
        {
          onsubmit: act(async () => {
            const form = document.querySelector("form.tokenlogin") as HTMLFormElement
            await api("POST", "/auth/token-login", { token: field(form, "token") })
          }),
        },
        h("input", {
          name: "token",
          type: "password",
          required: true,
          autocomplete: "off",
          placeholder: "Personal token (mbf_u_…)",
          "aria-label": "Personal token",
        }),
        h("button", {}, "Sign in with a token"),
      ),
    config.auth.tokenLogin &&
      h("p.sub", {}, "The operator of this server issues tokens with POST /api/v1/admin/users."),
  )
}

async function home(me: Me) {
  if (me.orgs[0] && location.pathname === "/") {
    history.replaceState(null, "", `/orgs/${me.orgs[0].id}`)
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
    me.orgs.length > 0
      ? h(
          ".list",
          {},
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

async function orgScreen(me: Me, orgId: string, tab: string) {
  const org = await api<Org>("GET", `/orgs/${orgId}`)
  const admin = ["admin", "owner"].includes(org.role ?? "")
  const tabs = [
    ["projects", "Projects"],
    ["members", "Members"],
    ["usage", "Usage"],
    ...(admin
      ? [
          ["keys", "API keys"],
          ["audit", "Audit log"],
          ["settings", "Settings"],
        ]
      : []),
  ]
  const header = [
    crumbs(link("/orgs", {}, "Organizations"), org.name),
    h(
      ".head",
      {},
      h(
        "div",
        {},
        h("h1", {}, org.name),
        h(
          "p.sub",
          {},
          `You are ${org.role === "owner" || org.role === "admin" ? "an" : "a"} ${org.role} of this organization.`,
        ),
      ),
    ),
    h(
      ".tabs",
      {},
      tabs.map(([id, label]) =>
        link(
          `/orgs/${orgId}${id === "projects" ? "" : `/${id}`}`,
          tab === id ? { "aria-current": "page" } : {},
          label as string,
        ),
      ),
    ),
  ]
  if (org.suspended)
    header.push(
      h(
        "p.notice.error",
        { role: "alert" },
        `This organization is suspended: ${org.suspended}. Its fleets do not serve requests and nothing can be created or changed.`,
      ),
    )
  if (tab === "members") return [header, await members(me, org, admin)]
  if (tab === "usage") return [header, await usage(org)]
  if (tab === "audit") return [header, await auditLog(org)]
  if (tab === "keys") return [header, await keys(org)]
  if (tab === "settings")
    return [
      header,
      h(
        "section",
        {},
        h("h2", {}, "Name"),
        h(
          "form.inline",
          {
            onsubmit: act(() =>
              api("PATCH", `/orgs/${orgId}`, {
                name: field(document.forms[0] as HTMLFormElement, "name"),
              }),
            ),
          },
          h("input", {
            name: "name",
            required: true,
            value: org.name,
            "aria-label": "Organization name",
          }),
          h("button", {}, "Rename"),
        ),
      ),
      org.role === "owner" &&
        h(
          "section",
          {},
          h("h2", {}, "Delete organization"),
          h(
            "p.sub",
            {},
            "Deletes every project, fleet, API key and all stored emulator state. This cannot be undone.",
          ),
          h(
            "form.inline",
            {},
            h(
              "button.danger",
              {
                type: "button",
                onclick: confirmThen(
                  `Delete ${org.name} and everything in it?`,
                  () => api("DELETE", `/orgs/${orgId}`),
                  () => history.replaceState(null, "", "/orgs"),
                ),
              },
              "Delete organization",
            ),
          ),
        ),
    ]
  const projects = (await api<{ data: Project[] }>("GET", `/orgs/${orgId}/projects`)).data
  return [
    header,
    projects.length > 0
      ? h(
          ".list",
          {},
          projects.map((project) =>
            link(
              `/projects/${project.id}`,
              { class: "row" },
              h(".grow", {}, h(".title", {}, project.name), h(".meta", {}, project.slug)),
            ),
          ),
        )
      : h(
          ".empty",
          {},
          h("strong", {}, "No projects yet"),
          "A project groups the fleets of one application.",
        ),
    org.role !== "viewer" &&
      h(
        "form.inline",
        {
          onsubmit: async (event) => {
            event.preventDefault()
            try {
              const project = await api<Project>("POST", `/orgs/${orgId}/projects`, {
                name: field(event.target as HTMLFormElement, "name"),
              })
              navigate(undefined, `/projects/${project.id}`)
            } catch (error) {
              flash((error as Error).message)
            }
          },
        },
        h("input", {
          name: "name",
          required: true,
          maxlength: "80",
          placeholder: "Project name",
          "aria-label": "Project name",
        }),
        h("button.primary", {}, "Create project"),
      ),
  ]
}

async function members(me: Me, org: Org, admin: boolean) {
  const list = (
    await api<{
      data: { userId: string; email: string | null; name: string | null; role: string }[]
    }>("GET", `/orgs/${org.id}/members`)
  ).data
  const invites = admin
    ? (
        await api<{
          data: {
            id: string
            email: string
            role: string
            expiresAt: string
          }[]
        }>("GET", `/orgs/${org.id}/invites`)
      ).data
    : []
  const roles =
    org.role === "owner" ? ["viewer", "member", "admin", "owner"] : ["viewer", "member", "admin"]
  return [
    h(
      "section",
      {},
      h(
        ".list",
        {},
        list.map((member) => {
          const self = member.email !== null && member.email === me.user?.email
          const editable = admin && (member.role !== "owner" || org.role === "owner")
          return h(
            ".row",
            {},
            h(
              ".grow",
              {},
              h(".title", {}, member.name ?? member.email ?? member.userId, self && " (you)"),
              h(".meta", {}, member.email ?? ""),
            ),
            editable
              ? h(
                  "select",
                  {
                    "aria-label": `Role of ${member.email ?? member.userId}`,
                    onchange: (event) =>
                      void act(() =>
                        api("PATCH", `/orgs/${org.id}/members/${member.userId}`, {
                          role: (event.target as HTMLSelectElement).value,
                        }),
                      )(event),
                  },
                  roles.map((role) =>
                    h("option", { value: role, selected: role === member.role }, role),
                  ),
                )
              : h("span.tag", {}, member.role),
            (editable || self) &&
              h(
                "button.small.danger",
                {
                  type: "button",
                  onclick: confirmThen(
                    self ? `Leave ${org.name}?` : `Remove ${member.email ?? "this member"}?`,
                    () => api("DELETE", `/orgs/${org.id}/members/${member.userId}`),
                    () => self && history.replaceState(null, "", "/orgs"),
                  ),
                },
                self ? "Leave" : "Remove",
              ),
          )
        }),
      ),
    ),
    admin &&
      h(
        "section",
        {},
        h("h2", {}, "Invite someone"),
        h(
          "p.sub",
          {},
          "Creating an invite gives you a link to send. Whoever opens it and signs in joins with the role you chose.",
        ),
        secretNotice(),
        h(
          "form.inline",
          {
            onsubmit: act(async () => {
              const form = document.querySelector("form.invite") as HTMLFormElement
              const invite = await api<{ acceptUrl: string }>("POST", `/orgs/${org.id}/invites`, {
                email: field(form, "email"),
                role: field(form, "role"),
              })
              revealed = { label: "Invite link created.", value: invite.acceptUrl }
            }),
            class: "inline invite",
          },
          h("input", {
            name: "email",
            type: "email",
            required: true,
            placeholder: "teammate@example.com",
            "aria-label": "Email",
          }),
          h(
            "select",
            { name: "role", "aria-label": "Role" },
            ["member", "viewer", "admin"].map((role) => h("option", { value: role }, role)),
          ),
          h("button.primary", {}, "Create invite link"),
        ),
        invites.length > 0 &&
          h(
            ".list",
            {},
            invites.map((invite) =>
              h(
                ".row",
                {},
                h(
                  ".grow",
                  {},
                  h(".title", {}, invite.email),
                  h(".meta", {}, `${invite.role} · expires ${day(invite.expiresAt)}`),
                ),
                h(
                  "button.small.danger",
                  {
                    type: "button",
                    onclick: act(() => api("DELETE", `/orgs/${org.id}/invites/${invite.id}`)),
                  },
                  "Revoke",
                ),
              ),
            ),
          ),
      ),
  ]
}

const LIMIT_LABELS: [string, string, string?][] = [
  ["projectsPerOrg", "Projects", "projects"],
  ["fleetsPerOrg", "Fleets", "fleets"],
  ["membersPerOrg", "Members and pending invites", "members"],
  ["apiKeysPerOrg", "API keys", "apiKeys"],
  ["requestsPerMonth", "Emulator requests this month", "requestsThisMonth"],
  ["emulatorsPerFleet", "Emulators per fleet"],
  ["fleetRequestsPerMinute", "Requests per fleet per minute"],
  ["stateBytes", "Stored state per emulator (bytes)"],
]

async function usage(org: Org) {
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
        {},
        LIMIT_LABELS.map(([limit, label, used]) => {
          const max = report.limits[limit] ?? 0
          const current = used ? (report.usage[used] ?? 0) : undefined
          const full = current !== undefined && max > 0 && current >= max
          return h(
            ".row",
            {},
            h(".grow", {}, h(".title", {}, label)),
            h(
              `span.tag${full ? ".warn" : ""}`,
              {},
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
            {},
            [...report.daily]
              .reverse()
              .map((entry) =>
                h(
                  ".row",
                  {},
                  h(".grow.mono", {}, entry.day),
                  h("span.tag", {}, number(entry.requests)),
                ),
              ),
          )
        : h(".empty", {}, "No emulator requests in the last 31 days."),
    ),
  ]
}

async function auditLog(org: Org) {
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
          {},
          entries.map((entry) =>
            h(
              ".row",
              {},
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

function keyList(list: Key[], revoke: (key: Key) => Promise<unknown>, empty: string) {
  return list.length > 0
    ? h(
        ".list",
        {},
        list.map((key) =>
          h(
            ".row",
            {},
            h(
              ".grow",
              {},
              h(".title", {}, key.name),
              h(
                ".meta.mono",
                {},
                `${key.prefix}… · last used ${day(key.lastUsedAt)}${key.expiresAt ? ` · expires ${day(key.expiresAt)}` : ""}`,
              ),
            ),
            key.role && h("span.tag", {}, key.projectId ? `project ${key.role}` : key.role),
            h(
              "button.small.danger",
              {
                type: "button",
                onclick: confirmThen(`Revoke ${key.name}? Anything using it stops working.`, () =>
                  revoke(key),
                ),
              },
              "Revoke",
            ),
          ),
        ),
      )
    : h(".empty", {}, empty)
}

async function keys(org: Org) {
  const [list, projects] = await Promise.all([
    api<{ data: Key[] }>("GET", `/orgs/${org.id}/api-keys`),
    api<{ data: Project[] }>("GET", `/orgs/${org.id}/projects`),
  ])
  return h(
    "section",
    {},
    h(
      "p.sub",
      {},
      "Keys let CI and agents call the API and protected fleets. An organization key reaches every project; a project key reaches one.",
    ),
    secretNotice(),
    h(
      "form.inline.newkey",
      {
        onsubmit: act(async () => {
          const form = document.querySelector("form.newkey") as HTMLFormElement
          const projectId = field(form, "projectId")
          const key = await api<Key>("POST", `/orgs/${org.id}/api-keys`, {
            name: field(form, "name"),
            role: field(form, "role"),
            ...(projectId ? { projectId } : {}),
          })
          revealed = { label: "API key created.", value: key.key ?? "" }
        }),
      },
      h("input", {
        name: "name",
        required: true,
        maxlength: "80",
        placeholder: "Key name, e.g. ci",
        "aria-label": "Key name",
      }),
      h(
        "select",
        { name: "projectId", "aria-label": "Scope" },
        h("option", { value: "" }, "Whole organization"),
        projects.data.map((project) =>
          h("option", { value: project.id }, `Project: ${project.name}`),
        ),
      ),
      h(
        "select",
        { name: "role", "aria-label": "Role" },
        ["member", "viewer", "admin"].map((role) => h("option", { value: role }, role)),
      ),
      h("button.primary", {}, "Create key"),
    ),
    h("div", {}, h("p", {}, " ")),
    keyList(
      list.data,
      (key) => api("DELETE", `/orgs/${org.id}/api-keys/${key.id}`),
      "No API keys yet.",
    ),
  )
}

async function projectScreen(projectId: string) {
  const project = await api<Project>("GET", `/projects/${projectId}`)
  const [org, fleets] = await Promise.all([
    api<Org>("GET", `/orgs/${project.orgId}`).catch(() => undefined),
    api<{ data: Fleet[] }>("GET", `/projects/${projectId}/fleets`),
  ])
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
      ),
      org &&
        org.role !== "viewer" &&
        org.role !== "member" &&
        h(
          "button.danger",
          {
            type: "button",
            onclick: confirmThen(
              `Delete ${project.name} and all of its fleets?`,
              () => api("DELETE", `/projects/${projectId}`),
              () => history.replaceState(null, "", `/orgs/${project.orgId}`),
            ),
          },
          "Delete project",
        ),
    ),
    fleets.data.length > 0
      ? h(
          ".list",
          {},
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
          "Create one, then pick the emulators it should run.",
        ),
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

let catalog: CatalogEntry[] | undefined

async function fleetScreen(fleetId: string) {
  const fleet = await api<Fleet>("GET", `/fleets/${fleetId}`)
  const project = await api<Project>("GET", `/projects/${fleet.projectId}`)
  catalog ??= (await api<{ data: CatalogEntry[] }>("GET", "/catalog")).data
  const names = Object.keys(fleet.emulators).sort()
  const emulatorPath = (name: string) => `/fleets/${fleetId}/emulators/${name}`

  const card = (name: string, emulator: Emulator) => {
    const entry = catalog?.find((item) => item.target === emulator.target)
    const { status } = emulator
    const state = status.lastError
      ? h("span.tag.warn", { title: status.lastError }, "save failing")
      : emulator.durability === "ephemeral"
        ? h("span.tag", {}, "not stored")
        : status.dirty
          ? h("span.tag.warn", {}, "unsaved changes")
          : status.lastSavedAt
            ? h("span.tag.ok", {}, `saved ${new Date(status.lastSavedAt).toLocaleTimeString()}`)
            : h("span.tag", {}, status.loaded ? "no changes yet" : "idle")
    return h(
      "article.emulator",
      {},
      h(
        "header",
        {},
        h(
          "h2.grow",
          {},
          name,
          name !== emulator.target &&
            h("span.sub", {}, ` · ${entry?.displayName ?? emulator.target}`),
        ),
        state,
      ),
      h(
        ".body",
        {},
        entry && h("p.sub", {}, entry.description),
        copyable(emulator.url, "Copy URL"),
        h(
          ".durability",
          { role: "group", "aria-label": `Durability of ${name}` },
          Object.entries(DURABILITY).map(([mode, [label, consequence]]) =>
            h(
              "button",
              {
                type: "button",
                "aria-pressed": String(emulator.durability === mode),
                onclick: act(() =>
                  emulator.durability === mode
                    ? Promise.resolve()
                    : api("PATCH", emulatorPath(name), { durability: mode }),
                ),
              },
              h("b", {}, label),
              h("span", {}, consequence),
            ),
          ),
        ),
        h(
          ".actions",
          {},
          emulator.durability === "buffered" &&
            h(
              "button.small",
              { type: "button", onclick: act(() => api("POST", `${emulatorPath(name)}/flush`)) },
              "Save now",
            ),
          h(
            "button.small",
            {
              type: "button",
              onclick: async () =>
                download(
                  `${fleet.slug}-${name}-state.json`,
                  await api("GET", `${emulatorPath(name)}/state`),
                ),
            },
            "Download state",
          ),
          h(
            "button.small.danger",
            {
              type: "button",
              onclick: confirmThen(`Reset ${name}? Its state is erased.`, () =>
                api("POST", `${emulatorPath(name)}/reset`),
              ),
            },
            "Reset state",
          ),
          h(
            "button.small.danger",
            {
              type: "button",
              onclick: confirmThen(`Remove ${name} from this fleet? Its state is erased.`, () =>
                api("DELETE", emulatorPath(name)),
              ),
            },
            "Remove",
          ),
        ),
      ),
    )
  }

  const results = h(".catalog", { hidden: true })
  const search = h("input", {
    type: "search",
    placeholder: `Search ${catalog.length} emulators: stripe, s3, twilio…`,
    "aria-label": "Search emulators",
  }) as HTMLInputElement
  const showResults = () => {
    const query = search.value.trim().toLowerCase()
    const matches = (catalog ?? [])
      .filter(
        (entry) =>
          !query ||
          `${entry.target} ${entry.displayName} ${entry.category}`.toLowerCase().includes(query),
      )
      .slice(0, 40)
    results.hidden = false
    results.replaceChildren(
      ...(matches.length > 0
        ? matches.map((entry) => {
            // A second instance of the same emulator gets a numbered name.
            let name = entry.target
            for (let n = 2; fleet.emulators[name]; n++) name = `${entry.target}-${n}`
            return h(
              "button",
              {
                type: "button",
                onclick: act(() =>
                  api("PUT", emulatorPath(name), { target: entry.target, durability: "buffered" }),
                ),
              },
              h("b", {}, entry.displayName),
              h("small", {}, `${entry.category} · ${entry.description}`),
            )
          })
        : [h("p.row.meta", {}, "No emulator matches that search.")]),
    )
  }
  search.addEventListener("input", showResults)
  search.addEventListener("focus", showResults)

  return [
    crumbs(
      link(`/orgs/${fleet.orgId}`, {}, "Organization"),
      link(`/projects/${project.id}`, {}, project.name),
      fleet.name,
    ),
    h(
      ".head",
      {},
      h(
        "div",
        {},
        h("h1", {}, fleet.name),
        h("p.sub", {}, "Point each vendor SDK's base URL at its emulator below."),
      ),
      h(
        "button.danger",
        {
          type: "button",
          onclick: confirmThen(
            `Delete ${fleet.name}? Its URL stops working and all emulator state is erased.`,
            () => api("DELETE", `/fleets/${fleetId}`),
            () => history.replaceState(null, "", `/projects/${project.id}`),
          ),
        },
        "Delete fleet",
      ),
    ),
    h(
      "section.stack",
      {},
      copyable(fleet.url, "Copy fleet URL"),
      h(
        "label.field",
        {},
        "Who can call this fleet",
        h(
          "select",
          {
            onchange: (event) =>
              void act(() =>
                api("PATCH", `/fleets/${fleetId}`, {
                  access: (event.target as HTMLSelectElement).value,
                }),
              )(event),
          },
          h("option", { value: "open", selected: fleet.access === "open" }, "Anyone with the URL"),
          h(
            "option",
            { value: "key", selected: fleet.access === "key" },
            "Only requests with an API key (x-mockingbird-api-key)",
          ),
        ),
      ),
      h(
        "form.inline.rate",
        {
          onsubmit: act(() =>
            api("PATCH", `/fleets/${fleetId}`, {
              requestsPerMinute: Number(
                field(document.querySelector("form.rate") as HTMLFormElement, "rpm"),
              ),
            }),
          ),
        },
        h(
          "label.field",
          {},
          "Requests per minute this fleet accepts (blank: the organization's ceiling)",
          h("input", {
            name: "rpm",
            type: "number",
            min: "1",
            required: true,
            value: fleet.requestsPerMinute ? String(fleet.requestsPerMinute) : "",
            placeholder: "organization ceiling",
          }),
        ),
        h("button", {}, "Set rate limit"),
      ),
    ),
    h(
      "section",
      {},
      h("h2", {}, "Emulators"),
      names.length > 0
        ? names.map((name) => card(name, fleet.emulators[name] as Emulator))
        : h(".empty", {}, h("strong", {}, "This fleet is empty"), "Add an emulator below."),
    ),
    h("section", {}, h("h2", {}, "Add an emulator"), search, results),
  ]
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  )
  const anchor = h("a", { href: url, download: name })
  anchor.click()
  URL.revokeObjectURL(url)
}

async function account(me: Me) {
  const tokens = (await api<{ data: Key[] }>("GET", "/tokens")).data
  return [
    h(".head", {}, h("div", {}, h("h1", {}, "Account"), h("p.sub", {}, me.user?.email ?? ""))),
    h(
      "section",
      {},
      h("h2", {}, "Personal tokens"),
      h(
        "p.sub",
        {},
        "A personal token acts as you everywhere you are a member. Use one to let an agent set up organizations and fleets through the API.",
      ),
      secretNotice(),
      h(
        "form.inline.newtoken",
        {
          onsubmit: act(async () => {
            const token = await api<Key>("POST", "/tokens", {
              name: field(document.querySelector("form.newtoken") as HTMLFormElement, "name"),
            })
            revealed = { label: "Token created.", value: token.key ?? "" }
          }),
        },
        h("input", {
          name: "name",
          required: true,
          maxlength: "80",
          placeholder: "Token name, e.g. laptop",
          "aria-label": "Token name",
        }),
        h("button.primary", {}, "Create token"),
      ),
      h("div", {}, h("p", {}, " ")),
      keyList(tokens, (key) => api("DELETE", `/tokens/${key.id}`), "No personal tokens yet."),
    ),
  ]
}

async function reference() {
  const spec = (await (await fetch("/api/openapi.json")).json()) as {
    servers: { url: string }[]
    paths: Record<string, Record<string, { summary: string; tags: string[] }>>
  }
  const groups = new Map<string, HTMLElement[]>()
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item)) {
      const tag = operation.tags[0] ?? "Other"
      groups.set(tag, [
        ...(groups.get(tag) ?? []),
        h(
          ".op",
          {},
          h(`span.method.${method.toUpperCase()}`, {}, method.toUpperCase()),
          h("code", {}, path),
          h("span.summary", {}, operation.summary),
        ),
      ])
    }
  return [
    h(
      ".head",
      {},
      h(
        "div",
        {},
        h("h1", {}, "API reference"),
        h(
          "p.sub",
          {},
          "Everything this dashboard does is one of these calls. Send ",
          h("code", {}, "Authorization: Bearer <token or key>"),
          ".",
        ),
      ),
    ),
    h(
      "section.stack",
      {},
      copyable(spec.servers[0]?.url ?? "", "Copy base URL"),
      copyable(`${location.origin}/api/openapi.json`, "Copy OpenAPI URL"),
    ),
    [...groups].map(([tag, operations]) =>
      h("section", {}, h("h2", {}, tag), h(".list", {}, operations)),
    ),
  ]
}

async function invite(token: string) {
  const org = await api<Org>("POST", "/invites/accept", { token })
  history.replaceState(null, "", `/orgs/${org.id}`)
  return render()
}

// ---- router ------------------------------------------------------------------------------

let lastPath: string | undefined

async function render(): Promise<void> {
  const path = location.pathname
  if (path !== lastPath) revealed = undefined
  lastPath = path
  flashed = undefined
  let me: Me
  try {
    me = await api<Me>("GET", "/me")
  } catch (error) {
    if ((error as ApiError).status !== 401) throw error
    root.replaceChildren(await signIn(await api("GET", "/config")))
    return
  }
  const [, first, id, tab] = path.split("/")
  let screen: Child
  try {
    if (first === "invite" && id) return await invite(id)
    screen =
      first === "orgs" && id
        ? await orgScreen(me, id, tab ?? "projects")
        : first === "projects" && id
          ? await projectScreen(id)
          : first === "fleets" && id
            ? await fleetScreen(id)
            : first === "account"
              ? await account(me)
              : first === "api-reference"
                ? await reference()
                : await home(me)
  } catch (error) {
    screen = h(
      ".empty",
      {},
      h("strong", {}, (error as ApiError).status === 404 ? "Not found" : "Something went wrong"),
      (error as Error).message,
    )
  }
  root.replaceChildren(
    h(
      "header.top",
      {},
      link("/orgs", { class: "brand" }, "Mockingbird ", h("span", {}, "Fleet")),
      h(
        "nav.topnav",
        { "aria-label": "Account" },
        link("/api-reference", { class: "navlink" }, "API"),
        link("/account", { class: "navlink", title: me.user?.email ?? "" }, "Account"),
        h(
          "button.linkish",
          { type: "button", onclick: act(() => api("POST", "/auth/logout")) },
          "Sign out",
        ),
      ),
    ),
    h("main", {}, flashed && h("p.notice.error", { role: "alert" }, flashed), screen),
  )
}

window.addEventListener("popstate", () => void render())
void render()
