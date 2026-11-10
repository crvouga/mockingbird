/**
 * Helpers for the self-hosting, startup, sign-in and observability features: extra emulators in
 * server mode (a password-protected PostgreSQL, an object store of your own, an OpenID Connect
 * provider), the collector's query API, and the state one hosting scenario keeps.
 *
 * Every dependency here is a Mockingbird emulator running as its own process, with one exception:
 * no emulator speaks the HashiCorp Vault KV v2 HTTP API, so {@link startVaultStub} is a few lines
 * of `node:http`.
 */
import { createServer as createHttpServer } from "node:http"
import { connect, createServer as createTcpServer, type Socket } from "node:net"
import { join } from "node:path"
import {
  type Emulators,
  freePort,
  OPERATOR_TOKEN,
  type Process,
  REPO_ROOT,
  runServer,
  S3_BUCKET,
  serverEnv,
  start,
} from "./stack.js"
import type { World } from "./world.js"

const cli = (name: string, file = "cli.js") =>
  join(REPO_ROOT, "packages/service", name, "dist", file)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `probe` is true; fails with the process output when it exits or never gets there. */
export async function waitUntil(
  probe: () => Promise<boolean> | boolean,
  what: string,
  process?: Process,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Promise.resolve(probe()).catch(() => false)) return
    if (process && process.child.exitCode !== null)
      throw new Error(`${what} exited early:\n${process.output()}`)
    await sleep(50)
  }
  throw new Error(`${what} did not become ready:\n${process?.output() ?? ""}`)
}

// ---- PostgreSQL ---------------------------------------------------------------------------

export type PostgresEmulator = {
  /** postgres:// URL with the right user, password and database. */
  url: string
  port: number
  stop(): Promise<void>
}

/**
 * A PostgreSQL wire-protocol emulator of your own, on a free port, holding one empty database.
 * It checks the password, knows only the database named here (others fail with 3D000) and offers
 * no TLS, so `?sslmode=require` fails the handshake.
 */
export async function startPostgresEmulator(
  options: { user?: string; password?: string; database?: string } = {},
): Promise<PostgresEmulator> {
  const { user = "fleet", password = "fleet", database = "fleet" } = options
  const port = await freePort()
  const url = `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`
  const process = start("bun", [
    cli("postgres", "wire/cli.js"),
    "serve",
    url,
    "--port",
    String(port),
    "--password",
    password,
  ])
  await waitUntil(() => process.output().includes("listening"), "PostgreSQL emulator", process)
  return { url, port, stop: async () => void (await process.stop("SIGKILL")) }
}

/** Run one SQL statement against a PostgreSQL URL (through Bun's driver, as the server does). */
export async function queryDatabase<T = Record<string, unknown>>(
  url: string,
  sql: string,
): Promise<T[]> {
  const script =
    'import { SQL } from "bun"; const sql = new SQL(process.env.QUERY_URL, { max: 1 });' +
    "const rows = await sql.unsafe(process.env.QUERY_SQL);" +
    'console.log("ROWS" + JSON.stringify(rows)); await sql.close()'
  const process = start("bun", ["-e", script], { QUERY_URL: url, QUERY_SQL: sql })
  const code = await process.exited
  const line = process
    .output()
    .split("\n")
    .find((candidate) => candidate.startsWith("ROWS"))
  if (code !== 0 || !line) throw new Error(`Query failed: ${sql}\n${process.output()}`)
  return JSON.parse(line.slice(4)) as T[]
}

// ---- Object store -------------------------------------------------------------------------

export type S3Emulator = {
  url: string
  /** Make every request fail the way a named S3 error does (the emulator's fault injection). */
  failWith(code: string, status: number): Promise<void>
  /** Keys currently stored in a bucket under a prefix. */
  keys(bucket: string, prefix: string): Promise<string[]>
  stop(): Promise<void>
}

