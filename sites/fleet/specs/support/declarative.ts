/**
 * Helpers for the declarative-configuration specs (`specs/features/declarative`): a repository
 * directory holding a `mockingbird.yaml`, applying it to Fleet Cloud, and running the published
 * `mockingbird-fleet` CLI as a real process, both against Fleet Cloud (`plan`, `apply`) and as a
 * local fleet (`serve`).
 *
 * Scenarios share one server, so a feature writes `<acme>` where it means a slug and reads back
 * `acme`: {@link fill} makes the slug unique to the scenario and {@link plain} undoes that in
 * whatever the system answers.
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { FleetView } from "./fleets.js"
import { PACKAGE_ROOT, REPO_ROOT } from "./stack.js"
import type { Credential, Reply, World } from "./world.js"

export type Change = { action: string; kind: string; name: string; detail?: string }
export type ApplyResult = { organization: string | null; applied: boolean; changes: Change[] }
export type OrgView = {
  id: string
  slug: string
  name: string
  role: string
  managed: { appliedAt: string; appliedBy: string } | null
}
export type ProjectView = { id: string; slug: string; name: string }
export type Exported = {
  managed: { appliedAt: string; appliedBy: string } | null
  declaration: Record<string, unknown>
  yaml: string
}

/** What a finished (or, for `serve`, ready) run of the CLI showed. */
export type CliRun = {
  /** The exit code, or undefined while a local fleet is still running. */
  code: number | undefined
  stdout: string
  stderr: string
  /** The readiness record `serve --ready-json` printed, when the fleet came up. */
  ready?: LocalFleet
}
export type LocalFleet = {
  state: string
  services: Record<string, { protocol: string; url: string }>
}

type State = {
  /** The person the scenario named last: who "she" and "he" are. */
  actor?: string
  /** The scenario's repository: a directory of its own, where the CLI is run. */
  dir: string
  /** `mockingbird.yaml` as it is on disk now. */
  file?: string
  /** The file as it was when it last applied cleanly. */
  applied?: { yaml: string; by: string }
  run?: CliRun
  exported?: Exported
  /** The port a file asked for with `<a-free-port>`. */
  port?: number
  /** Local fleets still running, stopped when the scenario ends. */
  processes: { stop(): Promise<number> }[]
}

const states = new WeakMap<World, State>()

export function state(world: World): State {
  let found = states.get(world)
  if (!found) {
    found = { dir: join(PACKAGE_ROOT, ".tmp/spec-declarative", world.tag), processes: [] }
    mkdirSync(found.dir, { recursive: true })
    states.set(world, found)
  }
  return found
}

/** Stop the scenario's local fleets and remove its repository. */
export async function cleanup(world: World): Promise<void> {
  const found = states.get(world)
  if (!found) return
  await Promise.all(found.processes.map((process) => process.stop()))
  rmSync(found.dir, { recursive: true, force: true })
  states.delete(world)
}

// ---- names ---------------------------------------------------------------------------------

/** Step patterns: a person by name or pronoun, a key, or nobody. */
export const ACTOR = '(she|he|[A-Z]\\w*|the key "[^"]+"|an anonymous caller)'
export const PERSON = "([A-Z]\\w*)"

/**
 * Who a step means: a pronoun is the person named last, `the key "ci"` is that key, and anyone
 * else is a person, who becomes the one later pronouns refer to.
 */
export function actor(world: World, words: string): string {
  const own = state(world)
  if (words === "an anonymous caller") return "anonymous"
  const key = /^the key "(.+)"$/.exec(words)?.[1]
  if (key) return key
  if (words === "she" || words === "he") {
    if (!own.actor) throw new Error(`The scenario says "${words}" before naming anyone`)
    return own.actor
  }
  own.actor = words
  return words
}

/** A port nothing listens on, chosen once per scenario: what `<a-free-port>` stands for. */
export function chosenPort(world: World): number {
  const own = state(world)
  if (own.port === undefined) {
    const run = spawnSync(
      "node",
      [
        "-e",
        'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close() })',
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      },
    )
    own.port = Number(run.stdout.trim())
    if (!Number.isInteger(own.port) || own.port <= 0)
      throw new Error(`Could not find a free port: ${run.stderr}`)
  }
  return own.port
}

