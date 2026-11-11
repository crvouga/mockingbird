/**
 * Control-API responses for the stories, typed after `src/openapi.ts`. `test/stories.test.ts`
 * validates every one a story serves against the OpenAPI document, so they cannot drift from it.
 * All names are invented.
 */
import openapi from "../../../openapi.json" with { type: "json" }
import { CATALOG } from "../../generated/catalog.js"
import { failure, type MockRoutes, ok } from "./mock.js"
import { ORIGIN } from "./story.js"

export type Role = "viewer" | "member" | "admin" | "owner"
export type Durability = "strict" | "buffered" | "ephemeral"

export type User = { id: string; email: string | null; name: string | null }
export type Managed = { appliedAt: string; appliedBy: string }
export type Org = {
  id: string
  slug: string
  name: string
  createdAt: string
  suspended: string | null
  managed: Managed | null
  role?: Role
}
export type DeclarationView = {
  managed: Managed | null
  declaration: Record<string, unknown>
  yaml: string
}
export type Member = {
  userId: string
  email: string | null
  name: string | null
  role: Role
  joinedAt: string
}
export type Invite = {
  id: string
  email: string
  role: Role
  expiresAt: string
  createdAt: string
  token?: string
  acceptUrl?: string
}
export type ApiKey = {
  id: string
  name: string
  scope: "user" | "org" | "project"
  role: Role | null
  orgId: string | null
  projectId: string | null
  prefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
  key?: string
}
export type Project = { id: string; orgId: string; slug: string; name: string; createdAt: string }
export type EmulatorStatus = {
  loaded: boolean
  durability: Durability
  dirty: boolean
  lastSavedAt: string | null
  storedBytes: number | null
  lastError: string | null
}
export type Emulator = {
  target: string
  durability: Durability
  url: string
  flushIntervalMs?: number
  status: EmulatorStatus
}
export type Fleet = {
  id: string
  orgId: string
  projectId: string
  slug: string
  name: string
  access: "open" | "key"
  requestsPerMinute: number | null
  url: string
  emulators: Record<string, Emulator>
  createdAt: string
  updatedAt: string
}
export type Limits = Record<
  | "projectsPerOrg"
  | "fleetsPerOrg"
  | "emulatorsPerFleet"
  | "membersPerOrg"
  | "apiKeysPerOrg"
  | "stateBytes"
  | "requestsPerMonth"
  | "fleetRequestsPerMinute",
  number
>
export type Usage = {
  suspended: string | null
  limits: Limits
  usage: Record<"projects" | "fleets" | "members" | "apiKeys" | "requestsThisMonth", number>
  daily: { day: string; requests: number }[]
}
export type AuditEntry = { id: string; actor: string; action: string; target: string; at: string }
export type Me = { kind: "user" | "api_key"; user?: User; orgs: Org[] }
export type Config = {
  publicUrl: string
  fleetUrl: string
  auth: { oidc: boolean; devLogin: boolean; tokenLogin: boolean }
  durability: Durability[]
}

const at = (day: string, time = "09:30:00") => `2026-${day}T${time}.000Z`

// ---- people and organizations ------------------------------------------------------------

export const ada: User = { id: "usr_ada", email: "ada@example.com", name: "Ada Lovelace" }

export const org = (role: Role, overrides: Partial<Org> = {}): Org => ({
  id: "org_acme",
  slug: "acme",
  name: "Acme",
  createdAt: at("03-02"),
  suspended: null,
  managed: null,
  role,
  ...overrides,
})

/** A `mockingbird.yaml` was applied: the organization's configuration is the file's. */
export const managed: Managed = { appliedAt: at("11-09", "16:20:00"), appliedBy: "ada@example.com" }
/** Applied from CI, with an organization API key. */
export const managedByKey: Managed = { appliedAt: at("11-10", "08:12:44"), appliedBy: "API key ci" }
export const globex = org("member", { id: "org_globex", slug: "globex", name: "Globex Research" })
export const initech = org("viewer", {
  id: "org_initech",
  slug: "initech",
  name: "Initech",
  suspended: "unpaid invoice",
})

export const me = (orgs: Org[] = [org("owner")]): Me => ({ kind: "user", user: ada, orgs })

export const config = (auth: Partial<Config["auth"]>): Config => ({
  publicUrl: ORIGIN,
  fleetUrl: ORIGIN,
  auth: { oidc: false, devLogin: false, tokenLogin: false, ...auth },
  durability: ["strict", "buffered", "ephemeral"],
})

