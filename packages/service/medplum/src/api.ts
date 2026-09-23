import type { FetchAPI } from "@crvouga/mockingbird-core"
import { bootSqlite, Collection } from "@crvouga/mockingbird-service"
import { clearNamespace, type SqliteClient } from "@crvouga/mockingbird-sqlite"
import {
  allOk,
  badRequest,
  conflict,
  createReference,
  forbidden,
  getReferenceString,
  MEDPLUM_VERSION,
  multipleMatches,
  normalizeErrorString,
  normalizeOperationOutcome,
  notFound,
  OperationOutcomeError,
  Operator,
  parseReference,
  resolveId,
  stringify,
  unauthorized,
  type WithId,
} from "@medplum/core"
import type {
  Binary,
  ClientApplication,
  Login,
  OperationOutcome,
  Practitioner,
  Project,
  ProjectMembership,
  Reference,
  Resource,
  User,
} from "@medplum/fhirtypes"
import { getAccessPolicyForMembership } from "./auth/access-policy.js"
import {
  generateSigningKey,
  type JwtPayload,
  type SigningKey,
  sha256Base64Url,
  sha256Hex,
  signJwt,
  verifyJwt,
} from "./auth/jwt.js"
import { type BinaryStorage, handleFhir } from "./fhir/http.js"
import { MockRepository, type RepositoryServices } from "./fhir/repo.js"
import { FhirStore } from "./fhir/store.js"
import {
  BodyParseError,
  contentCouldNotBeParsed,
  expressNotFound,
  json,
  type ParsedBody,
  parseBody,
  type RequestIds,
  respond,
  sendOutcome,
} from "./http.js"
import { IdSource, uuidFrom } from "./ids.js"
import { ensureSchema } from "./schema.js"

/** The self-hosted server's seeded super admin (seed.ts), and the mock's defaults for it. */
export const SUPER_ADMIN_EMAIL = "admin@example.com"
export const SUPER_ADMIN_PASSWORD = "medplum_admin"
export const SUPER_ADMIN_CLIENT_ID = "6f3f0c17-8bd1-4a56-9d5a-6b21e5b0a101"
export const SUPER_ADMIN_CLIENT_SECRET = "mockingbird-local-secret"

/** The ready-to-use project every namespace seeds, with a client application consumers sign in with. */
export const DEFAULT_PROJECT_ID = "a3b8f042-1d1e-4d0a-9f4c-6d6f636b6272"
export const DEFAULT_CLIENT_ID = "b4c9e153-2e2f-4e1b-8a5d-6d6f636b6272"
export const DEFAULT_CLIENT_SECRET = "mockingbird-medplum-client-secret"

/** Medplum's default base URL, `http://localhost:8103/`. */
export const DEFAULT_BASE_URL = "http://localhost:8103/"

const R4_PROJECT_ID = "161452d9-43b7-5c29-aa7b-c85680fa45c6"

export type MedplumUserFixture = {
  email: string
  password: string
  firstName?: string
  lastName?: string
  /** The profile resource type. Default `Practitioner`. */
  profileType?: "Practitioner" | "Patient" | "RelatedPerson"
  /** Project admin. Default false. */
  admin?: boolean
}

export type MedplumAPIOptions = {
  /** Sync SQLite client. Defaults to `@crvouga/mockingbird-service-sqlite`. */
  sqlite?: SqliteClient
  /** Clock for `meta.lastUpdated`, token lifetimes and history. Default `Date.now`. */
  now?: () => number
  /** Storage namespace. Default `medplum`. */
  namespace?: string
  /**
   * The server's public base URL (`config.baseUrl`), with a trailing slash: it appears in
   * `fullUrl`s, search links, `Location` headers and token issuers. Default `http://localhost:8103/`.
   */
  baseUrl?: string
  /** Seed for generated ids and secrets. Default: the namespace. */
  seed?: number | string
  /** The seeded super admin. */
  superAdmin?: { email?: string; password?: string; clientId?: string; clientSecret?: string }
  /**
   * The ready-to-use project: its id, name, and client application (id and secret).
   * `false` seeds only the super admin, like a fresh self-hosted server.
   */
  project?:
    | false
    | {
        id?: string
        name?: string
        clientId?: string
        clientSecret?: string
        /** Whether the default client is a project admin (needed for `/admin/projects/*`). Default true. */
        clientAdmin?: boolean
        /** Users with a password login in the default project. */
        users?: MedplumUserFixture[]
      }
  /** Largest `_offset` accepted (`maxSearchOffset`). Default unlimited, as on the server. */
  maxSearchOffset?: number
}

type AuthState = {
  login: Login
  project: WithId<Project>
  membership: WithId<ProjectMembership>
  accessToken?: string
}

type LoginRecord = WithId<Login>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringField = (body: unknown, key: string): string | undefined => {
  if (!isRecord(body)) return undefined
  const value = body[key]
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined
  return typeof value === "string" ? value : undefined
}

const tokenError = (error: string, description?: string, status = 400): Response =>
  json(status, { error, error_description: description })

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Stateful mock of a self-hosted Medplum server: FHIR R4 REST (CRUD, versioning, history,
 * search with the server's semantics, batch and transaction bundles, patch, `$validate`,
 * GraphQL), OAuth2 (password login, authorization code with PKCE, client credentials,
 * refresh tokens) and the project admin API, all in memory over SQLite and WebCrypto so it runs
 * wherever JavaScript does.
 *
 * Each namespace seeds the server's super admin and a ready project with a client application
 * ({@link DEFAULT_CLIENT_ID} / {@link DEFAULT_CLIENT_SECRET}).
 */
export class MedplumAPI implements FetchAPI {
  readonly sqlite: SqliteClient
  readonly namespace: string
  readonly baseUrl: string
  private readonly now: () => number
  private readonly options: MedplumAPIOptions
  readonly store: FhirStore
  private readonly idSource: IdSource
  private readonly logins: Collection<LoginRecord>
  private readonly binaryData: Collection<{ base64: string }>
  private signingKey: Promise<SigningKey> | undefined

  constructor(options: MedplumAPIOptions = {}) {
    this.options = options
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? "medplum"
    this.now = options.now ?? (() => Date.now())
    const base = options.baseUrl ?? DEFAULT_BASE_URL
    this.baseUrl = base.endsWith("/") ? base : `${base}/`
    this.store = new FhirStore(this.sqlite, this.namespace)
    this.idSource = new IdSource(
      this.sqlite,
      this.namespace,
      String(options.seed ?? this.namespace),
    )
    this.logins = new Collection<LoginRecord>(this.sqlite, this.namespace, "medplum:logins")
    this.binaryData = new Collection<{ base64: string }>(
      this.sqlite,
      this.namespace,
      "medplum:binary",
    )
  }

  // ------------------------------------------------------------------ plumbing

  private services(): RepositoryServices {
    return {
      store: this.store,
      now: this.now,
      writeTime: () => this.writeTime(),
      generateId: () => this.idSource.uuid(),
      baseUrl: this.baseUrl,
      maxSearchOffset: this.options.maxSearchOffset,
      sign: (data) => this.sign(data),
      writeBinary: (binary, bytes) => this.binaries().write(binary, bytes),
    }
  }

  private lastWrite = 0

  /**
   * Writes get strictly increasing `lastUpdated` instants: a real server's writes are never in
   * the same millisecond, and cursor paging and `_sort=_lastUpdated` rely on it.
   */
  private writeTime(): number {
    this.lastWrite = Math.max(this.now(), this.lastWrite + 1)
    return this.lastWrite
  }

  private hmacKey: Promise<CryptoKey> | undefined