/**
 * Replace each `<name>` with a slug unique to this scenario, and `<a-free-port>` with a port
 * nothing listens on.
 */
export const fill = (world: World, text: string) =>
  text.replace(/<([a-z][a-z0-9-]*)>/g, (_, name: string) =>
    name === "a-free-port" ? String(chosenPort(world)) : world.slug(name),
  )

/** The inverse of {@link fill}, for anything the system says: slugs and emails as the feature wrote them. */
export const plain = (world: World, text: string) =>
  text
    .replaceAll(`-${world.tag}`, "")
    .replaceAll(`.${world.tag}@`, "@")
    .replaceAll(world.url, "https://fleet.example")

/** "stripe and resend", "stripe, mail and resend" or "nothing" as a list of names. */
export const listed = (words: string) =>
  words === "nothing" || words === "no emulators"
    ? []
    : words
        .split(/,\s*|\s+and\s+/)
        .map((word) => word.trim())
        .filter(Boolean)

// ---- the file ------------------------------------------------------------------------------

export const FILE_NAME = "mockingbird.yaml"

/** Put a file in the scenario's repository. Returns its content after {@link fill}. */
export function writeRepositoryFile(world: World, name: string, content: string): string {
  const text = fill(world, content)
  mkdirSync(dirname(join(state(world).dir, name)), { recursive: true })
  writeFileSync(join(state(world).dir, name), text.endsWith("\n") ? text : `${text}\n`)
  return text
}

export function writeDeclaration(world: World, yaml: string): string {
  const own = state(world)
  own.file = writeRepositoryFile(world, FILE_NAME, yaml)
  return own.file
}

export function theFile(world: World): string {
  const { file } = state(world)
  if (file === undefined) throw new Error("The scenario's repository holds no mockingbird.yaml")
  return file
}

/** Edit the file in place; fails when the text to replace is not in it. */
export function editDeclaration(world: World, from: string, to: string): string {
  const before = theFile(world)
  const [old, next] = [fill(world, from), fill(world, to)]
  if (!before.includes(old)) throw new Error(`The file does not contain "${old}":\n${before}`)
  return writeDeclaration(world, before.replace(old, next.replaceAll("\\n", "\n")))
}

// ---- Fleet Cloud ---------------------------------------------------------------------------

const credentialOf = async (world: World, who: string): Promise<Credential> =>
  who === "anonymous" ? { kind: "anonymous" } : (world.people.get(who) ?? world.person(who))

const authHeaders = (credential: Credential): Record<string, string> =>
  credential.kind === "session"
    ? { cookie: credential.cookie, "x-mockingbird-csrf": "1" }
    : credential.kind === "key"
      ? { authorization: `Bearer ${credential.key}` }
      : {}

export type ApplyOptions = { dryRun?: boolean; prune?: boolean; json?: boolean }

/**
 * Send a file to `PUT /api/v1/manifest` exactly as `curl --data-binary @mockingbird.yaml` would
 * (or, with `json`, as the JSON document the CLI sends). When it applies, the organization and
 * its fleets become known to the scenario by the names the feature uses.
 */
