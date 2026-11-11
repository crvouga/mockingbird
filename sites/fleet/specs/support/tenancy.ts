/**
 * Helpers for the tenancy-and-access specs: who is acting, what they act on, and the few things a
 * black-box spec cannot do through the API alone (letting time pass, looking into the bucket).
 */
import { spawnSync } from "node:child_process"
import { PACKAGE_ROOT, S3_BUCKET, type Stack, startStack } from "./stack.js"
import type { Credential, Reply, World } from "./world.js"

export const ROLES = ["viewer", "member", "admin", "owner"] as const
export type Role = (typeof ROLES)[number]

/** A resource as the API returns it; every one has an id, most have a name and a slug. */
export type Thing = { id: string; name: string; slug: string } & Record<string, unknown>

// ---- the stack these specs run against ----------------------------------------------------

let shared: Promise<Stack> | undefined

/**
 * One stack per worker for the tenancy specs. It differs from the default stack in one way: the
 * per-address sign-in rate limit is off. Every scenario signs in several fresh people from the
 * same loopback address, which the default of 20 a minute refuses within seconds.
 */
export function tenancyStack(): Promise<Stack> {
  if (!shared) shared = startStack({ RATE_LIMIT_AUTH_PER_MINUTE: "0" })
  return shared
}

export async function stopTenancyStack(): Promise<void> {
  const running = shared
  shared = undefined
  if (running) await (await running).stop()
}

// ---- step patterns -------------------------------------------------------------------------

const PLACEHOLDERS: Record<string, string> = {
  /** A person by first name, or a credential: `the key "ci"`, `the token "laptop"`. */
  "{actor}": '(\\w+|the (?:key|token) "[^"]+"|an anonymous caller)',
  "{person}": "([A-Z]\\w*)",
  "{string}": '"([^"]*)"',
  "{role}": "(viewer|member|admin|owner)",
  "{int}": "(\\d+)",
  "{a}": "an?",
  "{kind}": "(?:key|token)",
  "{days}": "days?",
  "{members}": "members?",
  "{still}": "(?:still |now )?",
  "{word}": "(\\w+)",
  "{resource}": "(organization|project|fleet)",
}

/**
 * A step pattern with this area's placeholders. Regular expressions rather than Cucumber
 * expressions, so one step can be worded for a person or a key alike.
 */
export function phrase(pattern: string, alternatives?: readonly string[]): RegExp {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const source = pattern
    .split(/(\{\w+\})/)
    .map((part) =>
      part === "{options}" && alternatives
        ? `(${alternatives.map(literal).join("|")})`
        : (PLACEHOLDERS[part] ?? literal(part)),
    )
    .join("")
  return new RegExp(`^${source}$`)
}

/** The name `world.api` knows an actor by: a person's name, or the name of a key or token. */
export function who(actor: string): string {
  if (actor === "an anonymous caller") return "anonymous"
  return /^the (?:key|token) "(.+)"$/.exec(actor)?.[1] ?? actor
}

/** The body of the last reply, as the shape the step expects. */
export function bodyOf<T>(world: World): T {
  if (!world.last) throw new Error("Nothing has been requested yet")
  return world.last.body as T
}

// ---- looking things up ---------------------------------------------------------------------

export const idOf = (world: World, name: string): string => world.thing<Thing>(name).id

/** The first thing the scenario made of a kind, by id prefix (`org_`, `prj_`, `flt_`). */
export function first(world: World, prefix: string): Thing {
  for (const thing of world.things.values())
    if (typeof thing.id === "string" && thing.id.startsWith(prefix)) return thing as Thing
  throw new Error(`The scenario has made nothing with an id starting "${prefix}"`)
}

/** A slug the feature file calls `name`, made unique so scenarios sharing a server never clash. */
export const uniqueSlug = (world: World, name: string) => world.slug(name)