  /** HMAC-SHA256 (base64) with a per-instance key: the signature of presigned storage URLs. */
  private async sign(data: string): Promise<string> {
    this.hmacKey ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(uuidFrom(`${this.namespace}:storage-key`)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.hmacKey,
      new TextEncoder().encode(data),
    )
    let binary = ""
    for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  /** A repository that sees and may write everything, as the server's system repository. */
  systemRepo(): MockRepository {
    return new MockRepository(this.services(), {
      projects: [],
      author: { reference: "system" },
      superAdmin: true,
      extendedMode: true,
    })
  }

  private key(): Promise<SigningKey> {
    this.signingKey ??= generateSigningKey(uuidFrom(`${this.namespace}:jwk`))
    return this.signingKey
  }

  private binaries(): BinaryStorage {
    return {
      write: (binary: Binary, bytes: Uint8Array) => {
        let binaryString = ""
        for (const byte of bytes) binaryString += String.fromCharCode(byte)
        this.binaryData.insert(`${binary.id}/${binary.meta?.versionId}`, {
          base64: btoa(binaryString),
        })
      },
      read: (binary: Binary) => {
        let stored = this.binaryData.get(`${binary.id}/${binary.meta?.versionId}`)
        if (!stored) {
          // A metadata-only update keeps the previous version's content (`copyBinary`).
          const versions = this.store.history("Binary", binary.id as string)
          for (const version of versions) {
            stored = this.binaryData.get(`${binary.id}/${version.versionId}`)
            if (stored) break
          }
        }
        if (!stored) return undefined
        const decoded = atob(stored.base64)
        return Uint8Array.from(decoded, (c) => c.charCodeAt(0))
      },
    }
  }

  private requestIds(request: Request): RequestIds {
    const traceparent = request.headers.get("traceparent")
    const traceFromParent = traceparent?.split("-")[1]
    const traceId =
      request.headers.get("x-trace-id") ??
      (traceFromParent && /^[0-9a-f]{32}$/.test(traceFromParent)
        ? (traceparent ?? undefined)
        : undefined) ??
      this.idSource.uuid()
    return { requestId: this.idSource.uuid(), traceId }
  }

  // ------------------------------------------------------------------ seeding

  /**
   * Seed the super admin and the default project. The repository is async-shaped but never
   * awaits real I/O, so this runs to completion before the first request is served.
   */
  private seeding: Promise<void> | undefined

  private ensureSeeded(): Promise<void> {
    this.seeding ??= ensureSchema()
      .then(() => this.seedData())
      .then(() => {
        // Seeding does not count against the write clock: a suite's first write lands at `now`.
        this.lastWrite = 0
      })
    return this.seeding
  }

  /** Resolves once the FHIR definitions are loaded and the namespace is seeded (the first request does this too). */
  ready(): Promise<void> {
    return this.ensureSeeded()
  }

  private async seedData(): Promise<void> {
    if (this.store.rows("Project").length > 0) return
    const system = this.systemRepo()
    const superAdmin = this.options.superAdmin ?? {}
    const email = (superAdmin.email ?? SUPER_ADMIN_EMAIL).toLowerCase()
    const user = await system.createResource<User>({
      resourceType: "User",
      firstName: "Medplum",
      lastName: "Admin",
      email,
      passwordHash: await this.hashPassword(superAdmin.password ?? SUPER_ADMIN_PASSWORD),
    })
    const superProject = await system.createResource<Project>({
      resourceType: "Project",
      name: "Super Admin",
      owner: createReference(user),
      superAdmin: true,
      strictMode: true,
    })
    await system.updateResource<Project>({
      resourceType: "Project",
      id: R4_PROJECT_ID,
      name: "FHIR R4",
    })
    const practitioner = await this.createProfile(
      superProject,
      "Practitioner",
      "Medplum",
      "Admin",
      email,
    )
    await this.createMembership(user, superProject, practitioner, { admin: true })
    const client = await system.updateResource<ClientApplication>({
      meta: { project: superProject.id },
      resourceType: "ClientApplication",
      id: superAdmin.clientId ?? SUPER_ADMIN_CLIENT_ID,
      name: "Default Super Admin Client",
      secret: superAdmin.clientSecret ?? SUPER_ADMIN_CLIENT_SECRET,
    })
    await system.createResource<ProjectMembership>({
      meta: { project: superProject.id },
      resourceType: "ProjectMembership",
      project: createReference(superProject),
      user: createReference(client),
      profile: createReference(client),
    })

    const defaults = this.options.project
    if (defaults === false) return
    const project = await system.updateResource<Project>({
      resourceType: "Project",
      id: defaults?.id ?? DEFAULT_PROJECT_ID,
      name: defaults?.name ?? "Mockingbird",
      strictMode: true,
    })
    const projectClient = await system.updateResource<ClientApplication>({
      meta: { project: project.id },
      resourceType: "ClientApplication",
      id: defaults?.clientId ?? DEFAULT_CLIENT_ID,
      name: "Mockingbird Client",
      secret: defaults?.clientSecret ?? DEFAULT_CLIENT_SECRET,
    })
    await system.createResource<ProjectMembership>({
      meta: { project: project.id },
      resourceType: "ProjectMembership",
      project: createReference(project),
      user: createReference(projectClient),
      profile: createReference(projectClient),
      ...(defaults?.clientAdmin === false ? {} : { admin: true }),
    })
    for (const fixture of defaults?.users ?? []) await this.addUserNow(fixture, project.id)
  }

  private async hashPassword(password: string): Promise<string> {
    return `mockingbird-sha256$${await sha256Hex(password)}`
  }

  private async createProfile(
    project: WithId<Project>,
    resourceType: "Patient" | "Practitioner" | "RelatedPerson",
    firstName: string,
    lastName: string,
    email: string | undefined,
  ): Promise<WithId<Practitioner>> {
    return (await this.systemRepo().createResource({
      resourceType,
      meta: { project: project.id },
      name: [{ given: [firstName], family: lastName }],
      telecom: email ? [{ system: "email", use: "work", value: email }] : undefined,
    } as Practitioner)) as WithId<Practitioner>
  }

  private createMembership(
    user: WithId<User>,
    project: WithId<Project>,
    profile: WithId<Resource>,
    details?: Partial<ProjectMembership>,
  ): Promise<WithId<ProjectMembership>> {
    return this.systemRepo().createResource<ProjectMembership>({
      ...details,
      resourceType: "ProjectMembership",
      project: createReference(project),
      user: createReference(user),
      profile: createReference(profile) as Reference<Practitioner>,
    })
  }

  /** Add a user with a password login to a project (default: the default project). */
  async addUser(
    fixture: MedplumUserFixture,
    projectId: string | undefined = undefined,
  ): Promise<{
    user: WithId<User>
    profile: WithId<Resource>
    membership: WithId<ProjectMembership>
  }> {
    await this.ensureSeeded()
    return this.addUserNow(fixture, projectId ?? this.defaultProjectId())
  }

  private async addUserNow(fixture: MedplumUserFixture, projectId: string) {
    const system = this.systemRepo()
    const project = system.readResourceImpl<Project>("Project", projectId)
    const user = await system.createResource<User>({
      resourceType: "User",
      firstName: fixture.firstName ?? "Mock",
      lastName: fixture.lastName ?? "User",
      email: fixture.email.toLowerCase(),
      passwordHash: await this.hashPassword(fixture.password),
      project: createReference(project),
    })
    const profile = await this.createProfile(
      project,
      fixture.profileType ?? "Practitioner",
      fixture.firstName ?? "Mock",
      fixture.lastName ?? "User",
      fixture.email,
    )
    const membership = await this.createMembership(
      user,
      project,
      profile,
      fixture.admin ? { admin: true } : {},
    )
    return { user, profile, membership }
  }

  // ------------------------------------------------------------------ lifecycle

  async reset(): Promise<void> {
    clearNamespace(this.sqlite, this.namespace)
    this.seeding = undefined
    await this.ensureSeeded()
  }

  // ------------------------------------------------------------------ authentication

  /** `getClientApplicationMembership`: the membership whose user is `subject`. */
  private membershipFor(subject: Reference): WithId<ProjectMembership> | undefined {
    return this.store
      .rows("ProjectMembership")
      .filter((row) => !row.deleted && row.content)
      .map((row) => row.content as WithId<ProjectMembership>)
      .find((membership) => membership.user?.reference === subject.reference)
  }

  private readSystem<T extends Resource>(reference: Reference | undefined): WithId<T> | undefined {
    if (!reference?.reference) return undefined
    try {
      const [type, id] = parseReference(reference)
      return this.systemRepo().readResourceImpl<T>(type, id)
    } catch {
      return undefined
    }
  }

  private readLogin(id: string): LoginRecord | undefined {
    return this.logins.get(id)
  }

  /** Logins are resources on the server: every save is a new version. */
  private saveLogin(login: LoginRecord): LoginRecord {
    const saved: LoginRecord = {
      ...login,
      meta: {
        ...login.meta,
        versionId: this.idSource.uuid(),
        lastUpdated: new Date(this.now()).toISOString(),
      },
    }
    this.logins.insert(saved.id, saved)
    return saved
  }

  private async authenticate(request: Request): Promise<AuthState | undefined> {
    const header = request.headers.get("authorization")
    if (!header) return undefined
    const [scheme, credential] = header.split(" ")
    if (!scheme || !credential) return undefined
    if (scheme === "Bearer") return this.authenticateBearer(credential)
    if (scheme === "Basic") return this.authenticateBasic(credential)
    return undefined
  }

  private async authenticateBearer(token: string): Promise<AuthState | undefined> {
    const claims = await verifyJwt(await this.key(), token, {
      issuer: this.baseUrl,
      now: this.now(),
    })
    if (!claims || claims.aud !== this.baseUrl || claims.refresh_secret !== undefined)
      return undefined
    const login = typeof claims.login_id === "string" ? this.readLogin(claims.login_id) : undefined
    if (!login?.membership || login.revoked) return undefined
    const membership = this.readSystem<ProjectMembership>(login.membership)
    if (!membership || membership.active === false) return undefined
    const project = this.readSystem<Project>(membership.project)
    if (!project) return undefined
    return { login, project, membership, accessToken: token }
  }

  private authenticateBasic(credential: string): AuthState | undefined {
    let decoded: string
    try {
      decoded = atob(credential)
    } catch {
      return undefined
    }
    const [username, password] = decoded.split(":")
    if (!username || !password) return undefined
    const client = this.readSystem<ClientApplication>({
      reference: `ClientApplication/${username}`,
    })
    if (!client || client.secret !== password) return undefined
    if (client.status && client.status !== "active") return undefined
    const membership = this.membershipFor({ reference: `ClientApplication/${client.id}` })
    if (!membership || membership.active === false) return undefined
    const project = this.readSystem<Project>(membership.project)
    if (!project) return undefined
    const login: LoginRecord = {
      resourceType: "Login",
      id: this.idSource.uuid(),
      user: createReference(client),
      authMethod: "client",
      authTime: new Date(this.now()).toISOString(),
    }
    return { login, project, membership }
  }

  /** `getRepoForLogin`: the repository an authenticated request works through. */
  private repoFor(auth: AuthState, request: Request): MockRepository {
    const system = this.systemRepo()
    const accessPolicy = getAccessPolicyForMembership(system, auth.project, auth.membership)
    const profile = this.readSystem<Resource>(auth.membership.profile)
    const projects: WithId<Project>[] = [auth.project]
    for (const link of auth.project.link ?? []) {
      const linked = this.readSystem<Project>(link.project)
      if (linked) projects.push(linked)
    }
    return new MockRepository(this.services(), {
      projects,
      currentProject: auth.project,
      author: profile ? createReference(profile) : (auth.membership.profile as Reference),
      superAdmin: auth.project.superAdmin,
      projectAdmin: auth.membership.admin,
      accessPolicy,
      extendedMode: request.headers.get("x-medplum") === "extended",
    })
  }

  // ------------------------------------------------------------------ tokens

  private async issueTokens(login: LoginRecord, client: ClientApplication | undefined) {
    const key = await this.key()
    const now = Math.floor(this.now() / 1000)
    const membership = this.readSystem<ProjectMembership>(
      login.membership,
    ) as WithId<ProjectMembership>
    const user = this.readSystem<User | ClientApplication>(login.user) as WithId<
      User | ClientApplication
    >
    const profile = membership.profile as Reference
    const clientId = login.client ? resolveId(login.client) : undefined
    if (!login.granted) this.saveLogin({ ...login, granted: true })
    const lifetime = (text: string | undefined, fallback: number) => {
      const match = /^(\d+)([smhdwy])$/.exec(text ?? "")
      if (!match) return fallback
      const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31557600 }[match[2] as "s"]
      return Number(match[1]) * unit
    }
    const accessLifetime = lifetime(client?.accessTokenLifetime, 3600)
    const refreshLifetime = lifetime(client?.refreshTokenLifetime, 1209600)
    const base = (payload: JwtPayload, seconds: number): JwtPayload => {
      const out: JwtPayload = {}
      for (const [k, v] of Object.entries(payload)) if (v !== undefined) out[k] = v
      return {
        ...out,
        jti: this.idSource.uuid(),
        iat: now,
        nbf: now,
        iss: this.baseUrl,
        exp: now + seconds,
      }
    }
    const email =
      login.scope?.includes("email") && user.resourceType === "User" ? user.email : undefined
    const authTime = Date.parse(login.authTime as string) / 1000
    const idToken = await signJwt(
      key,
      base(
        {
          client_id: clientId,
          login_id: login.id,
          fhirUser: profile.reference,
          email,
          aud: clientId,
          sub: user.id,
          nonce: login.nonce,
          auth_time: authTime,
        },
        3600,
      ),
    )
    const accessToken = await signJwt(
      key,
      base(
        {
          aud: this.baseUrl,
          client_id: clientId,
          login_id: login.id,
          sub: user.id,
          username: user.id,
          scope: login.scope,
          profile: profile.reference,
          email,
        },
        accessLifetime,
      ),
    )
    const refreshToken = login.refreshSecret
      ? await signJwt(
          key,
          base(
            {
              aud: this.baseUrl,
              client_id: clientId,
              login_id: login.id,
              refresh_secret: login.refreshSecret,
            },
            refreshLifetime,
          ),
        )
      : undefined
    let patient: string | undefined
    if (profile.reference?.startsWith("Patient/"))
      patient = profile.reference.replace("Patient/", "")
    return json(200, {
      token_type: "Bearer",
      expires_in: accessLifetime,
      scope: login.scope,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      project: membership.project,
      profile: membership.profile,
      patient,
      smart_style_url: `${this.baseUrl}fhir/R4/.well-known/smart-styles.json`,
      need_patient_banner: Boolean(patient),
    })
  }

