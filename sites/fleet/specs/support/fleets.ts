/**
 * Helpers for the fleet-serving specs (`specs/features/fleets`): people, fleets and keys by the
 * names a feature uses, emails through the Resend emulator, a direct look into object storage,
 * requests addressed to a particular host or from a particular client address, and bursts that
 * use up a rate-limit budget.
 */
import { request as httpRequest } from "node:http"
import { gunzipSync } from "node:zlib"
import { OPERATOR_TOKEN, S3_BUCKET, type Server } from "./stack.js"
import type { Credential, Reply, World } from "./world.js"

export type FleetView = {
  id: string
  orgId: string
  projectId: string
  slug: string
  name: string
  url: string
  access: string
  requestsPerMinute: number | null
  emulators: Record<
    string,
    {
      target: string
      durability: string
      url: string
      status: { dirty: boolean; lastSavedAt: string | null; storedBytes: number | null }
    }
  >
}
export type EmulatorInput = {
  target: string
  durability?: string
  flushIntervalMs?: number
  webhookOrigins?: string[]
}
export type SentEmail = { id: string; fleet: string; emulator: string; namespace?: string }

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `probe` returns something truthy; fails with `what` after `seconds`. */
export async function eventually<T>(
  what: string,
  seconds: number,
  probe: () => Promise<T | false | undefined>,
): Promise<T> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const result = await probe()
    if (result) return result
    if (Date.now() > deadline) throw new Error(`Not within ${seconds} s: ${what}`)
    await sleep(100)
  }
}

/** The last reply the system gave; fails when the scenario has not made a request yet. */
export function lastReply(world: World): Reply {
  if (!world.last) throw new Error("The scenario has not made a request yet")
  return world.last
}

export async function toReply(response: Response): Promise<Reply> {
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: response.status, headers: response.headers, body, text }
}

// ---- people, organizations, fleets, keys ---------------------------------------------------

/**
 * Make a person known to the scenario. Where the operator API is on, the operator issues them
 * a personal token, which costs none of the address's sign-in budget (scenarios share a server
 * and an address); otherwise they sign in the way `world.person` does.
 */
export async function ensurePerson(world: World, name: string): Promise<Credential> {
  const known = world.people.get(name)
  if (known) return known
  if (!world.stack.env.OPERATOR_TOKEN) return world.person(name)
  const response = await fetch(`${world.url}/api/v1/admin/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ email: world.email(name) }),
  })
  const reply = await toReply(response)
  if (reply.status !== 201) throw new Error(`Could not create ${name}: ${reply.text}`)
  const { user, token } = reply.body as { user: { id: string }; token: { key: string } }
  const credential: Credential = { kind: "key", key: token.key }
  world.people.set(name, credential)
  world.things.set(`person:${name}`, { id: user.id, token: token.key })
  return credential
}

/** A browser session for a person, as the dashboard would hold after they sign in. */
export async function dashboardSession(world: World, name: string): Promise<string> {
  const credential = await ensurePerson(world, name)
  if (credential.kind === "session") return credential.cookie
  if (credential.kind !== "key") throw new Error(`${name} has no credential`)
  const response = await fetch(`${world.url}/auth/token-login`, {
    method: "POST",
    headers: { "x-mockingbird-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ token: credential.key }),
  })
  const cookie = response.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error(`No session for ${name}: HTTP ${response.status}`)
  return cookie
}

/** The person's own organization and its first project, created the first time they are needed. */
export async function ensureOrg(world: World, person: string): Promise<{ id: string }> {
  await ensurePerson(world, person)
  const known = world.things.get(`org:${person}`)
  if (known) return known as { id: string }
  const org = await world.must<{ id: string }>(person, "POST", "/orgs", {
    name: `${person}'s organization`,
  })
  world.things.set(`org:${person}`, org)
  return org
}
export const orgOf = (world: World, person: string) => world.thing<{ id: string }>(`org:${person}`)

export async function ensureProject(world: World, person: string): Promise<{ id: string }> {
  const known = world.things.get(`project:${person}`)
  if (known) return known as { id: string }
  const org = await ensureOrg(world, person)
  const project = await world.must<{ id: string }>(person, "POST", `/orgs/${org.id}/projects`, {
    name: "Web",
  })
  world.things.set(`project:${person}`, project)
  return project
}