export const members: Member[] = [
  { userId: ada.id, email: ada.email, name: ada.name, role: "owner", joinedAt: at("03-02") },
  {
    userId: "usr_grace",
    email: "grace@example.com",
    name: "Grace Hopper",
    role: "admin",
    joinedAt: at("03-09"),
  },
  {
    userId: "usr_linus",
    email: "linus@example.com",
    name: null,
    role: "member",
    joinedAt: at("05-21"),
  },
  {
    userId: "usr_katherine",
    email: "katherine@example.com",
    name: "Katherine Johnson",
    role: "viewer",
    joinedAt: at("08-14"),
  },
  // Signed in through an identity provider that shares no email or name.
  { userId: "usr_k3v9x2", email: null, name: null, role: "member", joinedAt: at("10-30") },
]

/** The same people, seen by one of them whose role is not `owner`. */
export const membersWith = (role: Role): Member[] => [
  { ...(members[1] as Member), role: "owner" },
  { ...(members[0] as Member), role },
  ...members.slice(2),
]

export const invites: Invite[] = [
  {
    id: "inv_1",
    email: "margaret@example.com",
    role: "member",
    expiresAt: at("11-17"),
    createdAt: at("11-10"),
  },
  {
    id: "inv_2",
    email: "auditor@example.org",
    role: "viewer",
    expiresAt: at("11-12"),
    createdAt: at("11-05"),
  },
]
export const newInvite: Invite = {
  id: "inv_3",
  email: "alan@example.com",
  role: "admin",
  expiresAt: at("11-17"),
  createdAt: at("11-10"),
  token: "k3v9x2m4p7q1w8e5r6t0",
  acceptUrl: `${ORIGIN}/invite/k3v9x2m4p7q1w8e5r6t0`,
}

// ---- projects and fleets -----------------------------------------------------------------

export const projects: Project[] = [
  { id: "prj_web", orgId: "org_acme", slug: "web", name: "Web app", createdAt: at("03-02") },
  {
    id: "prj_mobile",
    orgId: "org_acme",
    slug: "mobile",
    name: "Mobile app",
    createdAt: at("04-18"),
  },
  {
    id: "prj_billing",
    orgId: "org_acme",
    slug: "billing-service",
    name: "Billing service",
    createdAt: at("07-01"),
  },
]
export const project = projects[0] as Project

const status = (durability: Durability, overrides: Partial<EmulatorStatus> = {}) => ({
  loaded: true,
  durability,
  dirty: false,
  lastSavedAt: null,
  storedBytes: null,
  lastError: null,
  ...overrides,
})

export const emulator = (
  slug: string,
  name: string,
  target: string,
  durability: Durability,
  overrides: Partial<EmulatorStatus> = {},
): Emulator => ({
  target,
  durability,
  url: `${ORIGIN}/f/${slug}/${name}`,
  status: status(durability, overrides),
})

type EmulatorSpec = [
  name: string,
  target: string,
  durability: Durability,
  status?: Partial<EmulatorStatus>,
]

export const fleet = (
  emulators: EmulatorSpec[] = [],
  overrides: Partial<Omit<Fleet, "emulators">> = {},
): Fleet => {
  const slug = overrides.slug ?? "acme-staging"
  return {
    id: "flt_staging",
    orgId: "org_acme",
    projectId: "prj_web",
    slug,
    name: "Staging",
    access: "open",
    requestsPerMinute: null,
    url: `${ORIGIN}/f/${slug}`,
    createdAt: at("03-02"),
    updatedAt: at("11-09"),
    ...overrides,
    emulators: Object.fromEntries(
      emulators.map(([name, target, durability, state]) => [
        name,
        emulator(slug, name, target, durability, state),
      ]),
    ),
  }
}

const saved = { lastSavedAt: at("11-10", "11:58:07"), storedBytes: 48_213 }

export const fleets: Fleet[] = [
  fleet([
    ["stripe", "stripe", "strict", saved],
    ["resend", "resend", "buffered", saved],
    ["s3", "s3", "ephemeral"],
  ]),
  fleet([["stripe", "stripe", "buffered"]], {
    id: "flt_preview",
    slug: "acme-preview",
    name: "Preview",
    access: "key",
  }),
  fleet([], { id: "flt_ci", slug: "acme-ci", name: "CI" }),
]

/** A value as block-style YAML, the way the API writes a declaration. */
function yaml(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") return ` ${String(value)}\n`
  const entries = Object.entries(value)
  if (entries.length === 0) return " {}\n"
  return `\n${entries.map(([key, entry]) => `${indent}${key}:${yaml(entry, `${indent}  `)}`).join("")}`
}