  // ------------------------------------------------------------------ /auth and /oauth2

  private async handleLogin(request: Request, body: unknown): Promise<Response> {
    const email = stringField(body, "email")
    const password = stringField(body, "password")
    const issues: { field: string; msg: string }[] = []
    if (!email || !EMAIL.test(email))
      issues.push({ field: "email", msg: "Valid email address is required" })
    if (!password || password.length < 8)
      issues.push({ field: "password", msg: "Password must be at least 8 characters" })
    else if (new TextEncoder().encode(password).length > 72) {
      issues.push({ field: "password", msg: "Password must be no more than 72 characters" })
    }
    if (issues.length > 0) return this.invalidRequest(issues)
    const clientId = stringField(body, "clientId")
    const codeChallenge = stringField(body, "codeChallenge")
    const codeChallengeMethod = stringField(body, "codeChallengeMethod")
    let projectId = stringField(body, "projectId")
    let client: WithId<ClientApplication> | undefined
    if (clientId) {
      client = this.readSystem<ClientApplication>({ reference: `ClientApplication/${clientId}` })
      if (!client) throw new OperationOutcomeError(notFound)
      const clientProject = client.meta?.project
      if (projectId && projectId !== "new" && clientProject && projectId !== clientProject) {
        throw new OperationOutcomeError(badRequest("Invalid projectId"))
      }
      projectId = projectId ?? clientProject
    }
    if (!client?.pkceOptional) {
      if (!codeChallenge && codeChallengeMethod)
        throw new OperationOutcomeError(badRequest("Invalid code challenge", "code_challenge"))
      if (codeChallenge && !codeChallengeMethod) {
        throw new OperationOutcomeError(
          badRequest("Invalid code challenge method", "code_challenge_method"),
        )
      }
      if (
        codeChallengeMethod &&
        codeChallengeMethod !== "plain" &&
        codeChallengeMethod !== "S256"
      ) {
        throw new OperationOutcomeError(
          badRequest("Invalid code challenge method", "code_challenge_method"),
        )
      }
    }
    const user = this.userByEmail(email as string, projectId)
    if (!user) throw new OperationOutcomeError(badRequest("User not found"))
    if (!user.passwordHash || user.passwordHash !== (await this.hashPassword(password as string))) {
      throw new OperationOutcomeError(badRequest("Email or password is invalid"))
    }
    const scope = stringField(body, "scope") || "openid"
    const offline = scope.split(" ").some((s) => s === "offline" || s === "offline_access")
    const remember = isRecord(body) && body.remember === true
    let login: LoginRecord = {
      resourceType: "Login",
      id: this.idSource.uuid(),
      client: client && createReference(client),
      project: projectId ? { reference: `Project/${projectId}` } : undefined,
      profileType: stringField(body, "resourceType") as Login["profileType"],
      user: createReference(user),
      authMethod: "password",
      authTime: new Date(this.now()).toISOString(),
      code: this.idSource.secret(16),
      cookie: this.idSource.secret(16),
      refreshSecret: offline || remember ? this.idSource.secret(32) : undefined,
      scope,
      nonce: stringField(body, "nonce") || this.idSource.uuid(),
      codeChallenge,
      codeChallengeMethod: codeChallengeMethod as Login["codeChallengeMethod"],
      remoteAddress: remoteAddressOf(request),
      userAgent: request.headers.get("user-agent") ?? undefined,
    }
    const memberships = this.membershipsForLogin(login)
    if (memberships.length === 0 && projectId !== "new")
      throw new OperationOutcomeError(badRequest("User not found"))
    this.saveLogin(login)
    if (memberships.length === 1)
      login = this.setLoginMembership(login, memberships[0] as WithId<ProjectMembership>)
    if (login.membership) return json(200, { login: login.id, code: login.code })
    return json(200, {
      login: login.id,
      memberships: memberships.map((m) => ({
        id: m.id,
        project: m.project,
        profile: m.profile,
        identifier: m.identifier,
      })),
    })
  }