export async function sendFile(
  world: World,
  who: string,
  yaml: string,
  options: ApplyOptions = {},
): Promise<Reply> {
  const query = new URLSearchParams({
    ...(options.dryRun ? { dryRun: "true" } : {}),
    ...(options.prune ? { prune: "true" } : {}),
  })
  const response = await fetch(`${world.url}/api/v1/manifest?${query}`, {
    method: "PUT",
    headers: {
      ...authHeaders(await credentialOf(world, who)),
      "content-type": options.json ? "application/json" : "application/yaml",
    },
    body: options.json ? JSON.stringify(parseYaml(yaml)) : yaml,
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  const reply: Reply = { status: response.status, headers: response.headers, body, text }
  const result = body as Partial<ApplyResult>
  if (reply.status === 200 && result.applied && result.organization) {
    state(world).applied = { yaml, by: who }
    await remember(world, who, result.organization)
  }
  world.last = reply
  return reply
}

/** Parse YAML with Bun, which is what the server reads it with. */
export function parseYaml(yaml: string): unknown {
  const run = spawnSync(
    "bun",
    ["-e", "console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))"],
    { input: yaml, encoding: "utf8" },
  )
  if (run.status !== 0) throw new Error(`Not valid YAML:\n${yaml}\n${run.stderr}`)
  return JSON.parse(run.stdout)
}

/**
 * Learn an organization as it is now: the organization, its projects and its fleets are stored
 * under the names the feature uses (`acme`, `web`, `acme-staging`), in the shape the tenancy and
 * fleet steps expect, so their steps work on declared things too. Each is also known by the
 * name it shows (`Acme`, `Web app`, `Staging`), which is how the dashboard's steps ask for it.
 * Things that are gone stay known as they last were, which is how a scenario asks after a
 * deleted fleet's stored state.
 */
export async function remember(world: World, who: string, orgId: string): Promise<void> {
  const last = world.last
  const org = await world.must<OrgView>(who, "GET", `/orgs/${orgId}`)
  world.things.set(plain(world, org.slug), org)
  world.things.set(org.name, org)
  const person = state(world).actor ?? who
  world.things.set(`org:${person}`, org)
  const projects = await world.must<{ data: ProjectView[] }>(who, "GET", `/orgs/${orgId}/projects`)
  for (const project of projects.data) {
    world.things.set(plain(world, project.slug), project)
    world.things.set(project.name, project)
    const fleets = await world.must<{ data: FleetView[] }>(
      who,
      "GET",
      `/projects/${project.id}/fleets`,
    )
    for (const fleet of fleets.data) {
      world.things.set(plain(world, fleet.slug), { ...fleet, owner: person })
      world.things.set(fleet.name, { ...fleet, owner: person })
    }
  }
  world.last = last
}

export const orgNamed = (world: World, name: string) => world.thing<OrgView>(name)

/** A fleet as it is right now, by the slug the feature uses. */
export async function fleetNow(world: World, name: string): Promise<FleetView> {
  const known = world.thing<FleetView & { owner: string }>(name)
  const last = world.last
  const fleet = await world.must<FleetView>(known.owner, "GET", `/fleets/${known.id}`)
  world.last = last
  return fleet
}

export async function orgNow(world: World, who: string, name: string): Promise<OrgView> {
  const last = world.last
  const org = await world.must<OrgView>(who, "GET", `/orgs/${orgNamed(world, name).id}`)
  world.last = last
  return org
}

/** The changes a reply reports, without the things that stay as they are. */
export function changesOf(world: World, reply: Reply | undefined): Change[] {
  if (!reply) throw new Error("Nothing has been applied or planned yet")
  const { changes } = reply.body as Partial<ApplyResult>
  if (!Array.isArray(changes)) throw new Error(`The reply reports no changes: ${reply.text}`)
  return changes
    .filter((change) => change.action !== "unchanged")
    .map((change) => ({
      action: change.action,
      kind: change.kind,
      name: plain(world, change.name),
      detail: plain(world, change.detail ?? ""),
    }))
}

// ---- the CLI -------------------------------------------------------------------------------

export const CLI = join(REPO_ROOT, "packages/adapters/fleet/dist/cli.js")

/** A personal token for a person, made once: what they would export as MOCKINGBIRD_FLEET_TOKEN. */
export async function tokenOf(world: World, who: string): Promise<string> {
  const credential = await credentialOf(world, who)
  if (credential.kind === "key") return credential.key
  const known = world.things.get(`token:${who}`) as { key: string } | undefined
  if (known) return known.key
  const last = world.last
  const token = await world.must<{ key: string }>(who, "POST", "/tokens", { name: "laptop" })
  world.last = last
  world.things.set(`token:${who}`, token)
  return token.key
}

/** `plan --file x.yaml` as the argument list a shell would pass. */
const words = (command: string) => command.split(/\s+/).filter(Boolean)

/**
 * Run `mockingbird-fleet <command>` in the scenario's repository, as a separate Node process
 * with only the environment given. `plan` and `apply` run to completion.
 */
export function runCli(world: World, command: string, env: Record<string, string>): CliRun {
  const own = state(world)
  const run = spawnSync("node", [CLI, ...words(fill(world, command))], {
    cwd: own.dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    timeout: 30_000,
  })
  own.run = { code: run.status ?? -1, stdout: run.stdout, stderr: run.stderr }
  return own.run
}

/**
 * Run `mockingbird-fleet serve …` in the scenario's repository until it prints its readiness
 * record or exits, whichever comes first. The emulator packages are the ones installed for
 * this package, and the fleet is stopped when the scenario ends.
 */
export async function serveLocally(world: World, command: string): Promise<CliRun> {
  const own = state(world)
  let stdout = ""
  let stderr = ""
  const child = spawn(
    "node",
    [CLI, ...words(fill(world, command)), "--project-root", PACKAGE_ROOT, "--ready-json"],
    {
      cwd: own.dir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  child.stdout?.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk
  })
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)))
  own.processes.push({
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      return exited
    },
  })
  const ready = (): LocalFleet | undefined => {
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue
      try {
        return JSON.parse(line) as LocalFleet
      } catch {}
    }
    return undefined
  }
  const deadline = Date.now() + 30_000
  while (!ready() && child.exitCode === null && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  if (child.exitCode !== null) await exited
  const record = ready()
  own.run = {
    code: child.exitCode ?? undefined,
    stdout,
    stderr,
    ...(record ? { ready: record } : {}),
  }
  if (!record && own.run.code === undefined)
    throw new Error(`The local fleet neither became ready nor exited:\n${stdout}\n${stderr}`)
  return own.run
}

