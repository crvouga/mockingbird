/**
 * Trusted Publisher health for every npm package associated with this repo.
 *
 * Association is the logged-in account's packages whose registry repository is
 * crvouga/mockingbird, plus every public workspace package (including one that
 * is not on npm yet). npm can only record a publisher on a package that already
 * exists, and direct `npm publish` from this repo's Release workflow needs a
 * GitHub Actions publisher for crvouga/mockingbird, workflow ci.yml, with no
 * environment and permission to publish (not stage-only). The fix is the
 * package access page.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { discoverPackages, REPO, root, WORKFLOW_FILE } from "../release/lib.ts"
import type { HealthFinding, HealthGroup, HealthReport } from "./report.ts"
import { promptWebAuth, type WebChallenge, webChallenge } from "./web-auth.ts"

const REGISTRY_TOKEN_KEY = "//registry.npmjs.org/:_authToken"

const PUBLISH_PERMISSION = "createPackage"
const REGISTRY = "https://registry.npmjs.org"

export type TrustConfig = {
  id?: string
  type?: string
  /** npm trust list's normalized CLI fields. */
  file?: string
  repository?: string
  permissions?: string[]
  environment?: string
  claims?: {
    repository?: string
    environment?: string
    workflow_ref?: { file?: string } | string
  }
}

export type PackageTrust = {
  name: string
  /** False when the package 404s on npm. True when versions exist. Absent when the lookup failed. */
  published?: boolean
  configs?: TrustConfig[]
  /** Registry lookup failed. The message must not contain a token. */
  error?: string
}

export type PublisherGap = "missing" | "stage-only" | "environment" | "not-published"

const GAP_SUMMARY: Record<PublisherGap, string> = {
  missing: `No GitHub Actions publisher for ${REPO} ${WORKFLOW_FILE}. On the access page add one and allow npm publish. Organization crvouga, repository mockingbird, workflow filename ci.yml, environment empty.`,
  "stage-only":
    "GitHub Actions publisher does not allow npm publish (stage only). On the access page, allow npm publish.",
  environment:
    "GitHub Actions publisher is limited to an environment. The Release workflow sets none. On the access page, clear Environment and allow npm publish.",
  "not-published":
    "Not on npm yet, so there is no access page until the interactive first publish (bun run release:seed).",
}