  private userByEmail(email: string, projectId: string | undefined): WithId<User> | undefined {
    const users = this.store
      .rows("User")
      .filter((row) => !row.deleted && row.content)
      .map((row) => row.content as WithId<User>)
    const lowered = email.toLowerCase()
    if (projectId && projectId !== "new") {
      const inProject = users.find(
        (u) => u.email === lowered && u.project?.reference === `Project/${projectId}`,
      )
      if (inProject) return inProject
    }
    return users.find((u) => u.email === lowered && !u.project)
  }

  private membershipsForLogin(login: Login): WithId<ProjectMembership>[] {
    if (login.project?.reference === "Project/new") return []
    let memberships = this.store
      .rows("ProjectMembership")
      .filter((row) => !row.deleted && row.content)
      .map((row) => row.content as WithId<ProjectMembership>)
      .filter((m) => m.user?.reference === login.user?.reference && m.active !== false)
      .filter((m) => !login.project?.reference || m.project?.reference === login.project.reference)
    if (login.profileType)
      memberships = memberships.filter((m) =>
        m.profile?.reference?.startsWith(login.profileType as string),
      )
    return memberships
  }

  private invalidRequest(issues: { field: string; msg: string }[]): Response {
    return sendOutcome(
      {
        resourceType: "OperationOutcome",
        id: this.idSource.uuid(),
        issue: issues.map((issue) => ({
          severity: "error",
          code: "invalid",
          expression: issue.field ? [issue.field] : undefined,
          details: { text: issue.msg },
        })),
      },
      { requestId: this.idSource.uuid(), traceId: this.idSource.uuid() },
    )
  }

  private handleProfile(body: unknown): Response {
    const loginId = stringField(body, "login")
    const profileId = stringField(body, "profile")
    const login = loginId ? this.readLogin(loginId) : undefined
    if (!login) throw new OperationOutcomeError(badRequest("Login not found"))
    if (login.revoked) throw new OperationOutcomeError(badRequest("Login revoked"))
    if (login.granted) throw new OperationOutcomeError(badRequest("Login granted"))
    if (login.membership) throw new OperationOutcomeError(badRequest("Login profile already set"))
    const membership = this.readSystem<ProjectMembership>({
      reference: `ProjectMembership/${profileId}`,
    })
    if (!membership) throw new OperationOutcomeError(notFound)
    const updated = this.setLoginMembership(login, membership)
    return json(200, { login: updated.id, code: updated.code })
  }

  /** `setLoginMembership` (oauth/utils.ts): bind a login to one membership. */
  private setLoginMembership(
    login: LoginRecord,
    membership: WithId<ProjectMembership>,
  ): LoginRecord {
    if (login.revoked) throw new OperationOutcomeError(badRequest("Login revoked"))
    if (login.granted) throw new OperationOutcomeError(badRequest("Login granted"))
    if (login.membership) throw new OperationOutcomeError(badRequest("Login profile already set"))
    if (membership.user?.reference !== login.user?.reference)
      throw new OperationOutcomeError(badRequest("Invalid profile"))
    if (membership.active === false)
      throw new OperationOutcomeError(badRequest("Profile not active"))
    const project = this.readSystem<Project>(membership.project)
    if (!project) throw new OperationOutcomeError(notFound)
    const updated: LoginRecord = {
      ...login,
      project: createReference(project),
      membership: createReference(membership),
    }
    // Refresh tokens are disabled for super admins.
    if (project.superAdmin) updated.refreshSecret = undefined
    return this.saveLogin(updated)
  }

  private clientCredentialsFrom(
    request: Request,
    body: unknown,
  ): { clientId?: string; clientSecret?: string; error?: string } {
    const header = request.headers.get("authorization")
    if (header) {
      if (!header.startsWith("Basic ")) return { error: "Invalid authorization header" }
      let decoded = ""
      try {
        decoded = atob(header.split(" ")[1] ?? "")
      } catch {
        decoded = ""
      }
      const [clientId, clientSecret] = decoded.split(":")
      return { clientId, clientSecret }
    }
    return {
      clientId: stringField(body, "client_id"),
      clientSecret: stringField(body, "client_secret"),
    }
  }

  private async handleToken(request: Request, parsed: ParsedBody): Promise<Response> {
    if (parsed.kind !== "form")
      return respond(400, "Unsupported content type", "text/html; charset=utf-8")
    const body = parsed.value
    const grantType = stringField(body, "grant_type")
    if (!grantType) return tokenError("invalid_request", "Missing grant_type")
    if (grantType === "client_credentials") {
      const { clientId, clientSecret, error } = this.clientCredentialsFrom(request, body)
      if (error) return tokenError("invalid_request", error)
      if (!clientId) return tokenError("invalid_request", "Missing client_id")
      if (!clientSecret) return tokenError("invalid_request", "Missing client_secret")
      const client = this.readSystem<ClientApplication>({
        reference: `ClientApplication/${clientId}`,
      })
      if (!client || (client.status && client.status !== "active"))
        return tokenError("invalid_request", "Invalid client")
      if (!client.secret) return tokenError("invalid_request", "Invalid client")
      if (
        client.secret !== clientSecret &&
        (client.retiringSecret ?? client.secret) !== clientSecret
      ) {
        return tokenError("invalid_request", "Invalid secret")
      }
      const membership = this.membershipFor({ reference: `ClientApplication/${client.id}` })
      if (!membership) return tokenError("invalid_request", "Invalid client")
      const login = this.saveLogin({
        resourceType: "Login",
        id: this.idSource.uuid(),
        authMethod: "client",
        user: createReference(client),
        client: createReference(client),
        membership: createReference(membership),
        authTime: new Date(this.now()).toISOString(),
        granted: true,
        scope: stringField(body, "scope") || "openid",
        remoteAddress: remoteAddressOf(request),
        userAgent: request.headers.get("user-agent") ?? undefined,
      })
      return this.issueTokens(login, client)
    }
    if (grantType === "authorization_code") {
      const { clientId, clientSecret, error } = this.clientCredentialsFrom(request, body)
      if (error) return tokenError("invalid_request", error)
      const code = stringField(body, "code")
      if (!code) return tokenError("invalid_request", "Missing code")
      const login = this.logins.list({ where: (l) => l.code === code })[0]?.value
      if (!login) return tokenError("invalid_request", "Invalid code")
      if (clientId && login.client?.reference !== `ClientApplication/${clientId}`) {
        return tokenError("invalid_request", "Invalid client")
      }
      if (!login.membership) return tokenError("invalid_request", "Invalid profile")
      if (login.granted) {
        this.saveLogin({ ...login, revoked: true })
        return tokenError("invalid_grant", "Token already granted")
      }
      if (login.revoked) return tokenError("invalid_grant", "Token revoked")
      const client = clientId
        ? this.readSystem<ClientApplication>({ reference: `ClientApplication/${clientId}` })
        : this.readSystem<ClientApplication>(login.client)
      if ((clientId || login.client) && !client)
        return tokenError("invalid_request", "Invalid client")
      if (!client?.pkceOptional) {
        if (login.codeChallenge) {
          const verifier = stringField(body, "code_verifier")
          if (!verifier) return tokenError("invalid_request", "Missing code verifier")
          const ok =
            (login.codeChallengeMethod === "plain" && login.codeChallenge === verifier) ||
            (login.codeChallengeMethod === "S256" &&
              login.codeChallenge === (await sha256Base64Url(verifier)))
          if (!ok) return tokenError("invalid_request", "Invalid code verifier")
        } else {
          return tokenError("invalid_request", "Missing verification context")
        }
      } else if (clientSecret && client?.secret !== clientSecret) {
        return tokenError("invalid_request", "Invalid secret")
      }
      return this.issueTokens(login, client)
    }
    if (grantType === "refresh_token") {
      const refreshToken = stringField(body, "refresh_token")
      if (!refreshToken) return tokenError("invalid_request", "Invalid refresh token")
      const claims = await verifyJwt(await this.key(), refreshToken, {
        issuer: this.baseUrl,
        now: this.now(),
      })
      if (!claims) return tokenError("invalid_request", "Invalid refresh token")
      const login =
        typeof claims.login_id === "string" ? this.readLogin(claims.login_id) : undefined
      if (!login) return sendOutcome(badRequest("Not found"), this.requestIds(request))
      if (login.refreshSecret === undefined || !claims.refresh_secret)
        return tokenError("invalid_request", "Invalid refresh token")
      if (login.revoked) return tokenError("invalid_grant", "Token revoked")
      const membership = this.readSystem<ProjectMembership>(login.membership)
      if (membership?.active === false) return tokenError("access_denied", "Profile not active")
      if (login.refreshSecret !== claims.refresh_secret)
        return tokenError("invalid_request", "Invalid token")
      const client = login.client ? this.readSystem<ClientApplication>(login.client) : undefined
      if (login.client && !client) return tokenError("invalid_request", "Invalid client")
      const updated = this.saveLogin({ ...login, refreshSecret: this.idSource.secret(32) })
      return this.issueTokens(updated, client)
    }
    return tokenError("invalid_request", "Unsupported grant_type")
  }