/**
 * `GET /orgs/org_acme/manifest`: the organization as a `mockingbird.yaml`, declaring `shown` (by
 * default every project, with the fleets above in Web app).
 */
export const manifest = (
  by: Managed | null = null,
  shown: Project[] = projects,
  inWeb: Fleet[] = fleets,
): DeclarationView => {
  const declaration = {
    version: 1,
    organization: "acme",
    name: "Acme",
    projects: Object.fromEntries(
      shown.map((entry) => [
        entry.slug,
        {
          name: entry.name,
          fleets: Object.fromEntries(
            (entry.id === "prj_web" ? inWeb : []).map((item) => [
              item.slug,
              {
                name: item.name,
                access: item.access,
                services: Object.fromEntries(
                  Object.entries(item.emulators).map(([name, { target, durability }]) => [
                    name,
                    { ...(target === name ? {} : { target }), durability },
                  ]),
                ),
              },
            ]),
          ),
        },
      ]),
    ),
  }
  return { managed: by, declaration, yaml: `# mockingbird.yaml${yaml(declaration)}` }
}

/** The real catalog, as `GET /catalog` returns it. */
export const catalog = { data: CATALOG }

// ---- keys and tokens ---------------------------------------------------------------------

const key = (overrides: Partial<ApiKey> & Pick<ApiKey, "id" | "name" | "prefix">): ApiKey => ({
  scope: "org",
  role: "member",
  orgId: "org_acme",
  projectId: null,
  lastUsedAt: null,
  expiresAt: null,
  createdAt: at("06-01"),
  ...overrides,
})

export const apiKeys: ApiKey[] = [
  key({ id: "key_ci", name: "ci", prefix: "mbf_o_7hq2", lastUsedAt: at("11-10", "08:12:44") }),
  key({ id: "key_agent", name: "setup agent", prefix: "mbf_o_p0d4", role: "admin" }),
  key({
    id: "key_web",
    name: "web preview",
    prefix: "mbf_p_x81n",
    scope: "project",
    projectId: "prj_web",
    lastUsedAt: at("11-08"),
  }),
  key({
    id: "key_contractor",
    name: "contractor (read only)",
    prefix: "mbf_p_m3zt",
    scope: "project",
    role: "viewer",
    projectId: "prj_mobile",
    expiresAt: at("12-01"),
  }),
  key({
    id: "key_load",
    name: "load test",
    prefix: "mbf_o_a5wr",
    role: "viewer",
    lastUsedAt: at("10-02"),
    expiresAt: at("11-30"),
  }),
]
export const newApiKey = key({
  id: "key_deploy",
  name: "deploy",
  prefix: "mbf_o_e9c1",
  createdAt: at("11-10"),
  key: "mbf_o_e9c1Zr4Tn0Vb7Lq2Xy6Kd8Wm3Hs5Jf1Pg",
})

const token = (overrides: Partial<ApiKey> & Pick<ApiKey, "id" | "name" | "prefix">): ApiKey =>
  key({ scope: "user", role: null, orgId: null, ...overrides })

export const tokens: ApiKey[] = [
  token({ id: "tok_laptop", name: "laptop", prefix: "mbf_u_b2k8", lastUsedAt: at("11-09") }),
  token({ id: "tok_agent", name: "coding agent", prefix: "mbf_u_t6y1", expiresAt: at("12-31") }),
]
export const newToken = token({
  id: "tok_ci",
  name: "ci",
  prefix: "mbf_u_q4n7",
  createdAt: at("11-10"),
  key: "mbf_u_q4n7Ue2Ra9Ci6Xo3Lt8Mb1Gs5Dw0Hv",
})

// ---- usage and audit ---------------------------------------------------------------------

export const limits: Limits = {
  projectsPerOrg: 20,
  fleetsPerOrg: 50,
  emulatorsPerFleet: 50,
  membersPerOrg: 50,
  apiKeysPerOrg: 50,
  stateBytes: 16 * 1024 * 1024,
  requestsPerMonth: 1_000_000,
  fleetRequestsPerMinute: 3000,
}

const daily = [1820, 2644, 310, 0, 4102, 5388, 4975, 6120, 2203, 148, 96, 7311, 8042, 3577].map(
  (requests, index) => ({
    day: new Date(Date.UTC(2026, 9, 28 + index)).toISOString().slice(0, 10),
    requests,
  }),
)

export const usage = (overrides: Partial<Usage> = {}): Usage => ({
  suspended: null,
  limits,
  usage: { projects: 3, fleets: 7, members: 7, apiKeys: 5, requestsThisMonth: 38_862 },
  daily,
  ...overrides,
})