export function accessUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}/access`
}

/** Registry path segment. npm escapes only the slash (`@scope%2fname`). */
export function registryPackagePath(name: string): string {
  return name.replaceAll("/", "%2f")
}

/**
 * `github.com/crvouga/mockingbird` or `github:crvouga/mockingbird`, including
 * `.git` and a trailing path. A longer repo name such as `mockingbird-extra`
 * does not match.
 */
const PROJECT_REPOSITORY =
  /(?:^|[/:@])(?:github\.com[:/]|github:)crvouga\/mockingbird(?:\.git)?(?=$|[/#?])/

function repositoryText(repository: unknown): string | undefined {
  if (typeof repository === "string") return repository
  if (repository && typeof repository === "object" && "url" in repository) {
    const url = (repository as { url?: unknown }).url
    return typeof url === "string" ? url : undefined
  }
  return undefined
}

/** True when a package repository points at this GitHub repo. */
export function repositoryMatchesProject(repository: unknown): boolean {
  const text = repositoryText(repository)
  return text !== undefined && PROJECT_REPOSITORY.test(text.trim())
}

/** Names this repo publishes or used to publish (`@crvouga/mockingbird` and `-…`). */
export function isProjectPackageName(name: string): boolean {
  return name === `@${REPO}` || name.startsWith(`@${REPO}-`)
}

export type AccountPackument = {
  name: string
  status: number
  repository?: unknown
}

/**
 * Packages to check: account packages whose repository is this repo, account
 * packages under this repo's name when the repository could not be read, and
 * every public workspace package.
 */
export function selectProjectPackages(input: {
  account: readonly AccountPackument[]
  workspacePublic: readonly string[]
}): string[] {
  const selected = new Set<string>(input.workspacePublic)
  for (const pkg of input.account) {
    if (pkg.status === 200 && repositoryMatchesProject(pkg.repository)) {
      selected.add(pkg.name)
      continue
    }
    const repositoryKnown = pkg.status === 200 && pkg.repository !== undefined
    if (repositoryKnown || pkg.status === 404) continue
    if (isProjectPackageName(pkg.name)) selected.add(pkg.name)
  }
  return [...selected].sort((a, b) => a.localeCompare(b))
}

/** Package names from `GET /-/user/<name>/package`. The body is `{ [name]: "read" | "write" }`. */
export function accountPackageNames(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  return Object.keys(body)
}

/** Top-level `repository`, or the latest version's when the packument omits it. */
export function packumentRepository(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined
  const doc = body as {
    repository?: unknown
    "dist-tags"?: { latest?: unknown }
    versions?: Record<string, { repository?: unknown } | undefined>
  }
  if (doc.repository !== undefined) return doc.repository
  const latest = doc["dist-tags"]?.latest
  if (typeof latest !== "string") return undefined
  return doc.versions?.[latest]?.repository
}

function workflowFile(config: TrustConfig): string | undefined {
  if (config.file) return config.file
  const ref = config.claims?.workflow_ref
  if (!ref) return undefined
  if (typeof ref === "string") return ref.match(/\.github\/workflows\/([^@]+)/)?.[1]
  return ref.file
}

function environmentName(config: TrustConfig): string | undefined {
  const value = config.claims?.environment ?? config.environment
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function allowsPublish(config: TrustConfig): boolean {
  // Configs from before npm required an explicit permission allow npm publish.
  if (!config.permissions) return true
  return config.permissions.includes(PUBLISH_PERMISSION)
}

/** Why this package cannot be published by the Release workflow, or null when it can. */
export function publisherGap(published: boolean, configs: TrustConfig[]): PublisherGap | null {
  if (!published) return "not-published"
  const matched = configs.filter(
    (config) =>
      config.type === "github" &&
      (config.repository ?? config.claims?.repository) === REPO &&
      workflowFile(config) === WORKFLOW_FILE,
  )
  const unrestricted = matched.filter((config) => environmentName(config) === undefined)
  if (unrestricted.some(allowsPublish)) return null
  if (unrestricted.length > 0) return "stage-only"
  if (matched.length > 0) return "environment"
  return "missing"
}

export function trustedPublisherReport(packages: PackageTrust[]): HealthReport {
  const groups = new Map<PublisherGap | "unreadable", HealthFinding[]>()
  const push = (key: PublisherGap | "unreadable", finding: HealthFinding) => {
    const list = groups.get(key) ?? []
    list.push(finding)
    groups.set(key, list)
  }

  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) {
    if (pkg.error) {
      push("unreadable", { id: `${pkg.name} — ${pkg.error}` })
      continue
    }
    const gap = publisherGap(pkg.published === true, pkg.configs ?? [])
    if (!gap) continue
    push(
      gap,
      gap === "not-published" ? { id: pkg.name } : { id: pkg.name, url: accessUrl(pkg.name) },
    )
  }

  const order: Array<PublisherGap | "unreadable"> = [
    "missing",
    "stage-only",
    "environment",
    "not-published",
    "unreadable",
  ]
  const rendered: HealthGroup[] = []
  for (const key of order) {
    const findings = groups.get(key)
    if (!findings || findings.length === 0) continue
    rendered.push({
      summary:
        key === "unreadable"
          ? "npm did not return the trusted publisher for these packages."
          : GAP_SUMMARY[key],
      findings,
    })
  }

  return { id: "trusted-publisher", title: "trusted publisher", groups: rendered }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      const item = items[index]
      if (item === undefined) return
      out[index] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

/** Pull `//registry.npmjs.org/:_authToken` out of npmrc text. The last assignment wins. */
export function readRegistryToken(npmrc: string): string | undefined {
  let token: string | undefined
  for (const raw of npmrc.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const eq = line.indexOf("=")
    if (eq === -1 || line.slice(0, eq).trim() !== REGISTRY_TOKEN_KEY) continue
    let value = line.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (value) token = value
  }
  return token
}

function npmrcToken(): string | undefined {
  // User config, then the repo file, matching npm's project-over-user precedence.
  // npm config get refuses to print this key, so the files are read directly.
  let token: string | undefined
  for (const path of [join(homedir(), ".npmrc"), join(root, ".npmrc")]) {
    if (!existsSync(path)) continue
    const found = readRegistryToken(readFileSync(path, "utf8"))
    if (found) token = found
  }
  return token
}