  private handleMe(auth: AuthState): Response {
    const system = this.systemRepo()
    const profile = this.readSystem<Resource>(auth.membership.profile)
    const user = auth.membership.user?.reference?.startsWith("User/")
      ? this.readSystem<User>(auth.membership.user)
      : undefined
    const accessPolicy = getAccessPolicyForMembership(system, auth.project, auth.membership)
    const config = {
      resourceType: "UserConfiguration",
      menu: userConfigurationMenu(auth.project, auth.membership),
    }
    const memberships = user
      ? this.store
          .rows("ProjectMembership")
          .filter((row) => !row.deleted && row.content)
          .map((row) => row.content as WithId<ProjectMembership>)
          .filter(
            (m) =>
              m.user?.reference === getReferenceString(user) &&
              m.project?.reference === getReferenceString(auth.project),
          )
      : []
    return json(200, {
      user: user
        ? { resourceType: "User", id: user.id, email: user.email, identifier: user.identifier }
        : undefined,
      project: {
        resourceType: "Project",
        id: auth.project.id,
        name: auth.project.name,
        features: auth.project.features,
        description: auth.project.description,
        strictMode: auth.project.strictMode,
        superAdmin: auth.project.superAdmin,
      },
      membership: {
        resourceType: "ProjectMembership",
        id: auth.membership.id,
        identifier: auth.membership.identifier,
        user: auth.membership.user,
        profile: auth.membership.profile,
        admin: auth.membership.admin,
      },
      profile,
      config,
      accessPolicy,
      security: user
        ? {
            mfaEnrolled: Boolean(user.mfaEnrolled),
            mfaRequired: false,
            sessions: this.sessionsOf(user),
            memberships: memberships
              .filter((m) => m.active !== false)
              .map((m) => ({
                resourceType: "ProjectMembership",
                id: m.id,
                identifier: m.identifier,
                profile: m.profile,
                admin: m.admin,
              })),
          }
        : undefined,
    })
  }

  /** `getSessions` (auth/me.ts): the user's live logins from the last hour. */
  private sessionsOf(user: WithId<User>) {
    const since = this.now() - 3600 * 1000
    return this.logins
      .list({ order: "newest" })
      .map((entry) => entry.value)
      .filter((login) => login.user?.reference === getReferenceString(user))
      .filter((login) => Date.parse(login.meta?.lastUpdated as string) > since)
      .filter((login) => login.membership && !login.revoked)
      .map((login) => ({
        id: login.id,
        lastUpdated: login.meta?.lastUpdated,
        authMethod: login.authMethod,
        remoteAddress: login.remoteAddress,
        ...userAgentNames(login.userAgent),
        project: login.project,
      }))
  }

  private handleUserInfo(auth: AuthState): Response {
    const user = this.readSystem<User | ClientApplication>(auth.login.user)
    const profile = this.readSystem<
      Resource & {
        name?: { given?: string[]; family?: string }[]
        telecom?: { system?: string; value?: string }[]
      }
    >(auth.membership.profile)
    const scopes = (auth.login.scope ?? "").split(" ")
    const out: Record<string, unknown> = { sub: user?.id }
    if (scopes.includes("profile") && profile) {
      out.profile = getReferenceString(profile)
      const name = profile.name?.[0]
      if (name) {
        out.name = [...(name.given ?? []), name.family].filter(Boolean).join(" ")
        out.given_name = name.given?.[0]
        out.family_name = name.family
      }
    }
    if (scopes.includes("email") && user?.resourceType === "User") {
      out.email = user.email
      out.email_verified = Boolean(user.emailVerified)
    }
    return json(200, out)
  }

  // ------------------------------------------------------------------ admin API

  /** `/admin/projects/*` (admin/project.ts, client.ts, invite.ts), behind `verifyProjectAdmin`. */
  private async handleAdmin(
    auth: AuthState,
    request: Request,
    path: string,
    body: unknown,
  ): Promise<Response | undefined> {
    const match = /^\/admin\/projects\/([^/]+)(\/.*)?$/.exec(path)
    if (!match) return undefined
    if (!auth.project.superAdmin && !auth.membership.admin)
      throw new OperationOutcomeError(forbidden)
    const projectId = decodeURIComponent(match[1] as string)
    const rest = match[2] ?? ""
    const system = this.systemRepo()
    const repo = this.repoFor(auth, request)
    const ids = this.requestIds(request)
    if (request.method === "POST" && rest === "/client") {
      const name = stringField(body, "name")
      if (!name) return this.invalidRequest([{ field: "name", msg: "Client name is required" }])
      const project = auth.project.superAdmin
        ? ({ resourceType: "Project", id: projectId } as WithId<Project>)
        : auth.project
      const {
        project: _ignored,
        accessPolicy,
        ...fields
      } = (isRecord(body) ? body : {}) as Record<string, unknown>
      const client = await system.createResource<ClientApplication>({
        meta: { project: project.id, author: repo.getAuthor() },
        resourceType: "ClientApplication",
        secret: this.idSource.secret(32),
        ...(fields as Partial<ClientApplication>),
      } as ClientApplication)
      await system.createResource<ProjectMembership>({
        meta: { project: project.id },
        resourceType: "ProjectMembership",
        project: createReference(project),
        user: createReference(client),
        profile: createReference(client),
        accessPolicy: accessPolicy as Reference | undefined,
      } as ProjectMembership)
      return json(201, client)
    }
    if (request.method === "POST" && rest === "/invite") {
      const project = auth.project.superAdmin
        ? await system.readResource<Project>("Project", projectId)
        : auth.project
      return this.handleInvite(auth, request, project, body)
    }
    if (request.method === "GET" && rest === "") {
      const project = auth.project
      return json(200, {
        project: {
          id: project.id,
          name: project.name,
          setting: project.setting,
          secret: project.secret,
          site: project.site,
        },
      })
    }
    for (const [suffix, field] of [
      ["/settings", "setting"],
      ["/secrets", "secret"],
      ["/sites", "site"],
    ] as const) {
      if (request.method === "POST" && rest === suffix) {
        const result = await repo.updateResource({ ...auth.project, [field]: body } as Project)
        return json(200, result)
      }
    }
    const member = /^\/members\/([^/]+)$/.exec(rest)
    if (member) {
      const membershipId = decodeURIComponent(member[1] as string)
      const membership = await repo.readResource<ProjectMembership>(
        "ProjectMembership",
        membershipId,
      )
      if (membership.project?.reference !== getReferenceString(auth.project))
        return sendOutcome(forbidden, ids)
      if (request.method === "GET") return json(200, membership)
      if (request.method === "POST") {
        if (
          !isRecord(body) ||
          body.resourceType !== "ProjectMembership" ||
          body.id !== membershipId
        ) {
          return sendOutcome(forbidden, ids)
        }
        return json(200, await repo.updateResource(body as unknown as ProjectMembership))
      }
      if (request.method === "DELETE") {
        if (auth.project.owner?.reference === membership.user?.reference) {
          return sendOutcome(badRequest("Cannot delete the owner of the project"), ids)
        }
        const user = this.readSystem<User>(membership.user)
        if (user && user.project?.reference === getReferenceString(auth.project)) {
          await system.withTransaction(async (tx) => {
            const others = await tx.searchResources<ProjectMembership>({
              resourceType: "ProjectMembership",
              filters: [
                { code: "user", operator: Operator.EQUALS, value: getReferenceString(user) },
              ],
              count: 2,
            })
            await tx.deleteResource("ProjectMembership", membershipId)
            if (others.length === 1 && others[0]?.id === membershipId)
              await tx.deleteResource("User", user.id)
          })
        } else {
          await repo.deleteResource("ProjectMembership", membershipId)
        }
        return sendOutcome(allOk, ids)
      }
    }
    return undefined
  }