const actor = `user:${ada.id}:${ada.email}`
const entry = (id: number, who: string, action: string, target: string, when: string) => ({
  id: `aud_00${1_794_000_000_000 + id}000000k3v9x2`,
  actor: who,
  action,
  target,
  at: when,
})
export const audit: AuditEntry[] = [
  entry(9, actor, "putEmulator", "flt_staging/stripe", at("11-10", "11:42:10")),
  entry(8, "key:key_ci:ci", "resetEmulator", "flt_staging/resend", at("11-10", "08:12:44")),
  entry(7, actor, "createApiKey", "org_acme", at("11-09", "16:03:51")),
  entry(6, "user:usr_grace:grace@example.com", "createInvite", "org_acme", at("11-09", "15:20:02")),
  entry(5, "operator", "adminUpdateOrg", "org_acme", at("11-07", "10:00:00")),
  entry(4, actor, "updateFleet", "flt_preview", at("11-05", "13:37:29")),
  entry(3, "user:usr_k3v9x2:", "createFleet", "prj_web", at("11-03", "09:14:00")),
]

// ---- errors ------------------------------------------------------------------------------

export const unauthorized = failure(401, "unauthorized", "Sign in or send an API key")
export const forbidden = failure(403, "forbidden", "You do not have access to this resource")
export const notFound = (what: string) => failure(404, "not_found", `${what} not found`)
export const quotaExceeded = (what: string, limit: keyof Limits | "orgsPerUser", max: number) =>
  failure(
    403,
    "quota_exceeded",
    `${what} (limit ${max}). Delete something, or ask the operator to raise ${limit}.`,
    { limit, max, current: max },
  )
export const suspended = (reason: string) =>
  failure(
    403,
    "org_suspended",
    `This organization is suspended: ${reason}. Contact the operator of this service.`,
  )
/** A body the API's schema refuses: one `body.<field>: <problem>` per invalid field. */
export const invalid = (...details: string[]) =>
  failure(400, "invalid_request", details[0] ?? "Invalid body", details)
export const conflict = (message: string) => failure(409, "conflict", message)
/** A hand edit of what the organization's `mockingbird.yaml` declares. */
export const managedByDeclaration = failure(
  409,
  "managed_by_declaration",
  "This organization is configured by mockingbird.yaml, so this cannot be changed by hand. Change the file and apply it (PUT /api/v1/manifest), or release the organization (DELETE /api/v1/orgs/org_acme/manifest).",
)
export const rateLimited = failure(429, "rate_limited", "Too many API requests.")
export const tooManySignIns = failure(
  429,
  "auth_rate_limited",
  "Too many sign-in attempts from this address.",
)
export const unavailable = failure(
  500,
  "internal_error",
  "Something went wrong. Quote request id 7f3c2a91 when reporting it.",
)

// ---- whole screens -----------------------------------------------------------------------

/** A signed-in person with these organizations. */
export const signedIn = (orgs?: Org[]): MockRoutes => ({ "GET /me": ok(me(orgs)) })

/** Nobody is signed in; the server offers these ways to. */
export const signedOut = (auth: Partial<Config["auth"]>): MockRoutes => ({
  "GET /me": unauthorized,
  "GET /config": ok(config(auth)),
})

/** An organization as someone with `role` sees it, on any of its tabs. */
export const inOrg = (role: Role, overrides: Partial<Org> = {}): MockRoutes => {
  const current = org(role, overrides)
  return { ...signedIn([current]), [`GET /orgs/${current.id}`]: ok(current) }
}

/** The Web app project's screen, as someone with `role` in its organization. */
export const inProject = (
  role: Role,
  shown: Fleet[] = fleets,
  overrides: Partial<Org> = {},
): MockRoutes => ({
  ...signedIn([org(role, overrides)]),
  [`GET /projects/${project.id}`]: ok(project),
  [`GET /orgs/${project.orgId}`]: ok(org(role, overrides)),
  [`GET /projects/${project.id}/fleets`]: ok({ data: shown }),
})

/** A fleet's screen, in the Web app project, as someone with `role` in its organization. */
export const inFleet = (
  shown: Fleet,
  role: Role = "owner",
  overrides: Partial<Org> = {},
): MockRoutes => ({
  ...signedIn([org(role, overrides)]),
  [`GET /fleets/${shown.id}`]: ok(shown),
  [`GET /projects/${shown.projectId}`]: ok(project),
  [`GET /orgs/${shown.orgId}`]: ok(org(role, overrides)),
  "GET /catalog": ok(catalog),
})

export const openapiDocument = openapi