export async function createFleet(
  world: World,
  person: string,
  name: string,
  input: { access?: string; emulators: Record<string, EmulatorInput> },
): Promise<FleetView> {
  const project = await ensureProject(world, person)
  const fleet = await world.must<FleetView>(person, "POST", `/projects/${project.id}/fleets`, {
    name,
    slug: world.slug(name),
    access: input.access ?? "open",
    emulators: input.emulators,
  })
  world.things.set(name, { ...fleet, owner: person })
  world.things.set("@fleet", { name })
  return fleet
}

export const fleetOf = (world: World, name: string) =>
  world.thing<FleetView & { owner: string }>(name)
/** The fleet the scenario mentioned last, for steps that say "the fleet" or "the emulator". */
export const currentFleet = (world: World) =>
  fleetOf(world, world.thing<{ name: string }>("@fleet").name)
/** The only emulator of a fleet, for steps that do not name one. */
export const soleEmulator = (fleet: FleetView) => Object.keys(fleet.emulators)[0] ?? "resend"

/**
 * The Mockingbird credential a feature describes in words ("a viewer key", "no key", "a key from
 * another organization", …) as the request headers that present it to a fleet.
 */
export async function presenting(
  world: World,
  fleetName: string,
  description: string,
): Promise<Record<string, string>> {
  const fleet = fleetOf(world, fleetName)
  const cached = world.things.get(`key:${fleetName}:${description}`) as
    | { headers: Record<string, string> }
    | undefined
  if (cached) return cached.headers
  const orgKey = async (person: string, orgId: string, body: Record<string, unknown>) =>
    (
      await world.must<{ key: string }>(person, "POST", `/orgs/${orgId}/api-keys`, {
        name: `${description} ${Math.random().toString(36).slice(2, 8)}`.slice(0, 80),
        ...body,
      })
    ).key
  const header = (key: string) => ({ "x-mockingbird-api-key": key })
  let headers: Record<string, string>
  switch (description) {
    case "no key":
      headers = {}
      break
    case "a viewer key":
    case "a member key":
    case "an admin key": {
      const role = description.split(" ")[1] as string
      headers = header(await orgKey(fleet.owner, fleet.orgId, { role }))
      break
    }
    case "a key for the fleet's project":
      headers = header(await orgKey(fleet.owner, fleet.orgId, { projectId: fleet.projectId }))
      break
    case "a key for another project": {
      const other = await world.must<{ id: string }>(
        fleet.owner,
        "POST",
        `/orgs/${fleet.orgId}/projects`,
        { name: "Another project" },
      )
      headers = header(await orgKey(fleet.owner, fleet.orgId, { projectId: other.id }))
      break
    }
    case "a key from another organization": {
      const stranger = `Stranger${fleetName.replace(/\W/g, "")}`
      const org = await ensureOrg(world, stranger)
      headers = header(await orgKey(stranger, org.id, { role: "admin" }))
      break
    }
    case "an unknown key": {
      // Well formed, but never issued: a real key with its secret half replaced.
      const real = await orgKey(fleet.owner, fleet.orgId, { role: "member" })
      headers = header(`${real.slice(0, -43)}${"A".repeat(43)}`)
      break
    }
    case "a malformed key":
      headers = header("mbf_o_not-a-key")
      break
    case "only a dashboard session":
      headers = { cookie: await dashboardSession(world, fleet.owner), "x-mockingbird-csrf": "1" }
      break
    case "a member key in the vendor's Authorization header":
      headers = {
        authorization: `Bearer ${await orgKey(fleet.owner, fleet.orgId, { role: "member" })}`,
      }
      break
    default:
      throw new Error(`No credential is described as "${description}"`)
  }
  world.things.set(`key:${fleetName}:${description}`, { headers })
  return headers
}

// ---- the Resend emulator -------------------------------------------------------------------

export const RESEND_KEY = { authorization: "Bearer re_spec_key" }
export const STRIPE_KEY = { authorization: "Bearer sk_test_spec" }

type Via = {
  emulator?: string
  namespace?: string
  headers?: Record<string, string>
  /** Origin of the replica to call; the scenario's main server when absent. */
  base?: string
  html?: string
}