  /** `POST /admin/projects/:projectId/invite` (admin/invite.ts `inviteHandler` + `inviteUser`). */
  private async handleInvite(
    auth: AuthState,
    request: Request,
    project: WithId<Project>,
    body: unknown,
  ): Promise<Response> {
    const input = (isRecord(body) ? body : {}) as Record<string, unknown>
    const issues: { field: string; msg: string }[] = []
    const resourceType = stringField(input, "resourceType")
    if (!resourceType || !["Patient", "Practitioner", "RelatedPerson"].includes(resourceType)) {
      issues.push({ field: "resourceType", msg: "Resource type is required" })
    }
    if (!stringField(input, "firstName"))
      issues.push({ field: "firstName", msg: "First name is required" })
    if (!stringField(input, "lastName"))
      issues.push({ field: "lastName", msg: "Last name is required" })
    const rawEmail = stringField(input, "email")
    const externalId = stringField(input, "externalId")
    if (!(rawEmail && EMAIL.test(rawEmail)) && !externalId) {
      // express-validator `oneOf(…, { message })`: one grouped error, no field.
      issues.push({ field: "", msg: "Either email or externalId is required" })
    }
    const patientRef = isRecord(input.patient) ? stringField(input.patient, "reference") : undefined
    if (
      isRecord(input.patient) &&
      patientRef !== undefined &&
      !/^Patient\/[^/]+$/.test(patientRef)
    ) {
      issues.push({
        field: "patient.reference",
        msg: "Patient must be a reference to a Patient resource",
      })
    }
    const password = stringField(input, "password")
    if (input.password !== undefined) {
      if (!password || password.length < 8)
        issues.push({ field: "password", msg: "Password must be at least 8 characters" })
      else if (new TextEncoder().encode(password).length > 72) {
        issues.push({ field: "password", msg: "Password must be no more than 72 characters" })
      }
    }
    if (issues.length > 0) return this.invalidRequest(issues)

    const system = this.systemRepo()
    const email = rawEmail?.toLowerCase()
    const firstName = stringField(input, "firstName") as string
    const lastName = stringField(input, "lastName") as string
    const scope = stringField(input, "scope")
    const membershipInput = (
      isRecord(input.membership) ? input.membership : {}
    ) as Partial<ProjectMembership>
    const projectScoped =
      (resourceType === "Patient" && scope !== "server") ||
      Boolean(externalId) ||
      scope === "project"
    const userResource: User = {
      resourceType: "User",
      meta: projectScoped ? { project: project.id } : undefined,
      firstName,
      lastName,
      email,
      passwordHash: await this.hashPassword(password ?? this.idSource.secret(16)),
      project: projectScoped ? createReference(project) : undefined,
      mfaRequired: input.mfaRequired === true ? true : undefined,
    } as User

    let user: WithId<User>
    if (email) {
      if (input.forceNewMembership !== true) {
        const existing = await system.searchResources<ProjectMembership>({
          resourceType: "ProjectMembership",
          filters: [
            { code: "user:User.email", operator: Operator.EXACT, value: email },
            { code: "project", operator: Operator.EXACT, value: `Project/${project.id}` },
            userResource.project
              ? { code: "user:User.project", operator: Operator.MISSING, value: "true" }
              : {
                  code: "user:User.project",
                  operator: Operator.EXACT,
                  value: `Project/${project.id}`,
                },
          ],
        })
        if (existing.length > 0)
          throw new OperationOutcomeError(conflict("User is already a member of this project"))
      }
      const { resource } = await system.conditionalCreate(userResource, {
        resourceType: "User",
        filters: [
          { code: "email", operator: Operator.EXACT, value: email },
          userResource.project
            ? { code: "project", operator: Operator.EQUALS, value: `Project/${project.id}` }
            : { code: "project", operator: Operator.MISSING, value: "true" },
        ],
      })
      user = resource
    } else {
      user = await system.createResource(userResource)
    }

    let profile: WithId<Resource>
    if (membershipInput.profile) {
      profile = await system.readReference(membershipInput.profile as Reference)
      if (profile.meta?.project !== project.id)
        throw new OperationOutcomeError(badRequest("Profile does not belong to project"))
      if (profile.resourceType !== resourceType) {
        throw new OperationOutcomeError(badRequest("Profile resourceType does not match request"))
      }
    } else {
      const resource = {
        resourceType,
        meta: { project: project.id },
        name: [{ given: [firstName], family: lastName }],
        telecom: email ? [{ system: "email", use: "work", value: email }] : undefined,
      } as Resource & Record<string, unknown>
      if (resourceType === "RelatedPerson" && patientRef) {
        let patient: WithId<Resource>
        try {
          patient = await system.readReference({ reference: patientRef })
        } catch (error) {
          if (error instanceof OperationOutcomeError && error.outcome.id === "not-found") {
            throw new OperationOutcomeError(badRequest(`Patient ${patientRef} does not exist`))
          }
          throw error
        }
        if (patient.meta?.project !== project.id)
          throw new OperationOutcomeError(badRequest("Patient does not belong to project"))
        resource.patient = createReference(patient)
      }
      if (email) {
        const filters = [
          { code: "_project", operator: Operator.EQUALS, value: project.id },
          { code: "email", operator: Operator.EQUALS, value: email },
        ]
        if (resourceType === "RelatedPerson" && !patientRef) {
          const matches = await system.searchResources({
            resourceType: "RelatedPerson",
            filters,
            count: 2,
          })
          if (matches.length > 1) throw new OperationOutcomeError(multipleMatches)
          if (matches.length === 0)
            throw new OperationOutcomeError(
              badRequest("Patient is required to create a RelatedPerson"),
            )
          profile = matches[0] as WithId<Resource>
        } else {
          profile = (
            await system.conditionalCreate(resource, {
              resourceType: resourceType as "Patient",
              filters,
            })
          ).resource
        }
      } else {
        if (resourceType === "RelatedPerson" && !patientRef) {
          throw new OperationOutcomeError(
            badRequest("Patient is required to create a RelatedPerson"),
          )
        }
        profile = await system.createResource(resource)
      }
    }

    const partial: Partial<ProjectMembership> = {
      externalId,
      accessPolicy: input.accessPolicy as Reference | undefined,
      access: input.access as ProjectMembership["access"],
      admin: input.admin as boolean | undefined,
      invitedBy: auth.membership.user,
      ...membershipInput,
    } as Partial<ProjectMembership>
    const policyRefs = [
      ...(partial.accessPolicy ? [partial.accessPolicy] : []),
      ...((partial.access ?? []).map((a) => a.policy).filter(Boolean) as Reference[]),
    ]
    for (const reference of policyRefs) {
      const policy = this.readSystem<Resource>(reference)
      if (!policy)
        throw new OperationOutcomeError(
          badRequest(`Access policy ${reference.reference} does not exist`),
        )
      if (policy.meta?.project && policy.meta.project !== project.id) {
        throw new OperationOutcomeError(
          badRequest(`Access policy ${reference.reference} does not belong to this project`),
        )
      }
    }
    const membershipResource = {
      ...partial,
      resourceType: "ProjectMembership",
      project: createReference(project),
      user: createReference(user),
      profile: createReference(profile),
    } as ProjectMembership
    let membership: WithId<ProjectMembership>
    if (input.forceNewMembership === true) {
      membership = await system.createResource(membershipResource)
    } else {
      const result = await system.conditionalCreate(membershipResource, {
        resourceType: "ProjectMembership",
        filters: [
          { code: "user", operator: Operator.EQUALS, value: getReferenceString(user) },
          { code: "project", operator: Operator.EQUALS, value: getReferenceString(project) },
        ],
      })
      if (result.outcome.id !== "created")
        throw new OperationOutcomeError(conflict("User is already a member of this project"))
      membership = result.resource
    }
    return this.fhirJson(request, membership)
  }