/** List keys of a bucket on any S3 emulator (ListObjectsV2, unsigned: the emulator is lenient). */
export async function listKeys(s3Url: string, bucket: string, prefix: string): Promise<string[]> {
  const response = await fetch(
    `${s3Url}/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`,
  )
  if (!response.ok) throw new Error(`Listing ${bucket}/${prefix} failed: HTTP ${response.status}`)
  return [...(await response.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(
    (match) => match[1] ?? "",
  )
}

/** An S3 emulator of your own. `bucket: null` leaves it without any bucket. */
export async function startS3Emulator(
  options: { bucket?: string | null } = {},
): Promise<S3Emulator> {
  const bucket = options.bucket === undefined ? S3_BUCKET : options.bucket
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const process = start("bun", [cli("s3"), "serve", "--port", String(port), "--log", "off"])
  await waitUntil(async () => (await fetch(`${url}/__admin/health`)).ok, "S3 emulator", process)
  if (bucket) {
    const created = await fetch(`${url}/${bucket}`, { method: "PUT" })
    if (!created.ok) throw new Error(`Could not create bucket ${bucket}: HTTP ${created.status}`)
  }
  return {
    url,
    async failWith(code, status) {
      const response = await fetch(`${url}/__admin/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          body: `<Error><Code>${code}</Code><Message>${code}</Message></Error>`,
          headers: { "content-type": "application/xml" },
        }),
      })
      if (!response.ok) throw new Error(`Fault injection failed: ${await response.text()}`)
    },
    keys: (name, prefix) => listKeys(url, name, prefix),
    stop: async () => void (await process.stop("SIGKILL")),
  }
}

// ---- OpenID Connect provider --------------------------------------------------------------

export type OidcAccount = { id: string; email: string; name?: string }

export type OidcProvider = {
  /** The issuer URL: the value for `OIDC_ISSUER`. Discovery, /authorize, /token and /jwks live under it. */
  issuer: string
  /** Register a public client (no secret, so S256 PKCE is mandatory) with its exact redirect URIs. */
  registerClient(clientId: string, redirectUris: string[]): Promise<void>
  /** Create or update a person the provider can sign in. `id` is the stable subject source. */
  seedAccount(account: OidcAccount): Promise<void>
  /**
   * Do what a person does in the provider's pages, over HTTP: open the authorization URL the app
   * redirected to, choose the account, and allow (or deny) access. Returns the URL the provider
   * sends the browser back to (the app's callback with `code` and `state`, or with `error`).
   */
  decide(authorizeUrl: string, accountId: string, decision?: "allow" | "deny"): Promise<string>
  /** Switch a named provider behaviour, e.g. `id_token_unknown_key` (GET /__admin/scenarios). */
  behave(preset: string): Promise<void>
  stop(): Promise<void>
}

/**
 * The `oauth` emulator in server mode with the generic `oidc` profile: a real OpenID Connect
 * provider (discovery, /authorize, /token, RS256 ID tokens and a JWKS) that accepts public
 * clients with S256 PKCE.
 */
export async function startOidcProvider(): Promise<OidcProvider> {
  const port = await freePort()
  const issuer = `http://127.0.0.1:${port}`
  const process = start("bun", [
    cli("oauth"),
    "serve",
    "--provider",
    "oidc",
    "--port",
    String(port),
    "--issuer",
    issuer,
    "--log",
    "off",
  ])
  await waitUntil(
    async () => (await fetch(`${issuer}/__admin/health`)).ok,
    "OIDC provider",
    process,
  )
  const admin = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${issuer}/__admin/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok)
      throw new Error(`OIDC provider ${method} ${path} failed: ${await response.text()}`)
  }
  const interact = (body: Record<string, string>) =>
    fetch(`${issuer}/interaction`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    })
  return {
    issuer,
    registerClient: (id, redirectUris) => admin("POST", "clients", { id, name: id, redirectUris }),
    seedAccount: (account) =>
      admin("POST", "accounts", { name: account.email, ...account, emailVerified: true }),
    async decide(authorizeUrl, accountId, decision = "allow") {
      const page = await fetch(authorizeUrl, { redirect: "manual" })
      const html = await page.text()
      const transaction = /name="transaction" value="([^"]+)"/.exec(html)?.[1]
      if (!transaction)
        throw new Error(`The provider did not show its sign-in page: HTTP ${page.status} ${html}`)
      if (decision === "allow") {
        const chosen = await interact({ transaction, action: "select", account: accountId })
        if (chosen.status !== 200)
          throw new Error(`Choosing ${accountId} failed: HTTP ${chosen.status}`)
        await chosen.text()
      }
      const done = await interact({ transaction, action: decision })
      const location = done.headers.get("location")
      if (!location)
        throw new Error(
          `The provider did not redirect back: HTTP ${done.status} ${await done.text()}`,
        )
      return location
    },
    behave: (preset) => admin("PUT", "behavior", { preset }),
    stop: async () => void (await process.stop("SIGKILL")),
  }
}

