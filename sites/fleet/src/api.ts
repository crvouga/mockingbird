import {
  type Declaration,
  DeclarationError,
  declaredFleets,
  parseDeclaration,
} from "@crvouga/mockingbird-adapter-node"
import type { Auth, Principal } from "./auth.js"
import type { Config, Limits } from "./config.js"
import { DURABILITY, type EmulatorSpec, type Engine } from "./engine.js"
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from "./errors.js"
import { CATALOG } from "./generated/catalog.js"
import { newId, newSecret, randomString, SLUG, sha256, slugify } from "./ids.js"
import { effectiveLimits, type UsageMeter } from "./limits.js"
import type { RouteDoc } from "./openapi.js"
import { type Database, type Row, UniqueViolation } from "./store/schema.js"

export const ROLES = ["viewer", "member", "admin", "owner"] as const
export type Role = (typeof ROLES)[number]
const rank = (role: string | null | undefined) => ROLES.indexOf(role as Role)

/** A principal's role in an organization; project keys count only inside their project. */
export async function roleOf(
  db: Database,
  principal: Principal,
  orgId: string,
  projectId?: string,
): Promise<string | undefined> {
  if (principal.kind === "user") {
    const [membership] = await db.find("memberships", { org_id: orgId, user_id: principal.user.id })
    return membership?.role
  }
  const key = principal.key
  if (key.org_id !== orgId) return undefined
  if (key.scope === "project" && key.project_id !== projectId) return undefined
  return key.role ?? undefined
}

export const hasRole = (role: string | undefined, minimum: Role) =>
  ROLES.indexOf(role as Role) >= ROLES.indexOf(minimum)

export type Deps = {
  db: Database
  engine: Engine
  auth: Auth
  config: Pick<
    Config,
    "publicUrl" | "fleetUrl" | "oidc" | "devLogin" | "limits" | "orgsPerUser" | "operatorTokenHash"
  >
  meter: UsageMeter
  now: () => number
  /** Called when a fleet's configuration changes, so cached copies are dropped. */
  fleetChanged(slug: string): void
}

export type Context = {
  /** The request carried the operator token. Only operator routes look at this. */
  operator: boolean
  /** Set by a handler to the organization it acted in, so the change is written to its audit log. */
  orgId?: string
  deps: Deps
  principal: Principal | undefined
  params: Record<string, string>
  body: Record<string, unknown>
  request: Request
  /** The `operationId` of the route being handled. */
  operationId: string
}

/**
 * Operations that change what a `mockingbird.yaml` declares. In an organization managed by one
 * they are refused: the file is the only way to change them, so the file and the fleet agree.
 * Operating a fleet (resetting or saving state) and managing people and keys stay available.
 */
export const DECLARED_OPERATIONS: ReadonlySet<string> = new Set([
  "updateOrg",
  "createProject",
  "updateProject",
  "deleteProject",
  "createFleet",
  "updateFleet",
  "deleteFleet",
  "putEmulator",
  "updateEmulator",
  "deleteEmulator",
])

export type Managed = { declaration: Declaration; appliedAt: string; appliedBy: string }
/** How an organization is managed, or null when it is configured by hand. */
export const managedBy = (row: Row<"orgs">): Managed | null =>
  (row.manifest as Managed | null | undefined) ?? null

export type Route = RouteDoc & { handler(context: Context): Promise<unknown> }

type Emulators = Record<string, EmulatorSpec>
const INVITE_DAYS = 7

/** Hosts a hosted emulator must never call: loopback, link-local and private-network names. */
const PRIVATE_HOST = /^(localhost|.*\.(local|internal|localhost|lan|home|corp))$|^[\d.]+$|^\[.*\]$/i

function webhookOrigins(input: unknown): string[] | undefined {
  if (input === undefined) return undefined
  return (input as string[]).map((value) => {
    let url: URL | undefined
    try {
      url = new URL(value)
    } catch {}
    if (
      !url ||
      url.origin !== value ||
      url.protocol !== "https:" ||
      !url.hostname.includes(".") ||
      PRIVATE_HOST.test(url.hostname)
    )
      throw badRequest(
        `webhookOrigins: "${value}" must be a public https origin, e.g. https://app.example.com`,
      )
    return value
  })
}