export function npmAuthToken(): string | { error: string } {
  // The npm login stored by `npm login`. Reading trust settings still needs the
  // security-key prompt that login itself does not complete.
  const token = npmrcToken()
  if (!token) return { error: "npm is not logged in. Run npm login, then bun run health." }
  return token
}

const TRUST_UNAUTHORIZED = "unauthorized"

/** A 401 that did not include a security-key challenge. */
export const TRUST_LOGIN_ERROR =
  "npm rejected the trusted publisher lookup. Run npm login, then bun run health."

const SECURITY_KEY_AGAIN =
  "npm still wants a security key for each package. On the approval page, skip two-factor for a few minutes, then run bun run health again."

export function collapseTrustAuth(results: PackageTrust[]): PackageTrust[] | { error: string } {
  if (results.length > 0 && results.every((result) => result.error === TRUST_UNAUTHORIZED)) {
    return { error: TRUST_LOGIN_ERROR }
  }
  return results
}

async function registryGet(
  path: string,
  token: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${REGISTRY}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(15_000),
  })
}

const WEB_AUTH_HEADERS = { "npm-auth-type": "web", "npm-command": "trust" }

async function readRegistryJson(
  path: string,
  token: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await registryGet(path, token, headers)
  return { status: res.status, body: await res.json().catch(() => undefined) }
}

/** One security-key prompt when the registry answers 401 with a web challenge. */
async function withWebAuth(
  path: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  let result = await readRegistryJson(path, token)
  let challenge = webChallenge(result.status, result.body)
  if (result.status === 401 && !challenge) {
    result = await readRegistryJson(path, token, WEB_AUTH_HEADERS)
    challenge = webChallenge(result.status, result.body)
  }
  if (!challenge) return result
  const otp = await promptWebAuth(challenge, token, false)
  result = await readRegistryJson(path, token, { ...WEB_AUTH_HEADERS, "npm-otp": otp })
  if (webChallenge(result.status, result.body)) throw new Error(SECURITY_KEY_AGAIN)
  return result
}

function usernameOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("username" in body)) return undefined
  const username = (body as { username?: unknown }).username
  return typeof username === "string" && username ? username : undefined
}

function publicWorkspaceNames(): string[] {
  return discoverPackages()
    .filter((pkg) => pkg.isPublic)
    .map((pkg) => pkg.name)
}

export type ProjectPackageSet = {
  names: string[]
  status: Map<string, number>
}

/**
 * npm packages associated with this repo. The account list is packages the login
 * maintains; each packument's repository decides whether it belongs here.
 */
export async function loadProjectPackageNames(
  token: string,
): Promise<ProjectPackageSet | { error: string }> {
  const who = await readRegistryJson("/-/whoami", token)
  if (who.status === 401 || who.status === 403) {
    return { error: "npm rejected this login. Run npm login, then bun run health." }
  }
  if (who.status !== 200) {
    return { error: `npm returned HTTP ${who.status} for the trusted publisher lookup.` }
  }
  const username = usernameOf(who.body)
  if (!username) return { error: "npm did not return the logged-in username." }

  const listed = await withWebAuth(`/-/user/${encodeURIComponent(username)}/package`, token)
  if (listed.status === 401 || listed.status === 403) return { error: TRUST_LOGIN_ERROR }
  if (listed.status !== 200) {
    return { error: `npm returned HTTP ${listed.status} listing packages for this account.` }
  }
  const accountNames = accountPackageNames(listed.body)
  if (!accountNames) return { error: "npm returned an unexpected package list." }

  const packuments = await mapPool(accountNames, 8, async (name) => {
    const res = await registryGet(`/${registryPackagePath(name)}`, token)
    const body = res.status === 200 ? await res.json().catch(() => undefined) : undefined
    const repository = packumentRepository(body)
    const entry: AccountPackument = { name, status: res.status }
    if (repository !== undefined) entry.repository = repository
    return entry
  })
  if (
    accountNames.length > 0 &&
    packuments.every((pkg) => pkg.status !== 200 && pkg.status !== 404)
  ) {
    return {
      error: `npm returned HTTP ${packuments[0]?.status ?? "unknown"} reading package repositories.`,
    }
  }

  const status = new Map(packuments.map((pkg) => [pkg.name, pkg.status]))
  return {
    names: selectProjectPackages({ account: packuments, workspacePublic: publicWorkspaceNames() }),
    status,
  }
}

export type TrustResponse = { status: number; body: unknown }