export type OidcSignIn = {
  /** The provider URL `/auth/login` redirected to, with the PKCE, state and nonce parameters. */
  authorize: URL
  /** The app URL the provider sent the browser back to. */
  callbackUrl: string
  /** The app's answer to that callback: a redirect with a session cookie, or an error. */
  status: number
  location: string | null
  /** `name=value` of the session cookie, when a session was started. */
  cookie: string | undefined
  setCookie: string | null
  text: string
}

/** `GET /auth/login` without following the redirect: where the app sends the browser. */
export async function beginOidcSignIn(serverUrl: string, returnTo?: string): Promise<URL> {
  const query = returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`
  const response = await fetch(`${serverUrl}/auth/login${query}`, { redirect: "manual" })
  const location = response.headers.get("location")
  if (response.status !== 302 || !location)
    throw new Error(
      `/auth/login did not redirect: HTTP ${response.status} ${await response.text()}`,
    )
  return new URL(location)
}

/** `GET` a callback URL on a server (by default the one the provider named), not following redirects. */
export async function finishOidcSignIn(
  callbackUrl: string,
  authorize: URL,
  serverUrl?: string,
): Promise<OidcSignIn> {
  const target = new URL(callbackUrl)
  const url = serverUrl ? `${serverUrl}${target.pathname}${target.search}` : callbackUrl
  const response = await fetch(url, { redirect: "manual" })
  const setCookie = response.headers.get("set-cookie")
  return {
    authorize,
    callbackUrl,
    status: response.status,
    location: response.headers.get("location"),
    cookie: setCookie?.split(";")[0],
    setCookie,
    text: await response.text(),
  }
}

/** The whole flow for one person: login redirect, approval at the provider, callback. */
export async function signInWithOidc(
  serverUrl: string,
  provider: OidcProvider,
  accountId: string,
  options: { returnTo?: string } = {},
): Promise<OidcSignIn> {
  const authorize = await beginOidcSignIn(serverUrl, options.returnTo)
  return finishOidcSignIn(await provider.decide(authorize.toString(), accountId), authorize)
}

// ---- Vault --------------------------------------------------------------------------------

export type VaultStub = {
  /** The value for `VAULT_ADDR`. */
  url: string
  /** KV v2 documents by `<project>/<config>`. */
  documents: Map<string, Record<string, unknown>>
  /** Tokens allowed to read. Any other token gets 403, as Vault answers. */
  tokens: Set<string>
  /** Answer this many reads with 503 first, as a sealed Vault does. */
  sealedFor: number
  /** Every read received: path and the `X-Vault-Token` it carried. */
  reads: { path: string; token: string | undefined }[]
  stop(): Promise<void>
}

/**
 * A stand-in for Vault's KV v2 read endpoint, `GET /v1/secret/data/<project>/<config>`.
 * Hand-written because no Mockingbird emulator speaks the Vault HTTP API.
 */
export async function startVaultStub(): Promise<VaultStub> {
  const stub: VaultStub = {
    url: "",
    documents: new Map(),
    tokens: new Set(),
    sealedFor: 0,
    reads: [],
    stop: async () => {},
  }
  const server = createHttpServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    const path = (request.url ?? "").split("?")[0] ?? ""
    const header = request.headers["x-vault-token"]
    const token = Array.isArray(header) ? header[0] : header
    stub.reads.push({ path, token })
    if (stub.sealedFor > 0) {
      stub.sealedFor--
      return reply(503, { errors: ["Vault is sealed"] })
    }
    if (!token || !stub.tokens.has(token)) return reply(403, { errors: ["permission denied"] })
    const document = stub.documents.get(decodeURIComponent(path.replace("/v1/secret/data/", "")))
    if (!path.startsWith("/v1/secret/data/") || !document) return reply(404, { errors: [] })
    return reply(200, { data: { data: document, metadata: { version: 1 } } })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  stub.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  stub.stop = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return stub
}

// ---- OTLP collector -----------------------------------------------------------------------

export type CollectorRow = Record<string, unknown>

export type Collector = {
  /** The value for `OTEL_EXPORTER_OTLP_ENDPOINT`: a namespace of the collector emulator. */
  endpoint: string
  spans(query?: Record<string, string>): Promise<CollectorRow[]>
  logs(query?: Record<string, string>): Promise<CollectorRow[]>
  /** Long-poll until a span (or log) matching `where` has arrived; fails after ~15 s. */
  waitFor(kind: "span" | "log", where: Record<string, unknown>): Promise<CollectorRow[]>
  /** How many `/v1/metrics` exports arrived, and how many metrics they carried. */
  metrics(): Promise<{ requests: number; metrics: number }>
  /** Require this bearer token on every export. */
  requireToken(token: string): Promise<void>
  /** Answer exports with 503 from now on (the emulator's fault injection). */
  breakDown(): Promise<void>
  /** Every OTLP export the collector answered, with its status. */
  exports(): Promise<{ path: string; status: number }[]>
}

/**
 * One isolated namespace of an OTLP collector emulator, so scenarios sharing a collector process
 * never see each other's telemetry. `otelUrl` is `stack.otelUrl`; without a namespace this is
 * the collector's default namespace, where a server pointed at `otelUrl` itself exports.
 */
export function collectorNamespace(otelUrl: string, namespace?: string): Collector {
  const endpoint = namespace ? `${otelUrl}/__admin/ns/${namespace}` : otelUrl
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${endpoint}/__admin/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const must = async (method: string, path: string, body?: unknown) => {
    const reply = await call(method, path, body)
    if (reply.status >= 300)
      throw new Error(
        `Collector ${method} ${path}: HTTP ${reply.status} ${JSON.stringify(reply.body)}`,
      )
    return reply.body
  }
  const search = (query: Record<string, string> = {}) => new URLSearchParams(query).toString()
  return {
    endpoint,
    spans: async (query) => (await must("GET", `spans?${search(query)}`)).spans as CollectorRow[],
    logs: async (query) => (await must("GET", `logs?${search(query)}`)).logs as CollectorRow[],
    async waitFor(kind, where) {
      const reply = await call("POST", "wait", { kind, where, timeoutMs: 15_000 })
      if (reply.status !== 200)
        throw new Error(
          `No ${kind} matching ${JSON.stringify(where)} reached the collector. It has: ${JSON.stringify(
            kind === "span" ? await this.spans() : await this.logs(),
          ).slice(0, 2000)}`,
        )
      return reply.body.matched as CollectorRow[]
    },
    metrics: async () =>
      (await must("GET", "otlp-metrics")) as { requests: number; metrics: number },
    requireToken: async (token) =>
      void (await must("PUT", "settings", { ingestAuth: "bearer", ingestTokens: [token] })),
    breakDown: async () => void (await must("POST", "faults", { status: 503 })),
    exports: async () =>
      ((await must("GET", "requests")).requests as { path: string; status: number }[]).filter(
        (request) => request.path.startsWith("/v1/"),
      ),
  }
}

// ---- One scenario's state -----------------------------------------------------------------

/** A run of the server process started without waiting for it to become ready. */
export type Run = {
  process: Process
  port: number
  /** `http://localhost:<port>`: where the process listens, whatever PUBLIC_URL says. */
  url: string
  /** The exit code, once the process has ended. */
  code: number | undefined
  /** Whether the port ever answered HTTP while the process was being watched. */
  answered: boolean
}