export function lastRun(world: World): CliRun {
  const { run } = state(world)
  if (!run) throw new Error("The CLI has not been run yet")
  return run
}

/** The local fleet the scenario started; fails with the CLI's output when it did not come up. */
export function localFleet(world: World): LocalFleet {
  const run = lastRun(world)
  if (!run.ready)
    throw new Error(`No local fleet is running (exit ${run.code}):\n${run.stdout}\n${run.stderr}`)
  return run.ready
}

export function localService(world: World, name: string) {
  const fleet = localFleet(world)
  const service = fleet.services[name]
  if (!service)
    throw new Error(
      `The local fleet has no service "${name}"; it runs ${Object.keys(fleet.services).join(", ")}`,
    )
  return service
}

// ---- vendor calls --------------------------------------------------------------------------

export const VENDORS = {
  /** The Resend SDK sending an email. */
  Resend: (base: string) =>
    fetch(`${base}/emails`, {
      method: "POST",
      headers: { authorization: "Bearer re_spec_key", "content-type": "application/json" },
      body: JSON.stringify({
        from: "sender@example.test",
        to: "receiver@example.test",
        subject: "Hello",
        html: "<p>Hello</p>",
      }),
    }),
  /** The Stripe SDK creating a customer. */
  Stripe: (base: string) =>
    fetch(`${base}/v1/customers`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_spec",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "email=customer%40example.test",
    }),
} as const
export type Vendor = keyof typeof VENDORS

/** Make a vendor's call against an emulator's base URL; the id of what it created, or the failure. */
export async function vendorCall(vendor: Vendor, base: string) {
  const response = await VENDORS[vendor](base.replace(/\/+$/, ""))
  const text = await response.text()
  let id: unknown
  try {
    id = (JSON.parse(text) as { id?: unknown }).id
  } catch {}
  return { status: response.status, id, text }
}

/** Run one statement against a PostgreSQL URL, with Bun's own driver. */
export function queryPostgres(url: string, statement: string): unknown[] {
  const run = spawnSync(
    "bun",
    [
      "-e",
      `import { SQL } from "bun"
const sql = new SQL(process.env.SPEC_DATABASE_URL)
console.log(JSON.stringify(await sql.unsafe(process.env.SPEC_SQL)))
await sql.close()`,
    ],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SPEC_DATABASE_URL: url,
        SPEC_SQL: statement,
      },
    },
  )
  if (run.status !== 0) throw new Error(`Could not query ${url}: ${run.stderr}`)
  return JSON.parse(run.stdout.trim().split("\n").pop() ?? "[]") as unknown[]
}

/**
 * The operations the server refuses by hand in a managed organization. The set lives in the
 * server's source, which is written for Bun, so Bun reads it.
 */
export function declaredOperations(): string[] {
  const run = spawnSync(
    "bun",
    [
      "-e",
      'import { DECLARED_OPERATIONS } from "./src/api.ts"; console.log(JSON.stringify([...DECLARED_OPERATIONS]))',
    ],
    { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 30_000 },
  )
  if (run.status !== 0) throw new Error(`Could not read DECLARED_OPERATIONS: ${run.stderr}`)
  return JSON.parse(run.stdout.trim().split("\n").pop() ?? "[]") as string[]
}