/** Call any path on the server (not only `/api/v1`), choosing exactly which headers are sent. */
export async function send(
  world: World,
  method: string,
  path: string,
  options: {
    as?: Credential
    /** Send the anti-forgery header with a session. Default true. */
    csrf?: boolean
    headers?: Record<string, string>
    body?: unknown
  } = {},
): Promise<Reply> {
  const credential = options.as ?? { kind: "anonymous" }
  const response = await fetch(`${world.url}${path}`, {
    method,
    headers: {
      ...(credential.kind === "session"
        ? {
            cookie: credential.cookie,
            ...(options.csrf === false ? {} : { "x-mockingbird-csrf": "1" }),
          }
        : {}),
      ...(credential.kind === "key" ? { authorization: `Bearer ${credential.key}` } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined
      ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }
      : {}),
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  world.last = { status: response.status, headers: response.headers, body, text }
  return world.last
}

/** The id of the user a person is signed in as. */
export async function userId(world: World, person: string): Promise<string> {
  const me = await world.must<{ user: { id: string } }>(person, "GET", "/me")
  return me.user.id
}

export type Member = { userId: string; email: string | null; role: Role }

/** A signed-in person who currently owns the organization, to do setup on its behalf. */
export async function ownerOf(world: World, orgId: string): Promise<string> {
  for (const [name, credential] of world.people) {
    if (credential.kind !== "session") continue
    const reply = await world.api(name, "GET", `/orgs/${orgId}`)
    if (reply.status === 200 && (reply.body as { role?: string }).role === "owner") return name
  }
  throw new Error(`Nobody in this scenario owns ${orgId}`)
}

export async function membersOf(world: World, orgId: string): Promise<Member[]> {
  const owner = await ownerOf(world, orgId)
  return (await world.must<{ data: Member[] }>(owner, "GET", `/orgs/${orgId}/members`)).data
}

/** The role a person holds in an organization right now, or undefined when they are not in it. */
export async function roleIn(world: World, person: string, orgId: string) {
  const reply = await world.api(person, "GET", `/orgs/${orgId}`)
  return reply.status === 200 ? (reply.body as { role?: Role }).role : undefined
}

// ---- setting things up ---------------------------------------------------------------------

/** Bring a person into an organization the way people really join: an invite, then accepting it. */
export async function join(world: World, person: string, orgName: string, role: Role) {
  const org = idOf(world, orgName)
  const owner = await ownerOf(world, org)
  const invite = await world.must<{ token: string }>(owner, "POST", `/orgs/${org}/invites`, {
    email: world.email(person),
    role: role === "owner" ? "admin" : role,
  })
  await world.must(person, "POST", "/invites/accept", { token: invite.token })
  if (role === "owner")
    await world.must(owner, "PATCH", `/orgs/${org}/members/${await userId(world, person)}`, {
      role,
    })
}

/** Remember a key or token under its name, both as a thing and as someone who can act. */
export function rememberKey(world: World, name: string, key: Record<string, unknown>) {
  world.things.set(name, key)
  world.people.set(name, { kind: "key", key: key.key as string })
}

export async function createKey(
  world: World,
  creator: string,
  orgName: string,
  name: string,
  options: { role?: string; project?: string; expiresInDays?: number } = {},
) {
  const key = await world.must(creator, "POST", `/orgs/${idOf(world, orgName)}/api-keys`, {
    name,
    ...(options.role ? { role: options.role } : {}),
    ...(options.project ? { projectId: idOf(world, options.project) } : {}),
    ...(options.expiresInDays ? { expiresInDays: options.expiresInDays } : {}),
  })
  rememberKey(world, name, key)
  return key
}

/** The credential a key or token acts with. */
export function keyOf(world: World, name: string): Credential {
  const credential = world.people.get(name)
  if (credential?.kind !== "key") throw new Error(`"${name}" is not a key or token`)
  return credential
}

// ---- what the API alone cannot show --------------------------------------------------------

const SQL_SCRIPT = `
import { SQL } from "bun"
const sql = new SQL(process.env.SPEC_DATABASE_URL)
const rows = await sql.unsafe(process.env.SPEC_SQL, JSON.parse(process.env.SPEC_SQL_PARAMS))
console.log(JSON.stringify(rows))
await sql.close()
`

/** Run one statement against the stack's database (the server's driver is Bun's, so via Bun). */
export function sql(stack: Stack, text: string, params: unknown[] = []): unknown[] {
  const run = spawnSync("bun", ["-e", SQL_SCRIPT], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SPEC_DATABASE_URL: stack.databaseUrl,
      SPEC_SQL: text,
      SPEC_SQL_PARAMS: JSON.stringify(params),
    },
  })
  if (run.status !== 0) throw new Error(`SQL failed: ${text}\n${run.stderr}`)
  return JSON.parse(run.stdout.trim().split("\n").pop() ?? "[]") as unknown[]
}

const SCHEMA = "mockingbird_fleet"

/**
 * Let time pass for one thing that expires: its expiry moves into the past, exactly as if the
 * clock had run on. The server is a real process, so its clock cannot be moved instead.
 */
export function expire(
  world: World,
  table: "api_keys" | "invites" | "sessions",
  column: "id" | "user_id",
  value: string,
) {
  const changed = sql(
    world.stack,
    `update ${SCHEMA}.${table} set expires_at = $1::timestamptz where ${column} = $2 returning id`,
    [new Date(Date.now() - 3_600_000).toISOString(), value],
  )
  if (changed.length === 0) throw new Error(`Nothing in ${table} with ${column} ${value} to expire`)
}

/** Keys of the objects stored for a fleet's emulators. */
export async function storedState(world: World, fleetId: string): Promise<string[]> {
  const response = await fetch(`${world.stack.s3Url}/${S3_BUCKET}?list-type=2`)
  const listing = await response.text()
  return [...listing.matchAll(/<Key>([^<]+)<\/Key>/g)]
    .map((match) => match[1] ?? "")
    .filter((key) => key.includes(`/fleets/${fleetId}/`))
}