export type Hosting = {
  /** The environment the next server process gets. */
  env: Record<string, string>
  runs: Run[]
  /** Things to stop when the scenario ends, newest last. */
  cleanups: (() => Promise<unknown>)[]
  provider?: OidcProvider
  clientId?: string
  signIn?: OidcSignIn
  /** Earlier sign-ins and login redirects, for scenarios comparing two. */
  signIns: OidcSignIn[]
  redirects: URL[]
  vault?: VaultStub
  collector?: Collector
  postgres?: PostgresEmulator
  s3?: S3Emulator
  /** Session cookies by person, in the order they signed in. */
  cookies: Map<string, string[]>
  /** Named values a scenario remembers between steps (tokens, cookies, user ids). */
  notes: Map<string, string>
  /** Secrets handed to the system during the scenario; none may ever show up in output. */
  secrets: Set<string>
}

const states = new WeakMap<World, Hosting>()

export function hosting(world: World): Hosting {
  let state = states.get(world)
  if (!state) {
    state = {
      env: {},
      runs: [],
      cleanups: [],
      signIns: [],
      redirects: [],
      cookies: new Map(),
      notes: new Map(),
      secrets: new Set(),
    }
    states.set(world, state)
  }
  return state
}

/** Stop everything a scenario started through its {@link Hosting} state. */
export async function cleanupHosting(world: World): Promise<void> {
  const state = states.get(world)
  if (!state) return
  for (const run of state.runs) await run.process.stop("SIGKILL")
  for (const cleanup of state.cleanups.reverse()) await cleanup().catch(() => {})
  states.delete(world)
}

export const PRODUCTION_URL = "https://fleet.example.com"
/** Distinctive, so a leak into output is unmistakable. */
export const S3_SECRET = "s3-secret-access-key-7f3a9c21d4"