/** Send an email the way the Resend SDK would. Remembers it as "the email" when accepted. */
export async function sendEmail(world: World, fleetName: string, via: Via = {}): Promise<Reply> {
  const fleet = fleetOf(world, fleetName)
  const emulator = via.emulator ?? soleEmulator(fleet)
  const reply = await world.emulator(fleet.slug, emulator, "POST", "/emails", {
    // A header given as "" is left out, which is how a caller omits the vendor's key.
    headers: Object.fromEntries(
      Object.entries({
        ...RESEND_KEY,
        ...(via.namespace ? { "x-mockingbird-namespace": via.namespace } : {}),
        ...via.headers,
      }).filter(([, value]) => value !== ""),
    ),
    body: {
      from: "sender@example.test",
      to: "receiver@example.test",
      subject: "Hello",
      html: via.html ?? "<p>Hello</p>",
    },
    ...(via.base ? { base: via.base } : {}),
  })
  const id = (reply.body as { id?: unknown } | undefined)?.id
  if (reply.status === 200 && typeof id === "string") {
    const email: SentEmail = {
      id,
      fleet: fleetName,
      emulator,
      ...(via.namespace ? { namespace: via.namespace } : {}),
    }
    world.things.set("@email", email)
    const all = (world.things.get("@emails") as { list: SentEmail[] } | undefined)?.list ?? []
    world.things.set("@emails", { list: [...all, email] })
  }
  return reply
}

export const theEmail = (world: World) => world.thing<SentEmail>("@email")
export const allEmails = (world: World) => world.thing<{ list: SentEmail[] }>("@emails").list

/**
 * Read an email back the way the Resend SDK would; by default the last one sent, from where it
 * was sent. `namespace: null` reads without a namespace.
 */
export async function readEmail(
  world: World,
  via: Omit<Via, "namespace"> & {
    namespace?: string | null
    fleet?: string
    email?: SentEmail
  } = {},
): Promise<Reply> {
  const email = via.email ?? theEmail(world)
  const fleet = fleetOf(world, via.fleet ?? email.fleet)
  const namespace = via.namespace === null ? undefined : (via.namespace ?? email.namespace)
  const emulator = via.emulator ?? (via.fleet ? soleEmulator(fleet) : email.emulator)
  return world.emulator(fleet.slug, emulator, "GET", `/emails/${email.id}`, {
    headers: {
      ...RESEND_KEY,
      ...(namespace ? { "x-mockingbird-namespace": namespace } : {}),
      ...via.headers,
    },
    ...(via.base ? { base: via.base } : {}),
  })
}

/** An HTML body that does not compress, to grow an emulator's stored state by about `bytes`. */
export const incompressible = (bytes: number) => {
  let text = ""
  while (text.length < bytes * 2) text += Math.random().toString(16).slice(2)
  return text
}

// ---- object storage ------------------------------------------------------------------------

export const storagePrefix = (world: World) =>
  `${(world.stack.env.S3_PREFIX ?? "mockingbird-fleet").replace(/^\/+|\/+$/g, "")}/`

/** Every key in the bucket, read straight from the object store. */
export async function storedKeys(world: World): Promise<string[]> {
  const response = await fetch(`${world.stack.s3Url}/${S3_BUCKET}?list-type=2&max-keys=1000`)
  const xml = await response.text()
  if (!response.ok || /<IsTruncated>true</.test(xml))
    throw new Error(`Could not list the bucket: HTTP ${response.status} ${xml.slice(0, 300)}`)
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1] as string)
}

export const fleetKeyPrefix = (world: World, fleet: FleetView, emulator?: string) =>
  `${storagePrefix(world)}fleets/${fleet.id}/${emulator ? `${emulator}/` : ""}`

export async function storedKeysOf(world: World, fleet: FleetView, emulator?: string) {
  const prefix = fleetKeyPrefix(world, fleet, emulator)
  return (await storedKeys(world)).filter((key) => key.startsWith(prefix))
}

/** The stored state of an emulator as text, or `undefined` when nothing is stored for it. */
export async function storedState(
  world: World,
  fleet: FleetView,
  emulator: string,
): Promise<{ text: string; bytes: number } | undefined> {
  const key = `${fleetKeyPrefix(world, fleet, emulator)}state.json.gz`
  const response = await fetch(`${world.stack.s3Url}/${S3_BUCKET}/${key}`)
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Could not read ${key}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  return { text: gunzipSync(bytes).toString("utf8"), bytes: bytes.length }
}

// ---- replicas ------------------------------------------------------------------------------