  /** `sendFhirResponse(req, res, allOk, resource)` outside the FHIR router. */
  private fhirJson(request: Request, resource: Resource, status = 200): Response {
    const headers: Record<string, string> = {}
    if (resource.meta?.versionId) headers.etag = `W/"${resource.meta.versionId}"`
    if (resource.meta?.lastUpdated)
      headers["last-modified"] = new Date(resource.meta.lastUpdated).toUTCString()
    void request
    return respond(status, stringify(resource), "application/fhir+json; charset=utf-8", headers)
  }

  // ------------------------------------------------------------------ routing

  async fetch(incoming: Request): Promise<Response> {
    await this.ensureSeeded()
    const url = new URL(incoming.url)
    let path = url.pathname
    // `/api/...` is an alias for `/...` on the self-hosted server.
    if (path.startsWith("/api/")) path = path.slice(4)
    const ids = this.requestIds(incoming)
    const bytes = new Uint8Array(await incoming.clone().arrayBuffer())
    try {
      if (incoming.method === "GET" && path === "/")
        return respond(200, "OK", "text/plain; charset=utf-8")
      if (incoming.method === "GET" && path === "/healthcheck") {
        return json(200, {
          ok: true,
          version: MEDPLUM_VERSION,
          platform: "mockingbird",
          runtime: "mockingbird",
          postgres: true,
          redis: true,
          redisInstances: { default: true },
        })
      }
      if (incoming.method === "GET" && path === "/robots.txt") {
        return respond(200, "User-agent: *\nDisallow: /", "text/plain; charset=utf-8")
      }
      if (incoming.method === "GET" && path === "/.well-known/jwks.json") {
        const key = await this.key()
        return json(200, { keys: [{ ...key.publicJwk, alg: "ES384", kid: key.kid, use: "sig" }] })
      }
      if (incoming.method === "GET" && path === "/.well-known/openid-configuration") {
        return json(200, this.openidConfiguration())
      }
      if (
        incoming.method === "GET" &&
        /^(\/fhir\/R4)?\/\.well-known\/smart-configuration$/.test(path)
      ) {
        return json(200, this.smartConfiguration())
      }
      const storage = /^\/storage\/([^/]+)(?:\/([^/]+))?$/.exec(path)
      if (incoming.method === "GET" && storage)
        return await this.handleStorage(url, storage[1] as string)
      if (
        incoming.method === "GET" &&
        /^\/fhir\/R4\/(metadata|\$versions|%24versions)\/?$/.test(path)
      ) {
        return await handleFhir({
          repo: this.systemRepo(),
          ids,
          binaries: this.binaries(),
          url: path.slice("/fhir/R4".length),
          request: incoming,
          body: { kind: "none" },
          bytes: new Uint8Array(),
        })
      }

      let parsed: ParsedBody
      try {
        parsed = await parseBody(
          new Request(incoming.url, {
            method: incoming.method,
            headers: incoming.headers,
            body: bytes.length > 0 ? bytes : null,
          }),
        )
      } catch (error) {
        if (error instanceof BodyParseError) return sendOutcome(contentCouldNotBeParsed(), ids)
        throw error
      }
      const body = parsed.kind === "json" || parsed.kind === "form" ? parsed.value : undefined

      if (incoming.method === "POST" && path === "/auth/login")
        return await this.handleLogin(incoming, body)
      if (incoming.method === "POST" && path === "/auth/profile") return this.handleProfile(body)
      if (incoming.method === "POST" && path === "/oauth2/token")
        return await this.handleToken(incoming, parsed)

      const needsAuth =
        path === "/auth/me" ||
        path.startsWith("/fhir/R4") ||
        path.startsWith("/admin/") ||
        path === "/oauth2/userinfo" ||
        path === "/oauth2/logout"
      if (!needsAuth) return expressNotFound(incoming.method, url.pathname)

      const auth = await this.authenticate(incoming)
      if (!auth) {
        const scheme = incoming.headers.get("authorization")?.split(" ")[0] || "Bearer"
        const responseScheme = url.searchParams.get("_medplum-prompt-basic-auth") ? "Basic" : scheme
        return sendOutcome(unauthorized, ids, {
          "www-authenticate": `${responseScheme} realm="${this.baseUrl}"`,
        })
      }
      if (incoming.method === "GET" && path === "/auth/me") return this.handleMe(auth)
      if (
        path === "/oauth2/userinfo" &&
        (incoming.method === "GET" || incoming.method === "POST")
      ) {
        return this.handleUserInfo(auth)
      }
      if (path === "/oauth2/logout" && (incoming.method === "GET" || incoming.method === "POST")) {
        if (auth.login.id && this.readLogin(auth.login.id))
          this.saveLogin({ ...(auth.login as LoginRecord), revoked: true })
        return sendOutcome(allOk, ids)
      }
      if (path.startsWith("/admin/")) {
        const handled = await this.handleAdmin(auth, incoming, path, body)
        return handled ?? expressNotFound(incoming.method, url.pathname)
      }
      if (path.startsWith("/fhir/R4")) {
        const repo = this.repoFor(auth, incoming)
        const rest = url.pathname.slice(url.pathname.indexOf("/fhir/R4") + "/fhir/R4".length)
        return await handleFhir({
          repo,
          ids,
          binaries: this.binaries(),
          url: `${rest}${url.search}`,
          request: new Request(incoming.url, {
            method: incoming.method,
            headers: incoming.headers,
          }),
          body: parsed,
          bytes,
        })
      }
      return expressNotFound(incoming.method, url.pathname)
    } catch (error) {
      return this.errorResponse(error, ids)
    }
  }

  /** The server's global `errorHandler`: outcomes are sent as such, anything else is a 500. */
  private errorResponse(error: unknown, ids: RequestIds): Response {
    if (error instanceof OperationOutcomeError) return sendOutcome(error.outcome, ids)
    if (isRecord(error) && error.resourceType === "OperationOutcome")
      return sendOutcome(error as unknown as OperationOutcome, ids)
    if (error instanceof Error && /^(Invalid|Unable|Unknown|Unterminated)/.test(error.message)) {
      return sendOutcome(normalizeOperationOutcome(error), ids)
    }
    void normalizeErrorString
    return json(500, { msg: "Internal Server Error" })
  }

  /** `GET /storage/:id/:versionId` (storage/routes.ts): download through a presigned URL. */
  private async handleStorage(url: URL, binaryId: string): Promise<Response> {
    const signature = url.searchParams.get("Signature")
    if (!signature) return respond(401, "Unauthorized", "text/plain; charset=utf-8")
    const expires = url.searchParams.get("Expires")
    if (!expires || Math.floor(this.now() / 1000) > Number.parseInt(expires, 10)) {
      return respond(410, "URL has expired", "text/html; charset=utf-8")
    }
    const unsigned = new URL(url)
    unsigned.searchParams.delete("Signature")
    const expected = await this.sign(
      `GET ${unsigned.toString().replace(`${unsigned.origin}/`, this.baseUrl)}`,
    )
    if (expected !== signature) return respond(401, "Invalid signature", "text/html; charset=utf-8")
    let binary: Binary
    try {
      binary = this.systemRepo().readResourceImpl<Binary>("Binary", binaryId)
    } catch (error) {
      return this.errorResponse(error, {
        requestId: this.idSource.uuid(),
        traceId: this.idSource.uuid(),
      })
    }
    const bytes = this.binaries().read(binary)
    if (!bytes) return respond(404, "Not Found", "text/plain; charset=utf-8")
    return respond(200, bytes, binary.contentType ?? "application/octet-stream")
  }

  private openidConfiguration() {
    const base = this.baseUrl
    return {
      issuer: base,
      authorization_endpoint: `${base}oauth2/authorize`,
      token_endpoint: `${base}oauth2/token`,
      userinfo_endpoint: `${base}oauth2/userinfo`,
      jwks_uri: `${base}.well-known/jwks.json`,
      registration_endpoint: `${base}oauth2/register`,
      introspection_endpoint: `${base}oauth2/introspect`,
      id_token_signing_alg_values_supported: ["ES256", "ES384", "HS256", "RS256"],
      request_object_signing_alg_values_supported: ["none"],
      code_challenge_methods_supported: ["S256", "plain"],
      response_types_supported: ["code", "id_token", "token id_token"],
      subject_types_supported: ["pairwise", "public"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ],
      grant_types_supported: [
        "client_credentials",
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:token-exchange",
      ],
      scopes_supported: ["openid", "profile", "email", "phone", "address"],
    }
  }