/**
 * A complete, valid environment for a real (non-loopback) deployment: database, object store and
 * an operator token, using a set of emulators. Dev login is off, as it must be off loopback.
 */
export async function productionEnv(
  emulators: Emulators,
  publicUrl = PRODUCTION_URL,
): Promise<Record<string, string>> {
  const env = serverEnv(emulators, await freePort())
  delete env.AUTH_DEV_LOGIN
  return { ...env, PUBLIC_URL: publicUrl, S3_SECRET_ACCESS_KEY: S3_SECRET }
}

const answersHealth = (url: string) =>
  fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }).then(
    (response) => response.ok,
    () => false,
  )

/**
 * Start the server with the scenario's environment (plus `overrides`) and wait until it either
 * exits or answers `/health`. Never throws for a failed boot: that is what the scenario asserts on.
 */
export async function boot(
  state: Hosting,
  args: string[] = [],
  overrides: Record<string, string> = {},
): Promise<Run> {
  const env = Object.fromEntries(
    Object.entries({ ...state.env, ...overrides }).filter(([, value]) => value !== ""),
  )
  const port = Number(env.PORT) || 8080
  const run: Run = {
    process: runServer(env, args),
    port,
    url: `http://localhost:${port}`,
    code: undefined,
    answered: false,
  }
  state.runs.push(run)
  void run.process.exited.then((code) => {
    run.code = code
  })
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline && run.process.child.exitCode === null) {
    // Something else may own the port (one scenario arranges exactly that), so an answer only
    // counts once this process says it is listening.
    if (await answersHealth(run.url)) {
      run.answered = true
      if (run.process.output().includes('"message":"listening"')) return run
    }
    await sleep(25)
  }
  if (run.process.child.exitCode === null)
    throw new Error(`The server neither started nor exited:\n${run.process.output()}`)
  run.code = await run.process.exited
  return run
}

/** The run a scenario is talking about: the most recent one. */
export function lastRun(state: Hosting): Run {
  const run = state.runs.at(-1)
  if (!run) throw new Error("The server has not been started in this scenario")
  return run
}

/** Whether anything accepts TCP connections on a local port. */
export async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1")
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}

/** Occupy a port on every interface until the returned function is called. */
export async function occupyPort(port: number): Promise<() => Promise<void>> {
  const sockets = new Set<Socket>()
  const server = createTcpServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "0.0.0.0", resolve)
  })
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    })
}

/** The problems of the machine-readable last line a failed boot prints. */
export function fatalLine(output: string):
  | {
      level: string
      event: string
      problems: { code: string; what: string; why: string; fix: string; env: string[] }[]
    }
  | undefined {
  const last = output.trimEnd().split("\n").at(-1) ?? ""
  try {
    return JSON.parse(last)
  } catch {
    return undefined
  }
}

/** The numbered problems of the human-readable report, each with its indented detail lines. */
export function reportProblems(output: string): { title: string; lines: string[] }[] {
  const problems: { title: string; lines: string[] }[] = []
  for (const line of output.split("\n")) {
    const title = /^(\d+)\. (.+)$/.exec(line)
    if (title) problems.push({ title: title[2] ?? "", lines: [] })
    else if (/^ {3}\S/.test(line)) problems.at(-1)?.lines.push(line.trim())
  }
  return problems
}

/** Every value in an environment that is a credential, long enough to search output for. */
export function secretsIn(env: Record<string, string>): string[] {
  const found = [env.OPERATOR_TOKEN, env.S3_SECRET_ACCESS_KEY, env.VAULT_TOKEN]
  for (const name of ["DATABASE_URL", "S3_ENDPOINT"]) {
    // Not always a parseable URL (that is one of the cases under test), so match by shape.
    const password = /^[a-z]+:\/\/[^:/@]*:(.+)@[^@]*$/.exec(env[name] ?? "")?.[1]
    if (password) found.push(password, ...password.split("@"))
  }
  for (const pair of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const value = pair.slice(pair.indexOf("=") + 1).replace(/^Bearer(%20| )/i, "")
    if (pair.includes("=")) found.push(value)
  }
  // Fixture defaults such as the emulator password "fleet" are words, not secrets.
  return [...new Set(found.filter((value): value is string => !!value && value.length >= 12))]
}

/** JSON-decode every line of a process's output; non-JSON lines come back as `undefined`. */
export function jsonLines(output: string): (Record<string, unknown> | undefined)[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line)
        return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
      } catch {
        return undefined
      }
    })
}

export { OPERATOR_TOKEN }