export async function secondReplica(world: World): Promise<Server> {
  const known = world.things.get("@replica") as { server: Server } | undefined
  if (known) return known.server
  const server = await world.stack.replica()
  world.things.set("@replica", { server })
  return server
}
/** Origins of the scenario's replicas: the main server first. */
export const replicaUrls = async (world: World) => [world.url, (await secondReplica(world)).url]

// ---- hosts and client addresses ------------------------------------------------------------

/**
 * A request to the server that names another host, as a browser or SDK would after DNS points
 * two hostnames at one container. (`fetch` does not allow setting `Host`.)
 */
export function onHost(
  world: World,
  host: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: world.stack.server.port,
        path,
        method: options.method ?? "GET",
        headers: { ...options.headers, host },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let body: unknown = text
          try {
            body = JSON.parse(text)
          } catch {}
          const headers = new Headers()
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(", ") : value)
          const reply = { status: response.statusCode ?? 0, headers, body, text }
          world.last = reply
          resolve(reply)
        })
      },
    )
    request.on("error", reject)
    request.end(options.body)
  })
}
/**
 * Begin a POST that declares a body of `bytes` and wait for the server's verdict. A server that
 * caps bodies answers from the declared length alone and closes the connection, so the body is
 * only sent as far as the server will take it.
 */
export function announceBody(world: World, path: string, bytes: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let answered = false
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: world.stack.server.port,
        path,
        method: "POST",
        headers: {
          host: new URL(world.url).host,
          "content-type": "application/json",
          "content-length": String(bytes),
          ...RESEND_KEY,
        },
      },
      (response) => {
        answered = true
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        const finish = () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let body: unknown = text
          try {
            body = JSON.parse(text)
          } catch {}
          world.last = { status: response.statusCode ?? 0, headers: new Headers(), body, text }
          request.destroy()
          resolve(world.last)
        }
        response.on("end", finish)
        response.on("close", finish)
      },
    )
    // Once the verdict is in, the server hanging up on the unsent body is expected.
    request.on("error", (error) => {
      if (!answered) reject(error)
    })
    const chunk = Buffer.alloc(64 * 1024, "a")
    let sent = 0
    const pump = () => {
      while (!answered && !request.destroyed && sent < bytes) {
        sent += chunk.length
        if (!request.write(chunk)) return void request.once("drain", pump)
      }
      if (!answered && !request.destroyed) request.end()
    }
    request.flushHeaders()
    setTimeout(pump, 200)
  })
}
export const dashboardHost = (world: World) => new URL(world.url).host

/** The header a chain of proxies would add for a client: `client, proxy, proxy…`. */
export const forwardedFor = (chain: string) => ({ "x-forwarded-for": chain })

// ---- rate limits ---------------------------------------------------------------------------

/**
 * Repeat a call until the server refuses one with 429, a few at a time so the budget is spent
 * faster than it refills. Returns the first refusal (also left in `world.last`) and how many
 * calls were served before it.
 */
export async function untilRefused(
  world: World,
  call: () => Promise<Reply>,
  options: {
    atMost?: number
    atOnce?: number
    /** What a call answers while there is budget left. Default: any success. */
    expected?: (reply: Reply) => boolean
  } = {},
): Promise<{ refusal: Reply; served: number }> {
  const atMost = options.atMost ?? 400
  const atOnce = options.atOnce ?? 15
  const expected = options.expected ?? ((reply: Reply) => reply.status < 300)
  let served = 0
  for (let sent = 0; sent < atMost; sent += atOnce) {
    const replies = await Promise.all(Array.from({ length: atOnce }, () => call()))
    const refusal = replies.find((reply) => reply.status === 429)
    served += replies.filter(expected).length
    const unexpected = replies.find((reply) => reply.status !== 429 && !expected(reply))
    if (unexpected) throw new Error(`Unexpected HTTP ${unexpected.status}: ${unexpected.text}`)
    if (refusal) {
      world.last = refusal
      return { refusal, served }
    }
  }
  throw new Error(`Still served after ${atMost} calls; the limit never applied`)
}

/** Seconds the last refusal asked the caller to wait. */
export function retryAfter(reply: Reply | undefined): number {
  const seconds = Number(reply?.headers.get("retry-after"))
  if (!Number.isInteger(seconds) || seconds < 1)
    throw new Error(`No usable Retry-After on HTTP ${reply?.status}: ${reply?.text}`)
  return seconds
}