/**
 * Read every package's trust config. The first security-key challenge is approved
 * once; the rest of the run relies on npm's few-minute two-factor skip. A second
 * challenge asks for that skip. It does not open a prompt per package.
 */
export async function collectTrustResponses(
  names: string[],
  request: (name: string, otp?: string) => Promise<TrustResponse>,
  approve: (challenge: WebChallenge, again: boolean) => Promise<string>,
): Promise<Map<string, TrustResponse>> {
  const done = new Map<string, TrustResponse>()
  let remaining = [...names]
  for (let round = 0; round < 2 && remaining.length > 0; round++) {
    const probe = remaining[0]
    if (probe === undefined) break
    let first = await request(probe)
    const challenge = webChallenge(first.status, first.body)
    if (challenge) {
      const otp = await approve(challenge, round > 0)
      first = await request(probe, otp)
      if (webChallenge(first.status, first.body)) throw new Error(SECURITY_KEY_AGAIN)
    }
    done.set(probe, first)
    const rest = remaining.slice(1)
    const fetched = await mapPool(rest, 8, (name) => request(name))
    const again: string[] = []
    for (let index = 0; index < rest.length; index++) {
      const name = rest[index]
      const result = fetched[index]
      if (name === undefined || result === undefined) continue
      if (webChallenge(result.status, result.body)) again.push(name)
      else done.set(name, result)
    }
    remaining = again
  }
  if (remaining.length > 0) throw new Error(SECURITY_KEY_AGAIN)
  return done
}

export async function loadPackageTrust(
  names: string[],
  token: string,
  knownStatus?: ReadonlyMap<string, number>,
  options: { interactive?: boolean } = {},
): Promise<PackageTrust[] | { error: string }> {
  const who = await registryGet("/-/whoami", token)
  if (!who.ok) {
    return {
      error:
        who.status === 401 || who.status === 403
          ? "npm rejected this login. Run npm login, then bun run health."
          : `npm returned HTTP ${who.status} for the trusted publisher lookup.`,
    }
  }

  const versions = await mapPool(names, 8, async (name) => {
    const known = knownStatus?.get(name)
    if (known !== undefined) return known
    const res = await registryGet(`/${registryPackagePath(name)}`, token)
    return res.status
  })
  const published = names.filter((_, index) => versions[index] === 200)
  const trust = await collectTrustResponses(
    published,
    async (name, otp) => {
      const res = await registryGet(`/-/package/${registryPackagePath(name)}/trust`, token, {
        "npm-auth-type": "web",
        "npm-command": "trust",
        ...(otp ? { "npm-otp": otp } : {}),
      })
      return { status: res.status, body: await res.json().catch(() => undefined) }
    },
    (challenge, again) => {
      if (options.interactive === false)
        throw new Error(
          "npm requires security-key approval; run bun run health -- trusted-publisher --interactive",
        )
      return promptWebAuth(challenge, token, again)
    },
  )

  const results = names.map((name, index): PackageTrust => {
    const status = versions[index]
    if (status === 404) return { name, published: false, configs: [] }
    if (status !== 200) return { name, error: `package lookup HTTP ${status ?? "unknown"}` }
    const body = trust.get(name)
    if (!body) return { name, error: "trust lookup did not return a response" }
    if (body.status === 404) return { name, published: true, configs: [] }
    if (body.status === 401) return { name, error: TRUST_UNAUTHORIZED }
    if (body.status === 403) return { name, error: "no permission to read its trusted publisher" }
    if (body.status !== 200) return { name, error: `trust lookup HTTP ${body.status}` }
    if (!Array.isArray(body.body))
      return { name, error: "trust lookup returned an unexpected body" }
    return { name, published: true, configs: body.body as TrustConfig[] }
  })
  return collapseTrustAuth(results)
}

function failed(error: string): HealthReport {
  return { id: "trusted-publisher", title: "trusted publisher", groups: [], error }
}

export async function runTrustedPublisher(): Promise<HealthReport> {
  try {
    const token = npmAuthToken()
    if (typeof token !== "string") return failed(token.error)
    const project = await loadProjectPackageNames(token)
    if ("error" in project) return failed(project.error)
    const loaded = await loadPackageTrust(project.names, token, project.status)
    if (!Array.isArray(loaded)) return failed(loaded.error)
    return trustedPublisherReport(loaded)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failed(message.replace(/npm_[A-Za-z0-9]{20,}/g, "[redacted]"))
  }
}