export function createRoutes(): Route[] {
  const iso = (deps: Deps) => new Date(deps.now()).toISOString()

  // ---- access ----------------------------------------------------------------------------

  const user = (context: Context) => {
    if (!context.principal) throw unauthorized()
    if (context.principal.kind !== "user")
      throw forbidden("This endpoint needs a signed-in user or a personal token")
    return context.principal.user
  }

  const roleIn = async (context: Context, orgId: string, projectId?: string) => {
    if (!context.principal) throw unauthorized()
    return roleOf(context.deps.db, context.principal, orgId, projectId)
  }

  /** Throws 404, not 403, when the caller cannot see the resource at all. */
  const requireRole = async (
    context: Context,
    minimum: Role,
    orgId: string,
    what: string,
    projectId?: string,
  ) => {
    const role = await roleIn(context, orgId, projectId)
    if (rank(role) < 0) throw notFound(what)
    if (rank(role) < rank(minimum)) throw forbidden(`This needs the ${minimum} role or higher`)
    return role as Role
  }

  /** Suspended organizations can still read and delete, never create or change. */
  const assertActive = (context: Context, row: Row<"orgs">, minimum: Role) => {
    context.orgId = row.id
    if (managedBy(row) && DECLARED_OPERATIONS.has(context.operationId))
      throw new HttpError(
        409,
        "managed_by_declaration",
        `This organization is configured by mockingbird.yaml, so this cannot be changed by hand. Change the file and apply it (PUT /api/v1/manifest), or release the organization (DELETE /api/v1/orgs/${row.id}/manifest).`,
      )
    if (
      row.suspended !== null &&
      minimum !== "viewer" &&
      !["GET", "HEAD", "DELETE"].includes(context.request.method)
    )
      throw new HttpError(
        403,
        "org_suspended",
        `This organization is suspended: ${row.suspended}. Contact the operator of this service.`,
      )
  }
  const limitsOf = (deps: Deps, row: Row<"orgs">) => effectiveLimits(deps.config.limits, row.limits)
  /** Refuse to go past a quota, naming it and how it is raised. */
  const quota = (
    limit: number,
    current: number,
    name: keyof Limits | "orgsPerUser",
    what: string,
  ) => {
    if (limit > 0 && current >= limit)
      throw new HttpError(
        403,
        "quota_exceeded",
        `${what} (limit ${limit}). Delete something, or ask the operator to raise ${name}.`,
        { limit: name, max: limit, current },
      )
  }
  const orgOf = async (context: Context, orgId: string, minimum: Role) => {
    const row = await context.deps.db.get("orgs", orgId)
    if (!row) throw notFound("Organization")
    assertActive(context, row, minimum)
    return row
  }

  const org = async (context: Context, minimum: Role) => {
    const row = await context.deps.db.get("orgs", context.params.orgId ?? "")
    if (!row) {
      if (!context.principal) throw unauthorized()
      throw notFound("Organization")
    }
    const role = await requireRole(context, minimum, row.id, "Organization")
    assertActive(context, row, minimum)
    return { row, role }
  }
  const project = async (context: Context, minimum: Role) => {
    const row = await context.deps.db.get("projects", context.params.projectId ?? "")
    if (!row) {
      if (!context.principal) throw unauthorized()
      throw notFound("Project")
    }
    await requireRole(context, minimum, row.org_id, "Project", row.id)
    return { row, org: await orgOf(context, row.org_id, minimum) }
  }
  const fleet = async (context: Context, minimum: Role) => {
    const row = await context.deps.db.get("fleets", context.params.fleetId ?? "")
    if (!row) {
      if (!context.principal) throw unauthorized()
      throw notFound("Fleet")
    }
    await requireRole(context, minimum, row.org_id, "Fleet", row.project_id)
    return { row, org: await orgOf(context, row.org_id, minimum) }
  }

  // ---- views -----------------------------------------------------------------------------

  const viewOrg = (row: Row<"orgs">, role?: string) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
    suspended: row.suspended,
    managed: managedBy(row)
      ? { appliedAt: managedBy(row)?.appliedAt, appliedBy: managedBy(row)?.appliedBy }
      : null,
    ...(role ? { role } : {}),
  })
  const viewProject = (row: Row<"projects">) => ({
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
  })
  const viewKey = (row: Row<"api_keys">, secret?: string) => ({
    id: row.id,
    name: row.name,
    scope: row.scope,
    role: row.role,
    orgId: row.org_id,
    projectId: row.project_id,
    prefix: row.prefix,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(secret ? { key: secret } : {}),
  })
  const viewInvite = (row: Row<"invites">, deps: Deps, token?: string) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(token ? { token, acceptUrl: `${deps.config.publicUrl}/invite/${token}` } : {}),
  })
  const fleetUrl = (deps: Deps, slug: string) => `${deps.config.fleetUrl}/f/${slug}`
  const viewFleet = (row: Row<"fleets">, deps: Deps) => ({
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    slug: row.slug,
    name: row.name,
    access: row.access,
    requestsPerMinute: (row.options as { requestsPerMinute?: number }).requestsPerMinute ?? null,
    url: fleetUrl(deps, row.slug),
    emulators: Object.fromEntries(
      Object.entries(row.emulators as Emulators).map(([name, spec]) => [
        name,
        {
          ...spec,
          url: `${fleetUrl(deps, row.slug)}/${name}`,
          status: deps.engine.status(row.id, name, spec),
        },
      ]),
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  // ---- helpers ---------------------------------------------------------------------------

  /** Insert with a slug: the caller's, or one derived from the name with a random suffix. */
  const withSlug = async <T>(
    given: unknown,
    name: string,
    what: string,
    insert: (slug: string) => Promise<T>,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const slug =
        typeof given === "string"
          ? given
          : `${slugify(name) || what.toLowerCase()}-${randomString(6)}`
      try {
        return await insert(slug)
      } catch (error) {
        if (!(error instanceof UniqueViolation) || error.constraint === "id") throw error
        if (typeof given === "string" || attempt >= 4)
          throw conflict(`${what} slug "${slug}" is already taken`)
      }
    }
  }

  const emulatorName = (context: Context) => {
    const name = context.params.name ?? ""
    if (!SLUG.test(name))
      throw badRequest("Emulator names are lowercase letters, digits and hyphens")
    return name
  }

  /** Normalize and check one emulator's configuration, including its settings schema. */
  const emulatorSpec = async (
    deps: Deps,
    input: Record<string, unknown>,
    current?: EmulatorSpec,
  ): Promise<EmulatorSpec> => {
    const target = (input.target ?? current?.target) as string
    const settings = (
      "settings" in input
        ? input.settings
        : current?.target === target
          ? current?.settings
          : undefined
    ) as Record<string, unknown> | undefined
    const checked = await deps.engine.checkSettings(target, settings)
    const merged = { ...current, ...input }
    const origins = webhookOrigins(merged.webhookOrigins)
    return {
      target,
      durability: (merged.durability ?? "buffered") as EmulatorSpec["durability"],
      ...(typeof merged.seed === "string" ? { seed: merged.seed } : {}),
      ...(checked !== undefined ? { settings: checked } : {}),
      ...(typeof merged.flushIntervalMs === "number"
        ? { flushIntervalMs: merged.flushIntervalMs }
        : {}),
      ...(origins?.length ? { webhookOrigins: origins } : {}),
    }
  }

  /** Change a fleet's emulators with optimistic concurrency, so parallel edits never clobber. */
  const editEmulators = async (
    context: Context,
    edit: (emulators: Emulators, row: Row<"fleets">) => Promise<Emulators> | Emulators,
  ) => {
    const { deps } = context
    for (let attempt = 0; attempt < 6; attempt++) {
      const { row, org: owner } = await fleet(context, "member")
      const before = Object.keys(row.emulators as Emulators).length
      const emulators = await edit({ ...(row.emulators as Emulators) }, row)
      if (Object.keys(emulators).length > before)
        quota(
          limitsOf(deps, owner).emulatorsPerFleet,
          before,
          "emulatorsPerFleet",
          "This fleet has its maximum number of emulators",
        )
      const updated = await deps.db.update(
        "fleets",
        row.id,
        { emulators, updated_at: iso(deps), revision: newSecret() },
        { revision: row.revision },
      )
      if (updated) {
        deps.fleetChanged(updated.slug)
        return updated
      }
    }
    throw conflict("The fleet changed while it was being updated; try again")
  }

  /** A fleet may lower its own request rate, never raise it past the organization's ceiling. */
  const fleetOptions = (body: Record<string, unknown>, limits: Limits) => {
    const value = body.requestsPerMinute
    if (typeof value !== "number") return {}
    if (limits.fleetRequestsPerMinute > 0 && value > limits.fleetRequestsPerMinute)
      throw badRequest(
        `requestsPerMinute cannot exceed this organization's ceiling of ${limits.fleetRequestsPerMinute}`,
      )
    return { requestsPerMinute: value }
  }

  const emulatorRef = async (deps: Deps, row: Row<"fleets">, name: string) => {
    const spec = (row.emulators as Emulators)[name]
    if (!spec) throw notFound("Emulator")
    const owner = await deps.db.get("orgs", row.org_id)
    return {
      fleetId: row.id,
      name,
      spec,
      baseUrl: `${fleetUrl(deps, row.slug)}/${name}`,
      maxStateBytes: effectiveLimits(deps.config.limits, owner?.limits).stateBytes,
    }
  }

  const deleteFleet = async (deps: Deps, row: Row<"fleets">) => {
    await deps.db.remove("fleets", { id: row.id })
    deps.fleetChanged(row.slug)
    await deps.engine.deleteFleet(row.id)
  }
  const deleteProject = async (deps: Deps, row: Row<"projects">) => {
    for (const child of await deps.db.find("fleets", { project_id: row.id }))
      await deleteFleet(deps, child)
    await deps.db.remove("api_keys", { project_id: row.id })
    await deps.db.remove("projects", { id: row.id })
  }

  // ---- mockingbird.yaml -----------------------------------------------------------------

  type Change = {
    action: "create" | "update" | "delete" | "unchanged"
    kind: string
    name: string
    detail?: string
  }

  const actorName = (context: Context) =>
    context.principal?.kind === "user"
      ? (context.principal.user.email ?? context.principal.user.id)
      : `API key ${context.principal?.key.name ?? ""}`.trim()

  /** The emulators Fleet Cloud runs for a declared fleet: its services, minus the local-only ones. */
  const declaredEmulators = async (
    deps: Deps,
    path: string,
    services: Declaration["projects"][string]["fleets"][string]["services"],
  ) => {
    const emulators: Emulators = {}
    for (const [name, service] of Object.entries(services)) {
      if (service.local) continue
      try {
        emulators[name] = await emulatorSpec(deps, {
          target: service.target ?? name,
          ...(service.durability !== undefined ? { durability: service.durability } : {}),
          ...(service.seed !== undefined ? { seed: service.seed } : {}),
          ...(service.settings !== undefined ? { settings: service.settings } : {}),
          ...(service.flushIntervalMs !== undefined
            ? { flushIntervalMs: service.flushIntervalMs }
            : {}),
          ...(service.webhookOrigins !== undefined
            ? { webhookOrigins: service.webhookOrigins }
            : {}),
        })
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 400) throw error
        const hint = ["unknown_emulator", "unsupported_emulator"].includes(error.code)
          ? " Fleet Cloud runs HTTP emulators only; mark a service that should run only in a local fleet with `local: true`."
          : ""
        throw badRequest(`${path}.services.${name}: ${error.message}.${hint}`)
      }
    }
    return emulators
  }

  /** What differs between two emulators, in words. */
  const emulatorDiff = (before: EmulatorSpec, after: EmulatorSpec) =>
    (["target", "durability", "seed", "settings", "flushIntervalMs", "webhookOrigins"] as const)
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) =>
        key === "settings" || key === "webhookOrigins"
          ? key
          : `${key} ${before[key] ?? "default"} → ${after[key] ?? "default"}`,
      )
      .join(", ")

  /**
   * Make an organization match a declaration, or (dry run) say what that would take. The
   * declaration is the whole truth for the organization's projects, fleets and emulators:
   * anything it does not declare is deleted, which is done only when `prune` is given.
   */
  const applyDeclaration = async (context: Context) => {
    const { deps, principal } = context
    if (!principal) throw unauthorized()
    const query = new URL(context.request.url).searchParams
    const dryRun = query.get("dryRun") === "true"
    const prune = query.get("prune") === "true"
    let declaration: Declaration
    try {
      declaration = parseDeclaration(context.body)
    } catch (error) {
      if (!(error instanceof DeclarationError)) throw error
      const details = error.issues.map(
        (issue) => `${issue.path || "(top level)"}: ${issue.message}`,
      )
      throw badRequest(`mockingbird.yaml is invalid: ${details[0]}`, details)
    }

    const [existing] = await deps.db.find("orgs", { slug: declaration.organization })
    if (existing) {
      // 404 for an organization the caller cannot see, as everywhere else.
      const role = await requireRole(context, "admin", existing.id, "Organization")
      void role
      context.orgId = existing.id
      if (existing.suspended !== null)
        throw new HttpError(
          403,
          "org_suspended",
          `This organization is suspended: ${existing.suspended}. Contact the operator of this service.`,
        )
    } else if (principal.kind !== "user")
      throw notFound(
        `Organization "${declaration.organization}" (an API key cannot create one; apply once with a personal token)`,
      )
    else
      quota(
        deps.config.orgsPerUser,
        (await deps.db.find("memberships", { user_id: principal.user.id })).length,
        "orgsPerUser",
        "You belong to the maximum number of organizations",
      )

    const limits = existing ? limitsOf(deps, existing) : deps.config.limits
    const changes: Change[] = []
    const orgName = declaration.name ?? existing?.name ?? declaration.organization
    changes.push({
      action: !existing ? "create" : existing.name !== orgName ? "update" : "unchanged",
      kind: "organization",
      name: declaration.organization,
      ...(existing && existing.name !== orgName
        ? { detail: `name ${existing.name} → ${orgName}` }
        : {}),
    })

    const projects = existing ? await deps.db.find("projects", { org_id: existing.id }) : []
    const fleets = existing ? await deps.db.find("fleets", { org_id: existing.id }) : []
    const projectBySlug = new Map(projects.map((row) => [row.slug, row]))
    const fleetBySlug = new Map(fleets.map((row) => [row.slug, row]))

    for (const [slug, project] of Object.entries(declaration.projects)) {
      const current = projectBySlug.get(slug)
      const name = project.name ?? current?.name ?? slug
      changes.push({
        action: !current ? "create" : current.name !== name ? "update" : "unchanged",
        kind: "project",
        name: slug,
        ...(current && current.name !== name ? { detail: `name ${current.name} → ${name}` } : {}),
      })
    }
    quota(
      limits.projectsPerOrg,
      Object.keys(declaration.projects).length - 1,
      "projectsPerOrg",
      "mockingbird.yaml declares more projects than this organization may have",
    )

    const declared = declaredFleets(declaration)
    quota(
      limits.fleetsPerOrg,
      declared.length - 1,
      "fleetsPerOrg",
      "mockingbird.yaml declares more fleets than this organization may have",
    )
    const desired = new Map<
      string,
      {
        project: string
        name: string
        access: string
        options: Record<string, unknown>
        emulators: Emulators
      }
    >()
    for (const { project, slug, fleet } of declared) {
      const path = `projects.${project}.fleets.${slug}`
      const current = fleetBySlug.get(slug)
      if (!current) {
        const [taken] = await deps.db.find("fleets", { slug })
        if (taken)
          throw conflict(
            `${path}: the fleet slug "${slug}" is already used by another organization; fleet slugs are unique across Fleet Cloud`,
          )
      }
      const emulators = await declaredEmulators(deps, path, fleet.services)
      quota(
        limits.emulatorsPerFleet,
        Object.keys(emulators).length - 1,
        "emulatorsPerFleet",
        `${path} declares more emulators than a fleet may have`,
      )
      const options = fleetOptions({ requestsPerMinute: fleet.requestsPerMinute }, limits)
      const next = {
        project,
        name: fleet.name ?? current?.name ?? slug,
        access: fleet.access ?? "open",
        options,
        emulators,
      }
      desired.set(slug, next)

      const before = (current?.emulators ?? {}) as Emulators
      const settings: string[] = []
      if (current) {
        if (current.name !== next.name) settings.push(`name ${current.name} → ${next.name}`)
        if (current.access !== next.access)
          settings.push(`access ${current.access} → ${next.access}`)
        const rate = (current.options as { requestsPerMinute?: number }).requestsPerMinute
        if (rate !== fleet.requestsPerMinute)
          settings.push(
            `requestsPerMinute ${rate ?? "ceiling"} → ${fleet.requestsPerMinute ?? "ceiling"}`,
          )
        if (projectBySlug.get(project)?.id !== current.project_id)
          settings.push(`project → ${project}`)
      }
      changes.push({
        action: !current ? "create" : settings.length > 0 ? "update" : "unchanged",
        kind: "fleet",
        name: slug,
        ...(settings.length > 0 ? { detail: settings.join(", ") } : {}),
      })
      for (const [name, spec] of Object.entries(emulators)) {
        const was = before[name]
        const detail = was
          ? emulatorDiff(was, spec)
          : spec.target === name
            ? spec.durability
            : `${spec.target}, ${spec.durability}`
        changes.push({
          action: !was ? "create" : detail ? "update" : "unchanged",
          kind: "emulator",
          name: `${slug}/${name}`,
          ...(detail
            ? {
                detail:
                  was && was.target !== spec.target ? `${detail}; its state is reset` : detail,
              }
            : {}),
        })
      }
      for (const name of Object.keys(before))
        if (!emulators[name])
          changes.push({
            action: "delete",
            kind: "emulator",
            name: `${slug}/${name}`,
            detail: "its stored state is erased",
          })
    }
    for (const row of fleets)
      if (!desired.has(row.slug))
        changes.push({
          action: "delete",
          kind: "fleet",
          name: row.slug,
          detail: "its URL stops answering and its stored state is erased",
        })
    for (const row of projects)
      if (!declaration.projects[row.slug])
        changes.push({ action: "delete", kind: "project", name: row.slug })

    const deletions = changes.filter((change) => change.action === "delete")
    if (dryRun) return { organization: existing?.id ?? null, applied: false, changes }
    if (deletions.length > 0 && !prune)
      throw new HttpError(
        409,
        "prune_required",
        `Applying this file would delete ${deletions.map((change) => `${change.kind} ${change.name}`).join(", ")}. Declare them in mockingbird.yaml to keep them, or apply with prune=true to delete them.`,
        changes,
      )

    // ---- make it so
    const now = iso(deps)
    let org = existing
    if (!org) {
      org = {
        id: newId("org"),
        slug: declaration.organization,
        name: orgName,
        limits: {},
        manifest: null,
        suspended: null,
        created_at: now,
      }
      try {
        await deps.db.insert("orgs", org)
      } catch (error) {
        if (error instanceof UniqueViolation)
          throw conflict(`Organization slug "${org.slug}" was just taken`)
        throw error
      }
      await deps.db.insert("memberships", {
        id: newId("mem"),
        org_id: org.id,
        user_id: (principal as { user: Row<"users"> }).user.id,
        role: "owner",
        created_at: now,
      })
      context.orgId = org.id
    }
    const projectIds = new Map<string, string>()
    for (const [slug, project] of Object.entries(declaration.projects)) {
      const current = projectBySlug.get(slug)
      const name = project.name ?? current?.name ?? slug
      if (current) {
        if (current.name !== name) await deps.db.update("projects", current.id, { name })
        projectIds.set(slug, current.id)
      } else {
        const id = newId("prj")
        await deps.db.insert("projects", { id, org_id: org.id, slug, name, created_at: now })
        projectIds.set(slug, id)
      }
    }
    for (const [slug, next] of desired) {
      const current = fleetBySlug.get(slug)
      const projectId = projectIds.get(next.project) as string
      if (!current) {
        await deps.db.insert("fleets", {
          id: newId("flt"),
          org_id: org.id,
          project_id: projectId,
          slug,
          name: next.name,
          access: next.access,
          emulators: next.emulators,
          options: next.options,
          revision: newSecret(),
          created_at: now,
          updated_at: now,
        })
        continue
      }
      const before = current.emulators as Emulators
      await deps.db.update("fleets", current.id, {
        project_id: projectId,
        name: next.name,
        access: next.access,
        emulators: next.emulators,
        options: next.options,
        updated_at: now,
        revision: newSecret(),
      })
      deps.fleetChanged(slug)
      // An emulator that is gone, or is now a different emulator, cannot keep its old state.
      for (const [name, was] of Object.entries(before))
        if (next.emulators[name]?.target !== was.target) await deps.engine.reset(current.id, name)
    }
    for (const row of fleets) if (!desired.has(row.slug)) await deleteFleet(deps, row)
    for (const row of projects) if (!declaration.projects[row.slug]) await deleteProject(deps, row)
    const managed: Managed = { declaration, appliedAt: now, appliedBy: actorName(context) }
    await deps.db.update("orgs", org.id, { name: orgName, manifest: managed })
    for (const slug of desired.keys()) deps.fleetChanged(slug)
    return { organization: org.id, applied: true, changes }
  }

  /** An organization's current configuration as a declaration: what applying would reproduce. */
  const currentDeclaration = async (deps: Deps, row: Row<"orgs">): Promise<Declaration> => {
    const managed = managedBy(row)
    // A managed organization's file may also declare local-only services; hand back the file.
    if (managed) return managed.declaration
    const projects: Declaration["projects"] = {}
    const fleets = await deps.db.find("fleets", { org_id: row.id })
    for (const project of await deps.db.find("projects", { org_id: row.id })) {
      const declared: Declaration["projects"][string]["fleets"] = {}
      for (const fleet of fleets.filter((entry) => entry.project_id === project.id)) {
        const rate = (fleet.options as { requestsPerMinute?: number }).requestsPerMinute
        declared[fleet.slug] = {
          name: fleet.name,
          access: fleet.access as "open" | "key",
          ...(rate ? { requestsPerMinute: rate } : {}),
          services: Object.fromEntries(
            Object.entries(fleet.emulators as Emulators).map(([name, spec]) => {
              const { target, ...rest } = spec
              return [name, { ...(target === name ? {} : { target }), ...rest }]
            }),
          ),
        }
      }
      projects[project.slug] = { name: project.name, fleets: declared }
    }
    return { version: 1, organization: row.slug, name: row.name, projects }
  }

  const route = (
    method: Route["method"],
    path: string,
    operationId: string,
    summary: string,
    tag: string,
    response: string,
    handler: Route["handler"],
    extra: Partial<Pick<Route, "auth" | "body" | "status">> = {},
  ): Route => ({
    method,
    path,
    operationId,
    summary,
    tag,
    response,
    handler,
    auth: "required",
    ...extra,
  })

  return [
    route(
      "GET",
      "/config",
      "getConfig",
      "Public settings a client needs before signing in",
      "Meta",
      "Config",
      async ({ deps }) => ({
        publicUrl: deps.config.publicUrl,
        fleetUrl: deps.config.fleetUrl,
        auth: {
          oidc: deps.config.oidc !== undefined,
          devLogin: deps.config.devLogin,
          tokenLogin: true,
        },
        durability: DURABILITY,
      }),
      { auth: "public" },
    ),
    route(
      "GET",
      "/catalog",
      "listCatalog",
      "Emulators a fleet can run",
      "Meta",
      "Catalog",
      async () => ({ data: CATALOG }),
      { auth: "public" },
    ),

    // ---- identity ------------------------------------------------------------------------
    route(
      "GET",
      "/me",
      "getMe",
      "The caller and the organizations it can reach",
      "Identity",
      "Me",
      async (context) => {
        const { principal, deps } = context
        if (!principal) throw unauthorized()
        if (principal.kind === "key") {
          const row = principal.key.org_id
            ? await deps.db.get("orgs", principal.key.org_id)
            : undefined
          return {
            kind: "api_key",
            apiKey: viewKey(principal.key),
            orgs: row ? [viewOrg(row, principal.key.role ?? undefined)] : [],
          }
        }
        const orgs = []
        for (const membership of await deps.db.find("memberships", {
          user_id: principal.user.id,
        })) {
          const row = await deps.db.get("orgs", membership.org_id)
          if (row) orgs.push(viewOrg(row, membership.role))
        }
        return {
          kind: "user",
          user: { id: principal.user.id, email: principal.user.email, name: principal.user.name },
          orgs,
        }
      },
    ),
    route(
      "GET",
      "/tokens",
      "listTokens",
      "List your personal tokens",
      "Identity",
      "ApiKeyList",
      async (context) => ({
        data: (await context.deps.db.find("api_keys", { user_id: user(context).id }))
          .filter((row) => row.scope === "user")
          .map((row) => viewKey(row)),
      }),
    ),
    route(
      "POST",
      "/tokens",
      "createToken",
      "Create a personal token that acts as you",
      "Identity",
      "ApiKey",
      async (context) => {
        const me = user(context)
        const { row, secret } = await context.deps.auth.createKey({
          scope: "user",
          name: context.body.name as string,
          createdBy: me.id,
          userId: me.id,
          ...(typeof context.body.expiresInDays === "number"
            ? { expiresInDays: context.body.expiresInDays }
            : {}),
        })
        return viewKey(row, secret)
      },
      { body: "TokenCreate", status: 201 },
    ),
    route(
      "DELETE",
      "/tokens/{tokenId}",
      "deleteToken",
      "Revoke a personal token",
      "Identity",
      "Ok",
      async (context) => {
        const row = await context.deps.db.get("api_keys", context.params.tokenId ?? "")
        if (row?.scope !== "user" || row.user_id !== user(context).id) throw notFound("Token")
        await context.deps.db.remove("api_keys", { id: row.id })
        return { ok: true }
      },
    ),

    // ---- organizations -------------------------------------------------------------------
    route(
      "GET",
      "/orgs",
      "listOrgs",
      "List organizations you belong to",
      "Organizations",
      "OrgList",
      async (context) => {
        const { principal, deps } = context
        if (!principal) throw unauthorized()
        if (principal.kind === "key") {
          const row = principal.key.org_id
            ? await deps.db.get("orgs", principal.key.org_id)
            : undefined
          return { data: row ? [viewOrg(row, principal.key.role ?? undefined)] : [] }
        }
        const data = []
        for (const membership of await deps.db.find("memberships", {
          user_id: principal.user.id,
        })) {
          const row = await deps.db.get("orgs", membership.org_id)
          if (row) data.push(viewOrg(row, membership.role))
        }
        return { data }
      },
    ),
    route(
      "POST",
      "/orgs",
      "createOrg",
      "Create an organization; you become its owner",
      "Organizations",
      "Org",
      async (context) => {
        const me = user(context)
        const { deps, body } = context
        quota(
          deps.config.orgsPerUser,
          (await deps.db.find("memberships", { user_id: me.id })).length,
          "orgsPerUser",
          "You belong to the maximum number of organizations",
        )
        const row = await withSlug(body.slug, body.name as string, "Organization", async (slug) => {
          const created: Row<"orgs"> = {
            id: newId("org"),
            slug,
            name: body.name as string,
            limits: {},
            manifest: null,
            suspended: null,
            created_at: iso(deps),
          }
          await deps.db.insert("orgs", created)
          return created
        })
        await deps.db.insert("memberships", {
          id: newId("mem"),
          org_id: row.id,
          user_id: me.id,
          role: "owner",
          created_at: iso(deps),
        })
        context.orgId = row.id
        return viewOrg(row, "owner")
      },
      { body: "OrgCreate", status: 201 },
    ),
    route(
      "GET",
      "/orgs/{orgId}",
      "getOrg",
      "Get an organization",
      "Organizations",
      "Org",
      async (context) => {
        const { row, role } = await org(context, "viewer")
        return viewOrg(row, role)
      },
    ),
    route(
      "PATCH",
      "/orgs/{orgId}",
      "updateOrg",
      "Rename an organization",
      "Organizations",
      "Org",
      async (context) => {
        const { row, role } = await org(context, "admin")
        const updated = await context.deps.db.update("orgs", row.id, {
          name: context.body.name as string,
        })
        return viewOrg(updated ?? row, role)
      },
      { body: "OrgUpdate" },
    ),
    route(
      "DELETE",
      "/orgs/{orgId}",
      "deleteOrg",
      "Delete an organization and everything in it",
      "Organizations",
      "Ok",
      async (context) => {
        const { row } = await org(context, "owner")
        const { deps } = context
        for (const child of await deps.db.find("projects", { org_id: row.id }))
          await deleteProject(deps, child)
        await deps.db.remove("api_keys", { org_id: row.id })
        await deps.db.remove("invites", { org_id: row.id })
        await deps.db.remove("memberships", { org_id: row.id })
        await deps.db.remove("usage", { org_id: row.id })
        await deps.db.remove("audit", { org_id: row.id })
        await deps.db.remove("orgs", { id: row.id })
        return { ok: true }
      },
    ),

    // ---- members and invites -------------------------------------------------------------
    route(
      "GET",
      "/orgs/{orgId}/members",
      "listMembers",
      "List an organization's members",
      "Members",
      "MemberList",
      async (context) => {
        const { row } = await org(context, "viewer")
        const data = []
        for (const membership of await context.deps.db.find("memberships", { org_id: row.id })) {
          const member = await context.deps.db.get("users", membership.user_id)
          data.push({
            userId: membership.user_id,
            email: member?.email ?? null,
            name: member?.name ?? null,
            role: membership.role,
            joinedAt: membership.created_at,
          })
        }
        return { data }
      },
    ),
    route(
      "PATCH",
      "/orgs/{orgId}/members/{userId}",
      "updateMember",
      "Change a member's role",
      "Members",
      "Member",
      async (context) => {
        const { row, role } = await org(context, "admin")
        const { deps } = context
        const next = context.body.role as Role
        const [membership] = await deps.db.find("memberships", {
          org_id: row.id,
          user_id: context.params.userId ?? "",
        })
        if (!membership) throw notFound("Member")
        if ((membership.role === "owner" || next === "owner") && role !== "owner")
          throw forbidden("Only an owner can grant or change the owner role")
        if (membership.role === "owner" && next !== "owner") {
          const owners = (await deps.db.find("memberships", { org_id: row.id })).filter(
            (m) => m.role === "owner",
          )
          if (owners.length === 1) throw conflict("An organization needs at least one owner")
        }
        await deps.db.update("memberships", membership.id, { role: next })
        const member = await deps.db.get("users", membership.user_id)
        return {
          userId: membership.user_id,
          email: member?.email ?? null,
          name: member?.name ?? null,
          role: next,
          joinedAt: membership.created_at,
        }
      },
      { body: "MemberUpdate" },
    ),
    route(
      "DELETE",
      "/orgs/{orgId}/members/{userId}",
      "removeMember",
      "Remove a member, or leave the organization",
      "Members",
      "Ok",
      async (context) => {
        const { deps, principal } = context
        const target = context.params.userId ?? ""
        const leaving = principal?.kind === "user" && principal.user.id === target
        const { row, role } = await org(context, leaving ? "viewer" : "admin")
        const [membership] = await deps.db.find("memberships", { org_id: row.id, user_id: target })
        if (!membership) throw notFound("Member")
        if (membership.role === "owner") {
          if (role !== "owner") throw forbidden("Only an owner can remove an owner")
          const owners = (await deps.db.find("memberships", { org_id: row.id })).filter(
            (m) => m.role === "owner",
          )
          if (owners.length === 1) throw conflict("An organization needs at least one owner")
        }
        await deps.db.remove("memberships", { id: membership.id })
        return { ok: true }
      },
    ),
    route(
      "GET",
      "/orgs/{orgId}/invites",
      "listInvites",
      "List pending invites",
      "Members",
      "InviteList",
      async (context) => {
        const { row } = await org(context, "admin")
        return {
          data: (await context.deps.db.find("invites", { org_id: row.id })).map((i) =>
            viewInvite(i, context.deps),
          ),
        }
      },
    ),
    route(
      "POST",
      "/orgs/{orgId}/invites",
      "createInvite",
      "Invite someone to the organization; share the returned link with them",
      "Members",
      "Invite",
      async (context) => {
        const { row } = await org(context, "admin")
        const { deps, principal } = context
        quota(
          limitsOf(deps, row).membersPerOrg,
          (await deps.db.find("memberships", { org_id: row.id })).length +
            (await deps.db.find("invites", { org_id: row.id })).length,
          "membersPerOrg",
          "This organization has its maximum number of members and pending invites",
        )
        const token = newSecret()
        // One clock read, so the invite lasts exactly INVITE_DAYS from its creation.
        const now = deps.now()
        const invite: Row<"invites"> = {
          id: newId("inv"),
          org_id: row.id,
          email: context.body.email as string,
          role: (context.body.role as string | undefined) ?? "member",
          token_hash: sha256(token),
          invited_by: principal?.kind === "user" ? principal.user.id : (principal?.key.id ?? ""),
          expires_at: new Date(now + INVITE_DAYS * 86_400_000).toISOString(),
          created_at: new Date(now).toISOString(),
        }
        await deps.db.insert("invites", invite)
        return viewInvite(invite, deps, token)
      },
      { body: "InviteCreate", status: 201 },
    ),
    route(
      "DELETE",
      "/orgs/{orgId}/invites/{inviteId}",
      "deleteInvite",
      "Revoke an invite",
      "Members",
      "Ok",
      async (context) => {
        const { row } = await org(context, "admin")
        const invite = await context.deps.db.get("invites", context.params.inviteId ?? "")
        if (!invite || invite.org_id !== row.id) throw notFound("Invite")
        await context.deps.db.remove("invites", { id: invite.id })
        return { ok: true }
      },
    ),
    route(
      "POST",
      "/invites/accept",
      "acceptInvite",
      "Join an organization with an invite token",
      "Members",
      "Org",
      async (context) => {
        const me = user(context)
        const { deps } = context
        const [invite] = await deps.db.find("invites", {
          token_hash: sha256(context.body.token as string),
        })
        if (!invite || invite.expires_at < iso(deps))
          throw new HttpError(404, "not_found", "This invite is invalid, already used or expired")
        const row = await deps.db.get("orgs", invite.org_id)
        if (!row) throw notFound("Organization")
        // An invite is single use. Deleting it is the claim: of two people racing with one
        // link, exactly one delete removes a row, and only that caller joins.
        if ((await deps.db.remove("invites", { id: invite.id })) !== 1)
          throw new HttpError(404, "not_found", "This invite is invalid, already used or expired")
        // Someone joining is a change to the organization: record it in its audit log.
        context.orgId = row.id
        const [existing] = await deps.db.find("memberships", { org_id: row.id, user_id: me.id })
        if (!existing)
          await deps.db.insert("memberships", {
            id: newId("mem"),
            org_id: row.id,
            user_id: me.id,
            role: invite.role,
            created_at: iso(deps),
          })
        return viewOrg(row, existing?.role ?? invite.role)
      },
      { body: "InviteAccept" },
    ),

    // ---- API keys ------------------------------------------------------------------------
    route(
      "GET",
      "/orgs/{orgId}/api-keys",
      "listApiKeys",
      "List an organization's API keys",
      "API keys",
      "ApiKeyList",
      async (context) => {
        const { row } = await org(context, "admin")
        return {
          data: (await context.deps.db.find("api_keys", { org_id: row.id })).map((k) => viewKey(k)),
        }
      },
    ),
    route(
      "POST",
      "/orgs/{orgId}/api-keys",
      "createApiKey",
      "Create an API key for the organization, or for one of its projects",
      "API keys",
      "ApiKey",
      async (context) => {
        const { row, role } = await org(context, "admin")
        const { deps, body, principal } = context
        quota(
          limitsOf(deps, row).apiKeysPerOrg,
          (await deps.db.find("api_keys", { org_id: row.id })).length,
          "apiKeysPerOrg",
          "This organization has its maximum number of API keys",
        )
        const keyRole = (body.role as Role | undefined) ?? "member"
        // A key can never be more powerful than whoever mints it.
        if (rank(keyRole) > rank(role)) throw forbidden("A key cannot outrank its creator")
        let projectId: string | undefined
        if (typeof body.projectId === "string") {
          const owner = await deps.db.get("projects", body.projectId)
          if (!owner || owner.org_id !== row.id) throw notFound("Project")
          if (keyRole === "admin") throw badRequest("A project key is at most a member")
          projectId = owner.id
        }
        const created = await deps.auth.createKey({
          scope: projectId ? "project" : "org",
          name: body.name as string,
          createdBy: principal?.kind === "user" ? principal.user.id : (principal?.key.id ?? ""),
          orgId: row.id,
          role: keyRole,
          ...(projectId ? { projectId } : {}),
          ...(typeof body.expiresInDays === "number" ? { expiresInDays: body.expiresInDays } : {}),
        })
        return viewKey(created.row, created.secret)
      },
      { body: "ApiKeyCreate", status: 201 },
    ),
    route(
      "DELETE",
      "/orgs/{orgId}/api-keys/{keyId}",
      "deleteApiKey",
      "Revoke an API key",
      "API keys",
      "Ok",
      async (context) => {
        const { row } = await org(context, "admin")
        const key = await context.deps.db.get("api_keys", context.params.keyId ?? "")
        if (!key || key.org_id !== row.id) throw notFound("API key")
        await context.deps.db.remove("api_keys", { id: key.id })
        return { ok: true }
      },
    ),

    // ---- mockingbird.yaml ----------------------------------------------------------------
    route(
      "PUT",
      "/manifest",
      "applyDeclaration",
      "Make an organization match a mockingbird.yaml (?dryRun=true to plan, ?prune=true to delete what it no longer declares)",
      "Declarative configuration",
      "DeclarationResult",
      applyDeclaration,
      { body: "Declaration" },
    ),
    route(
      "GET",
      "/orgs/{orgId}/manifest",
      "getDeclaration",
      "An organization's configuration as a mockingbird.yaml",
      "Declarative configuration",
      "DeclarationView",
      async (context) => {
        const { row } = await org(context, "viewer")
        const declaration = await currentDeclaration(context.deps, row)
        const managed = managedBy(row)
        return {
          managed: managed ? { appliedAt: managed.appliedAt, appliedBy: managed.appliedBy } : null,
          declaration,
          yaml: `# mockingbird.yaml\n${Bun.YAML.stringify(declaration, null, 2)}\n`,
        }
      },
    ),
    route(
      "DELETE",
      "/orgs/{orgId}/manifest",
      "releaseDeclaration",
      "Stop managing an organization with mockingbird.yaml; nothing is deleted",
      "Declarative configuration",
      "Org",
      async (context) => {
        const { row, role } = await org(context, "admin")
        const updated = await context.deps.db.update("orgs", row.id, { manifest: null })
        return viewOrg(updated ?? row, role)
      },
    ),

    // ---- usage and audit -----------------------------------------------------------------
    route(
      "GET",
      "/orgs/{orgId}/usage",
      "getUsage",
      "An organization's quotas and how much of each is used",
      "Usage",
      "Usage",
      async (context) => {
        const { row } = await org(context, "viewer")
        const { deps } = context
        const count = async (table: "projects" | "fleets" | "memberships" | "api_keys") =>
          (await deps.db.find(table, { org_id: row.id })).length
        return {
          suspended: row.suspended,
          limits: limitsOf(deps, row),
          usage: {
            projects: await count("projects"),
            fleets: await count("fleets"),
            members: await count("memberships"),
            apiKeys: await count("api_keys"),
            requestsThisMonth: await deps.meter.month(row.id),
          },
          daily: await deps.meter.daily(row.id),
        }
      },
    ),
    route(
      "GET",
      "/orgs/{orgId}/audit",
      "listAudit",
      "The 200 most recent changes made in an organization, newest first",
      "Usage",
      "AuditList",
      async (context) => {
        const { row } = await org(context, "admin")
        const entries = await context.deps.db.find("audit", { org_id: row.id })
        return {
          data: entries
            .reverse()
            .slice(0, 200)
            .map((entry) => ({
              id: entry.id,
              actor: entry.actor,
              action: entry.action,
              target: entry.target,
              at: entry.created_at,
            })),
        }
      },
    ),

    // ---- operator ------------------------------------------------------------------------
    route(
      "GET",
      "/admin/orgs",
      "adminListOrgs",
      "Every organization, with its quota overrides and this month's requests",
      "Operator",
      "AdminOrgList",
      async ({ deps }) => {
        const data = []
        for (const row of await deps.db.find("orgs", {}))
          data.push({
            ...viewOrg(row),
            limitOverrides: row.limits,
            limits: limitsOf(deps, row),
            requestsThisMonth: await deps.meter.month(row.id),
          })
        return { data }
      },
      { auth: "operator" },
    ),
    route(
      "PATCH",
      "/admin/orgs/{orgId}",
      "adminUpdateOrg",
      "Override an organization's quotas, or suspend or reinstate it",
      "Operator",
      "AdminOrg",
      async (context) => {
        const { deps, body } = context
        const row = await deps.db.get("orgs", context.params.orgId ?? "")
        if (!row) throw notFound("Organization")
        context.orgId = row.id
        // `null` removes an override, returning that quota to the server default.
        const overrides = { ...(row.limits as Record<string, number>) }
        for (const [key, value] of Object.entries((body.limits ?? {}) as Record<string, unknown>)) {
          if (value === null) delete overrides[key]
          else overrides[key] = value as number
        }
        const updated =
          (await deps.db.update("orgs", row.id, {
            limits: overrides,
            ...("suspended" in body ? { suspended: body.suspended as string | null } : {}),
          })) ?? row
        // Fleets cache their organization briefly; drop them so a suspension bites at once.
        for (const child of await deps.db.find("fleets", { org_id: row.id }))
          deps.fleetChanged(child.slug)
        return {
          ...viewOrg(updated),
          limitOverrides: updated.limits,
          limits: limitsOf(deps, updated),
          requestsThisMonth: await deps.meter.month(row.id),
        }
      },
      { auth: "operator", body: "AdminOrgUpdate" },
    ),
    route(
      "POST",
      "/admin/users",
      "adminCreateUser",
      "Create a local user and a personal token for them to sign in with",
      "Operator",
      "AdminUser",
      async ({ deps, body }) => {
        const created = await deps.auth.localUser(
          body.email as string,
          body.name as string | undefined,
        )
        const { row, secret } = await deps.auth.createKey({
          scope: "user",
          name: "Issued by the operator",
          createdBy: created.id,
          userId: created.id,
        })
        return {
          user: { id: created.id, email: created.email, name: created.name },
          token: viewKey(row, secret),
          signInUrl: `${deps.config.publicUrl}/`,
        }
      },
      { auth: "operator", body: "AdminUserCreate", status: 201 },
    ),

    // ---- projects ------------------------------------------------------------------------
    route(
      "GET",
      "/orgs/{orgId}/projects",
      "listProjects",
      "List an organization's projects",
      "Projects",
      "ProjectList",
      async (context) => {
        const row = await context.deps.db.get("orgs", context.params.orgId ?? "")
        if (!context.principal) throw unauthorized()
        if (!row) throw notFound("Organization")
        const projects = await context.deps.db.find("projects", { org_id: row.id })
        // A project key sees only its own project.
        const visible = []
        for (const candidate of projects)
          if (rank(await roleIn(context, row.id, candidate.id)) >= 0) visible.push(candidate)
        if (visible.length === 0) await requireRole(context, "viewer", row.id, "Organization")
        return { data: visible.map(viewProject) }
      },
    ),
    route(
      "POST",
      "/orgs/{orgId}/projects",
      "createProject",
      "Create a project",
      "Projects",
      "Project",
      async (context) => {
        const { row } = await org(context, "member")
        const { deps, body } = context
        quota(
          limitsOf(deps, row).projectsPerOrg,
          (await deps.db.find("projects", { org_id: row.id })).length,
          "projectsPerOrg",
          "This organization has its maximum number of projects",
        )
        return viewProject(
          await withSlug(body.slug, body.name as string, "Project", async (slug) => {
            const created: Row<"projects"> = {
              id: newId("prj"),
              org_id: row.id,
              slug,
              name: body.name as string,
              created_at: iso(deps),
            }
            await deps.db.insert("projects", created)
            return created
          }),
        )
      },
      { body: "ProjectCreate", status: 201 },
    ),
    route(
      "GET",
      "/projects/{projectId}",
      "getProject",
      "Get a project",
      "Projects",
      "Project",
      async (context) => viewProject((await project(context, "viewer")).row),
    ),
    route(
      "PATCH",
      "/projects/{projectId}",
      "updateProject",
      "Rename a project",
      "Projects",
      "Project",
      async (context) => {
        const { row } = await project(context, "member")
        return viewProject(
          (await context.deps.db.update("projects", row.id, {
            name: context.body.name as string,
          })) ?? row,
        )
      },
      { body: "ProjectUpdate" },
    ),
    route(
      "DELETE",
      "/projects/{projectId}",
      "deleteProject",
      "Delete a project and its fleets",
      "Projects",
      "Ok",
      async (context) => {
        await deleteProject(context.deps, (await project(context, "admin")).row)
        return { ok: true }
      },
    ),

    // ---- fleets --------------------------------------------------------------------------
    route(
      "GET",
      "/projects/{projectId}/fleets",
      "listFleets",
      "List a project's fleets",
      "Fleets",
      "FleetList",
      async (context) => {
        const { row } = await project(context, "viewer")
        return {
          data: (await context.deps.db.find("fleets", { project_id: row.id })).map((f) =>
            viewFleet(f, context.deps),
          ),
        }
      },
    ),
    route(
      "POST",
      "/projects/{projectId}/fleets",
      "createFleet",
      "Create a fleet at a stable URL, optionally with its emulators",
      "Fleets",
      "Fleet",
      async (context) => {
        const { row: parent, org: owner } = await project(context, "member")
        const { deps, body } = context
        const limits = limitsOf(deps, owner)
        quota(
          limits.fleetsPerOrg,
          (await deps.db.find("fleets", { org_id: owner.id })).length,
          "fleetsPerOrg",
          "This organization has its maximum number of fleets",
        )
        const inputs = Object.keys((body.emulators ?? {}) as object).length
        if (limits.emulatorsPerFleet > 0 && inputs > limits.emulatorsPerFleet)
          quota(
            limits.emulatorsPerFleet,
            inputs,
            "emulatorsPerFleet",
            "Too many emulators for one fleet",
          )
        const options = fleetOptions(body, limits)
        const emulators: Emulators = {}
        for (const [name, input] of Object.entries(
          (body.emulators ?? {}) as Record<string, Record<string, unknown>>,
        )) {
          if (!SLUG.test(name))
            throw badRequest("Emulator names are lowercase letters, digits and hyphens")
          emulators[name] = await emulatorSpec(deps, input)
        }
        return viewFleet(
          await withSlug(body.slug, body.name as string, "Fleet", async (slug) => {
            const created: Row<"fleets"> = {
              id: newId("flt"),
              org_id: parent.org_id,
              project_id: parent.id,
              slug,
              name: body.name as string,
              access: (body.access as string | undefined) ?? "open",
              emulators,
              options,
              revision: newSecret(),
              created_at: iso(deps),
              updated_at: iso(deps),
            }
            await deps.db.insert("fleets", created)
            return created
          }),
          deps,
        )
      },
      { body: "FleetCreate", status: 201 },
    ),
    route(
      "GET",
      "/fleets/{fleetId}",
      "getFleet",
      "Get a fleet, its emulators and their URLs",
      "Fleets",
      "Fleet",
      async (context) => viewFleet((await fleet(context, "viewer")).row, context.deps),
    ),
    route(
      "PATCH",
      "/fleets/{fleetId}",
      "updateFleet",
      "Rename a fleet or change who can call it",
      "Fleets",
      "Fleet",
      async (context) => {
        const { row, org: owner } = await fleet(context, "member")
        const { deps, body } = context
        const updated = await deps.db.update("fleets", row.id, {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.access === "string" ? { access: body.access } : {}),
          ...("requestsPerMinute" in body
            ? { options: fleetOptions(body, limitsOf(deps, owner)) }
            : {}),
          updated_at: iso(deps),
        })
        deps.fleetChanged(row.slug)
        return viewFleet(updated ?? row, deps)
      },
      { body: "FleetUpdate" },
    ),
    route(
      "DELETE",
      "/fleets/{fleetId}",
      "deleteFleet",
      "Delete a fleet and all of its stored state",
      "Fleets",
      "Ok",
      async (context) => {
        await deleteFleet(context.deps, (await fleet(context, "member")).row)
        return { ok: true }
      },
    ),

    // ---- emulators -----------------------------------------------------------------------
    route(
      "PUT",
      "/fleets/{fleetId}/emulators/{name}",
      "putEmulator",
      "Add an emulator to a fleet, or replace its configuration",
      "Emulators",
      "Fleet",
      async (context) => {
        const name = emulatorName(context)
        const { deps } = context
        const spec = await emulatorSpec(deps, context.body)
        let replaced: Row<"fleets"> | undefined
        const updated = await editEmulators(context, (emulators, row) => {
          // A different emulator cannot read the old one's state; it starts clean.
          replaced = emulators[name] && emulators[name].target !== spec.target ? row : undefined
          return { ...emulators, [name]: spec }
        })
        if (replaced) await deps.engine.reset(updated.id, name)
        return viewFleet(updated, deps)
      },
      { body: "EmulatorPut" },
    ),
    route(
      "PATCH",
      "/fleets/{fleetId}/emulators/{name}",
      "updateEmulator",
      "Change part of an emulator's configuration, such as its durability",
      "Emulators",
      "Fleet",
      async (context) => {
        const name = emulatorName(context)
        const { deps } = context
        let retarget = false
        let next: EmulatorSpec | undefined
        const updated = await editEmulators(context, async (emulators) => {
          const current = emulators[name]
          if (!current) throw notFound("Emulator")
          next = await emulatorSpec(deps, context.body, current)
          retarget = next.target !== current.target
          return { ...emulators, [name]: next }
        })
        if (retarget) await deps.engine.reset(updated.id, name)
        // Apply a durability change now, not on the emulator's next request.
        else if (next)
          await deps.engine.flush(await emulatorRef(deps, updated, name)).catch(() => {})
        return viewFleet(updated, deps)
      },
      { body: "EmulatorPatch" },
    ),
    route(
      "DELETE",
      "/fleets/{fleetId}/emulators/{name}",
      "deleteEmulator",
      "Remove an emulator and its stored state",
      "Emulators",
      "Fleet",
      async (context) => {
        const name = emulatorName(context)
        const updated = await editEmulators(context, (emulators) => {
          if (!emulators[name]) throw notFound("Emulator")
          const { [name]: _removed, ...rest } = emulators
          return rest
        })
        await context.deps.engine.reset(updated.id, name)
        return viewFleet(updated, context.deps)
      },
    ),
    route(
      "POST",
      "/fleets/{fleetId}/emulators/{name}/reset",
      "resetEmulator",
      "Return an emulator to its boot state",
      "Emulators",
      "Ok",
      async (context) => {
        const { row } = await fleet(context, "member")
        await emulatorRef(context.deps, row, emulatorName(context))
        await context.deps.engine.reset(row.id, emulatorName(context))
        return { ok: true }
      },
    ),
    route(
      "POST",
      "/fleets/{fleetId}/emulators/{name}/flush",
      "flushEmulator",
      "Write unsaved state to object storage now",
      "Emulators",
      "Ok",
      async (context) => {
        const { row } = await fleet(context, "member")
        await context.deps.engine.flush(await emulatorRef(context.deps, row, emulatorName(context)))
        return { ok: true }
      },
    ),
    route(
      "GET",
      "/fleets/{fleetId}/emulators/{name}/state",
      "exportEmulatorState",
      "Download an emulator's current state",
      "Emulators",
      "StateDocument",
      async (context) => {
        const { row } = await fleet(context, "member")
        return context.deps.engine.exportState(
          await emulatorRef(context.deps, row, emulatorName(context)),
        )
      },
    ),
  ]
}