  private smartConfiguration() {
    const base = this.baseUrl
    return {
      issuer: base,
      jwks_uri: `${base}.well-known/jwks.json`,
      authorization_endpoint: `${base}oauth2/authorize`,
      token_endpoint: `${base}oauth2/token`,
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "private_key_jwt",
      ],
      grant_types_supported: [
        "client_credentials",
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:token-exchange",
      ],
      introspection_endpoint: `${base}oauth2/introspect`,
      response_types_supported: ["code"],
      scopes_supported: [
        "patient/*.rs",
        "user/*.cruds",
        "openid",
        "fhirUser",
        "launch",
        "launch/patient",
        "offline_access",
        "online_access",
      ],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_signing_alg_values_supported: ["RS256", "RS384", "ES384"],
      capabilities: [
        "authorize-post",
        "permission-v1",
        "permission-v2",
        "client-confidential-asymmetric",
        "client-confidential-symmetric",
        "client-public",
        "context-banner",
        "context-ehr-patient",
        "context-ehr-encounter",
        "context-standalone-patient",
        "context-style",
        "launch-ehr",
        "launch-standalone",
        "permission-offline",
        "permission-patient",
        "permission-user",
        "sso-openid-connect",
      ],
    }
  }

  // ------------------------------------------------------------------ direct access (tests, admin)

  /** Mint an access token for a client application (default: the default project's client). */
  async accessToken(clientId: string | undefined = undefined): Promise<string> {
    clientId ??= this.defaultClientId()
    await this.ensureSeeded()
    const client = this.readSystem<ClientApplication>({
      reference: `ClientApplication/${clientId}`,
    })
    if (!client?.secret) throw new Error(`medplum: no client application ${clientId}`)
    const response = await this.handleToken(
      new Request(`${this.baseUrl}oauth2/token`, { method: "POST" }),
      {
        kind: "form",
        value: {
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: client.secret,
        },
      },
    )
    const payload = (await response.json()) as { access_token?: string }
    if (!payload.access_token) throw new Error(`medplum: could not mint a token for ${clientId}`)
    return payload.access_token
  }

  /** What a suite needs to sign in to this namespace: the seeded project, client and super admin. */
  describe() {
    const project = this.options.project
    const superAdmin = this.options.superAdmin ?? {}
    return {
      baseUrl: this.baseUrl,
      project:
        project === false
          ? null
          : {
              id: project?.id ?? DEFAULT_PROJECT_ID,
              clientId: project?.clientId ?? DEFAULT_CLIENT_ID,
              clientSecret: project?.clientSecret ?? DEFAULT_CLIENT_SECRET,
            },
      superAdmin: {
        email: (superAdmin.email ?? SUPER_ADMIN_EMAIL).toLowerCase(),
        password: superAdmin.password ?? SUPER_ADMIN_PASSWORD,
        clientId: superAdmin.clientId ?? SUPER_ADMIN_CLIENT_ID,
        clientSecret: superAdmin.clientSecret ?? SUPER_ADMIN_CLIENT_SECRET,
      },
    }
  }

  /**
   * Create or replace a ClientApplication with a chosen id and secret (default: a generated
   * secret) in a project (default: the default project), with its membership.
   */
  async putClient(input: {
    id: string
    secret?: string
    name?: string
    projectId?: string
    admin?: boolean
  }): Promise<{ id: string; secret: string; projectId: string }> {
    await this.ensureSeeded()
    const system = this.systemRepo()
    const projectId =
      input.projectId ??
      (this.options.project === false ? undefined : this.options.project?.id) ??
      DEFAULT_PROJECT_ID
    const project = system.readResourceImpl<Project>("Project", projectId)
    const secret = input.secret ?? this.idSource.secret(32)
    const client = await system.updateResource<ClientApplication>({
      meta: { project: project.id },
      resourceType: "ClientApplication",
      id: input.id,
      name: input.name ?? `Client ${input.id}`,
      secret,
    })
    const existing = this.membershipFor({ reference: `ClientApplication/${client.id}` })
    const membership: ProjectMembership = {
      ...(existing ?? {}),
      meta: { project: project.id },
      resourceType: "ProjectMembership",
      project: createReference(project),
      user: createReference(client),
      profile: createReference(client),
      ...(input.admin === false ? { admin: undefined } : { admin: true }),
    }
    if (existing) await system.updateResource({ ...membership, id: existing.id })
    else await system.createResource(membership)
    return { id: client.id, secret, projectId: project.id }
  }

  defaultProjectId(): string {
    const project = this.options.project
    return (project !== false && project?.id) || DEFAULT_PROJECT_ID
  }

  defaultClientId(): string {
    const project = this.options.project
    return (
      (project !== false && project?.clientId) ||
      (project === false ? SUPER_ADMIN_CLIENT_ID : DEFAULT_CLIENT_ID)
    )
  }

  /** Every current, non-deleted resource of a type across all projects. */
  async resources<T extends Resource = Resource>(
    resourceType: T["resourceType"],
  ): Promise<WithId<T>[]> {
    await this.ensureSeeded()
    return this.store
      .rows(resourceType)
      .filter((row) => !row.deleted && row.content)
      .map((row) => row.content as WithId<T>)
  }

  /** Write a resource as the system (keeps a given id; defaults `meta.project` to the default project). */
  async putResource<T extends Resource>(
    resource: T,
    projectId: string | undefined = undefined,
  ): Promise<WithId<T>> {
    projectId ??= this.defaultProjectId()
    await this.ensureSeeded()
    const system = this.systemRepo()
    const withProject = {
      ...resource,
      meta: { ...resource.meta, project: resource.meta?.project ?? projectId },
    } as T
    if (withProject.id) return system.updateResource(withProject)
    return system.createResource(withProject)
  }

  /** Search as the system repository (every project). */
  async systemSearch(query: string): Promise<WithId<Resource>[]> {
    await this.ensureSeeded()
    const { parseSearchRequest } = await import("@medplum/core")
    return this.systemRepo().searchResources(parseSearchRequest(query))
  }

  /** Revoke every login (all issued tokens stop working). */
  revokeAllLogins(): number {
    let count = 0
    for (const entry of this.logins.list()) {
      if (!entry.value.revoked) {
        this.logins.insert(entry.id, { ...entry.value, revoked: true })
        count++
      }
    }
    return count
  }

  /** The operator keys of `@medplum/core`, re-exported for fixture building. */
  static readonly Operator = Operator
}

/**
 * `req.ip` with `trust proxy` 1: the last `X-Forwarded-For` hop, else the socket peer — which
 * an in-process `fetch` does not have, so loopback.
 */
const remoteAddressOf = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for")
  const hops = forwarded
    ?.split(",")
    .map((hop) => hop.trim())
    .filter(Boolean)
  return hops?.at(-1) ?? "127.0.0.1"
}

/** Browser and OS names the way Bowser reports them for the common user agents. */
const userAgentNames = (userAgent: string | undefined): { browser?: string; os?: string } => {
  if (!userAgent) return {}
  const browser = /Edg\//.test(userAgent)
    ? "Microsoft Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : ""
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /iPhone|iPad/.test(userAgent)
      ? "iOS"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Android/.test(userAgent)
          ? "Android"
          : /Linux/.test(userAgent)
            ? "Linux"
            : undefined
  return { browser, ...(os ? { os } : {}) }
}

/** `getUserConfigurationMenu` (auth/me.ts): the default menu for a membership. */
const userConfigurationMenu = (project: Project, membership: ProjectMembership) => {
  const favorites = [
    "Patient",
    "Practitioner",
    "Organization",
    "ServiceRequest",
    "DiagnosticReport",
    "Questionnaire",
  ]
  const menu = [
    { title: "Favorites", link: favorites.map((name) => ({ name, target: `/${name}` })) },
  ]
  const link = [
    { name: "Project", target: "/admin/project" },
    { name: "AccessPolicy", target: "/AccessPolicy" },
    { name: "Subscriptions", target: "/Subscription" },
    { name: "Batch", target: "/batch" },
  ]
  if (!project.superAdmin) link.push({ name: "Config", target: "/admin/config" })
  if (membership.admin) menu.push({ title: "Admin", link })
  if (project.superAdmin) {
    menu.push({
      title: "Super Admin",
      link: [
        { name: "Projects", target: "/Project" },
        { name: "Super Config", target: "/admin/super" },
        { name: "Super AsyncJob", target: "/admin/super/asyncjob" },
        { name: "Super DB", target: "/admin/super/db" },
      ],
    })
  }
  return menu
}
