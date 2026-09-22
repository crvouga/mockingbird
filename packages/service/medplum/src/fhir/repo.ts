import {
  AccessPolicyInteraction,
  accessPolicySupportsInteraction,
  allOk,
  applyPatch,
  badRequest,
  deepClone,
  deepEquals,
  evalFhirPathTyped,
  extractAccountReferences,
  fhirpathPatchTypedValue,
  forbidden,
  getStatus,
  gone,
  isGone,
  isNotFound,
  isOk,
  isUUID,
  normalizeOperationOutcome,
  notFound,
  type Operation,
  OperationOutcomeError,
  parseFhirPathPatchParameters,
  parseReference,
  preconditionFailed,
  projectAdminResourceTypes,
  protectedResourceTypes,
  resolveId,
  type SearchRequest,
  satisfiedAccessPolicy,
  stringify,
  toTypedValue,
  validateResource,
  validateResourceType,
  type WithId,
} from "@medplum/core"
import type {
  AccessPolicy,
  AccessPolicyResource,
  Binary,
  Bundle,
  BundleEntry,
  Meta,
  OperationOutcome,
  Parameters,
  Project,
  Reference,
  Resource,
  ResourceType,
} from "@medplum/fhirtypes"
import { searchByReferenceImpl, searchImpl } from "../search/search.js"
import {
  type CreateResourceOptions,
  FhirRepository,
  type ReadHistoryOptions,
  type RepositoryMode,
  type UpdateResourceOptions,
} from "../vendor/fhir-router/index.js"
import { getPatients } from "./patient.js"
import { RewriteMode, replaceConditionalReferences, rewriteAttachments } from "./rewrite.js"
import { type FhirStore, type ResourceRow, SYSTEM_PROJECT_ID } from "./store.js"

/** Resource types only a super admin may set `meta.project` on (`SuperAdminProjectIdEditableResourceTypes`). */
const SUPER_ADMIN_PROJECT_ID_EDITABLE = ["User", "Subscription"]

/** Read interactions, for the linked-project check in `canPerformInteraction`. */
const READ_INTERACTIONS: string[] = [
  AccessPolicyInteraction.READ,
  AccessPolicyInteraction.VREAD,
  AccessPolicyInteraction.HISTORY,
  AccessPolicyInteraction.SEARCH,
]

/** Everything a repository knows about who is calling, like the server's `RepositoryContext`. */
export type RepositoryContext = {
  /** The caller's project first, then linked projects. Empty for the system repository. */
  projects: WithId<Project>[]
  currentProject?: WithId<Project> | undefined
  /** `meta.author` of every write. */
  author: Reference
  superAdmin?: boolean | undefined
  projectAdmin?: boolean | undefined
  accessPolicy?: AccessPolicy | undefined
  /** `X-Medplum: extended`: keep `meta.author`, `meta.project` and `meta.compartment` on reads. */
  extendedMode?: boolean | undefined
  onBehalfOf?: Reference | undefined
}

/** The services a repository draws on that are not per-request. */
export type RepositoryServices = {
  store: FhirStore
  now: () => number
  /** The instant of the next write: the clock, but strictly after the previous write. */
  writeTime: () => number
  generateId: () => string
  /** Base URL (with trailing slash) for `fullUrl`s and search links. */
  baseUrl: string
  /** Largest `_offset` accepted; undefined for no limit (the server default). */
  maxSearchOffset?: number | undefined
  /** Sign a presigned storage URL (base64). */
  sign: (data: string) => Promise<string>
  /** Store a Binary version's content (the server's binary storage). */
  writeBinary: (binary: Binary, bytes: Uint8Array) => void
}

export class MockRepository extends FhirRepository {
  constructor(
    readonly services: RepositoryServices,
    readonly context: RepositoryContext,
  ) {
    super()
  }

  get store(): FhirStore {
    return this.services.store
  }

  /** A repository with no project restrictions and the system as author. */
  getSystemRepo(): MockRepository {
    return new MockRepository(this.services, {
      projects: [],
      author: { reference: "system" },
      superAdmin: true,
      extendedMode: true,
    })
  }

  setMode(_mode: RepositoryMode): void {
    // One store: readers and writers see the same data.
  }

  generateId(): string {
    return this.services.generateId()
  }

  fullUrl(resourceType: string, id: string): string {
    return `${this.services.baseUrl}fhir/R4/${resourceType}/${id}`
  }

  currentProject(): WithId<Project> | undefined {
    return this.context.currentProject
  }

  isSuperAdmin(): boolean {
    return Boolean(this.context.superAdmin)
  }

  isProjectAdmin(): boolean {
    return Boolean(this.context.projectAdmin)
  }

  getAuthor(): Reference {
    return this.context.author
  }

  // ---------------------------------------------------------------- create / update

  async createResource<T extends Resource>(
    resource: T,
    options?: CreateResourceOptions,
  ): Promise<WithId<T>> {
    if (options?.assignedId && resource.id && !this.isSuperAdmin()) {
      // "To be removed after proper client assigned ID support is added" — the server's check.
      const existing = this.store.get(resource.resourceType, resource.id)
      if (existing) throw new Error("Assigned ID is already in use")
    }
    const resourceWithId = {
      ...resource,
      id: options?.assignedId && resource.id ? resource.id : this.generateId(),
    }
    return this.updateResourceImpl(resourceWithId, true)
  }

  async updateResource<T extends Resource>(
    resource: T,
    options?: UpdateResourceOptions,
  ): Promise<WithId<T>> {
    if (options?.ifMatch) {
      return this.withTransaction(() => this.updateResourceImpl(resource, false, options))
    }
    return this.updateResourceImpl(resource, false, options)
  }

  private checkResourcePermissions<T extends Resource>(
    resource: T,
    interaction: AccessPolicyInteraction,
  ): WithId<T> {
    if (!resource.id) throw new OperationOutcomeError(badRequest("Missing id"))
    const { resourceType, id } = resource
    if (!isUUID(id)) throw new OperationOutcomeError(badRequest("Invalid id"))
    if (!resource.meta?.profile) {
      const defaultProfiles = this.currentProject()?.defaultProfile?.find(
        (entry) => entry.resourceType === resourceType,
      )?.profile
      if (defaultProfiles?.length) resource.meta = { ...resource.meta, profile: defaultProfiles }
    }
    if (!this.supportsInteraction(interaction, resourceType)) {
      throw new OperationOutcomeError(forbidden)
    }
    return resource as WithId<T>
  }

  async updateResourceImpl<T extends Resource>(
    resource: T,
    create: boolean,
    options?: UpdateResourceOptions,
  ): Promise<WithId<T>> {
    const interaction = create ? AccessPolicyInteraction.CREATE : AccessPolicyInteraction.UPDATE
    const validated = this.checkResourcePermissions(resource, interaction)
    if (
      validated.resourceType === "Binary" &&
      (validated as Binary).securityContext?.reference?.startsWith("Binary/")
    ) {
      throw new OperationOutcomeError(
        badRequest("Binary.securityContext cannot reference another Binary"),
      )
    }
    const { resourceType, id } = validated

    const existing = create ? undefined : this.checkExistingResource<T>(resourceType, id)
    if (existing) {
      ;(existing.meta as Meta).compartment = this.getCompartments(existing)
      if (!this.canPerformInteraction(interaction, existing)) {
        throw new OperationOutcomeError(forbidden)
      }
      if (options?.ifMatch && existing.meta?.versionId !== options.ifMatch) {
        throw new OperationOutcomeError(preconditionFailed)
      }
    }

    // `replaceConditionalReferences` rewrites nested references in place, so it gets a copy.
    let updated = await rewriteAttachments(
      RewriteMode.REFERENCE,
      this,
      deepClone(this.restoreReadonlyFields(validated, existing)),
    )
    updated = await replaceConditionalReferences(this, updated)
    const resultMeta: Meta = {
      ...updated.meta,
      versionId: this.generateId(),
      lastUpdated: this.getLastUpdated(existing, validated),
      author: this.getAuthor(),
      onBehalfOf: this.context.onBehalfOf,
      deleted: undefined,
    }
    const result = { ...updated, meta: resultMeta } as WithId<T>

    const projectId = this.getProjectId(existing, updated)
    if (projectId) resultMeta.project = projectId
    const accounts = this.getAccounts(existing, updated)
    if (accounts) {
      resultMeta.account = accounts[0]
      resultMeta.accounts = accounts
    }
    resultMeta.compartment = this.getCompartments(result)

    // Validate after every touch-up, as the server does (strict mode).
    validateResource(result)

    if (this.isNotModified(existing, result)) {
      this.removeHiddenFields(existing)
      return existing as WithId<T>
    }

    if (!this.isResourceWriteable(existing, result, interaction)) {
      throw new OperationOutcomeError(forbidden)
    }

    // `handleBinaryData`: embedded base64 content moves to binary storage, off the resource.
    let binaryBytes: Uint8Array | undefined
    if (result.resourceType === "Binary" && (result as Binary).data) {
      const decoded = atob((result as Binary).data as string)
      binaryBytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0))
      ;(result as Binary).data = undefined
    }
    const stored = JSON.parse(stringify(result)) as WithId<T>
    this.store.write(
      {
        resourceType,
        id,
        deleted: false,
        lastUpdated: resultMeta.lastUpdated as string,
        projectId: resultMeta.project ?? SYSTEM_PROJECT_ID,
        content: stored,
      },
      {
        id,
        versionId: resultMeta.versionId as string,
        lastUpdated: resultMeta.lastUpdated as string,
        content: stored,
      },
    )
    if (binaryBytes) this.services.writeBinary(stored as Binary, binaryBytes)
    return this.removeHiddenFields(deepClone(stored)) as WithId<T>
  }

  private checkExistingResource<T extends Resource>(
    resourceType: string,
    id: string,
  ): WithId<T> | undefined {
    try {
      return this.readResourceImpl<T>(resourceType, id)
    } catch (error) {
      const outcome = normalizeOperationOutcome(error)
      if (!isOk(outcome) && !isNotFound(outcome) && !isGone(outcome)) {
        throw new OperationOutcomeError(outcome, { cause: error })
      }
      if (isNotFound(outcome) && !this.canSetId()) {
        throw new OperationOutcomeError(outcome, { cause: error })
      }
      return undefined
    }
  }

  private isNotModified<T extends Resource>(existing: T | undefined, updated: T): existing is T {
    if (!existing) return false
    return deepEquals(JSON.parse(stringify(existing)), JSON.parse(stringify(updated)))
  }

  private getLastUpdated(existing: Resource | undefined, resource: Resource): string {
    if (!existing) {
      const lastUpdated = resource.meta?.lastUpdated
      if (lastUpdated && this.canWriteProtectedMeta()) return lastUpdated
    }
    return new Date(this.services.writeTime()).toISOString()
  }

  private getProjectId(existing: Resource | undefined, updated: Resource): string | undefined {
    if (updated.resourceType === "Project") return updated.id
    if (updated.resourceType === "ProjectMembership") return resolveId(updated.project)
    if (this.isSuperAdmin() && SUPER_ADMIN_PROJECT_ID_EDITABLE.includes(updated.resourceType)) {
      return updated.meta?.project
    }
    if (protectedResourceTypes.includes(updated.resourceType)) return undefined
    const submitted = updated.meta?.project
    if (submitted && this.canWriteProtectedMeta()) return submitted
    return existing?.meta?.project ?? this.context.projects[0]?.id
  }

  private getAccounts(existing: Resource | undefined, updated: Resource): Reference[] | undefined {
    if (updated.meta && this.canWriteAccount()) {
      return extractAccountReferences(updated.meta)
    }
    const accounts = new Set<string>()
    const compartment = this.context.accessPolicy?.compartment?.reference
    if (!existing && compartment) accounts.add(compartment)
    if (updated.resourceType === "Patient") {
      for (const account of extractAccountReferences(existing?.meta) ?? []) {
        accounts.add(account.reference as string)
      }
    } else {
      const system = this.getSystemRepo()
      for (const patient of getPatients(updated)) {
        try {
          const [type, id] = parseReference(patient)
          const read = system.readResourceImpl(type, id)
          for (const account of extractAccountReferences(read.meta) ?? []) {
            if (account.reference) accounts.add(account.reference)
          }
        } catch {
          // An unresolvable patient contributes no account, as on the server.
        }
      }
    }
    return accounts.size > 0 ? [...accounts].map((reference) => ({ reference })) : undefined
  }

  private getCompartments(resource: WithId<Resource>): Reference[] {
    const compartments = new Set<string>()
    if (resource.meta?.project && isUUID(resource.meta.project)) {
      compartments.add(`Project/${resource.meta.project}`)
    }
    if (
      resource.resourceType === "User" &&
      resource.project?.reference &&
      isUUID(resolveId(resource.project) ?? "")
    ) {
      compartments.add(resource.project.reference)
    }
    if (resource.meta?.accounts) {
      for (const account of resource.meta.accounts) {
        const id = resolveId(account)
        if (!account.reference?.startsWith("Project/") && id && isUUID(id)) {
          compartments.add(account.reference as string)
        }
      }
    } else if (resource.meta?.account && !resource.meta.account.reference?.startsWith("Project/")) {
      const id = resolveId(resource.meta.account)
      if (id && isUUID(id)) compartments.add(resource.meta.account.reference as string)
    }
    for (const patient of getPatients(resource)) {
      const patientId = resolveId(patient)
      if (patientId && isUUID(patientId)) compartments.add(patient.reference)
    }
    return [...compartments].map((reference) => ({ reference }))
  }

  private canSetId(): boolean {
    return this.isSuperAdmin()
  }

  private canWriteProtectedMeta(): boolean {
    return this.isSuperAdmin()
  }

  private canWriteAccount(): boolean {
    return Boolean(this.context.extendedMode && (this.isSuperAdmin() || this.isProjectAdmin()))
  }

  // ---------------------------------------------------------------- access control

  supportsInteraction(interaction: AccessPolicyInteraction, resourceType: string): boolean {
    if (!this.isSuperAdmin() && protectedResourceTypes.includes(resourceType)) return false
    if (!this.context.accessPolicy) return true
    return accessPolicySupportsInteraction(
      this.context.accessPolicy,
      interaction,
      resourceType as ResourceType,
    )
  }

  canPerformInteraction(
    interaction: AccessPolicyInteraction,
    resource: Resource,
  ): AccessPolicyResource | undefined {
    if (!this.isSuperAdmin()) {
      if (protectedResourceTypes.includes(resource.resourceType)) return undefined
      if (READ_INTERACTIONS.includes(interaction)) {
        const resourceProjectId = resource.meta?.project
        if (!resourceProjectId) return undefined
        const permitted = this.getPermittedProjectIds(resource.resourceType)
        if (permitted && !permitted.includes(resourceProjectId)) return undefined
      } else if (resource.meta?.project !== this.context.projects[0]?.id) {
        return undefined
      }
    }
    return satisfiedAccessPolicy(resource, interaction, this.context.accessPolicy)
  }

  private isResourceWriteable(
    previous: Resource | undefined,
    current: Resource,
    interaction: AccessPolicyInteraction,
  ): boolean {
    const policy = this.canPerformInteraction(interaction, current)
    if (!policy) return false
    if (!policy.writeConstraint) return true
    return policy.writeConstraint.every((constraint) => {
      const invariant = evalFhirPathTyped(
        constraint.expression as string,
        [{ type: current.resourceType, value: current }],
        {
          "%before": { type: previous?.resourceType ?? "undefined", value: previous },
          "%after": { type: current.resourceType, value: current },
        },
      )
      return invariant.length === 1 && invariant[0]?.value === true
    })
  }

  /** The project ids this caller may read `resourceType` from; undefined for "all". */
  getPermittedProjectIds(resourceType: string): string[] | undefined {
    const [first, ...rest] = this.context.projects
    if (!first) return undefined
    const ids = [first.id]
    if (resourceType !== "Project" && projectAdminResourceTypes.includes(resourceType)) return ids
    for (const project of rest) {
      if (
        resourceType === "Project" ||
        project.id === this.context.currentProject?.id ||
        !project.exportedResourceType?.length ||
        project.exportedResourceType.includes(resourceType as ResourceType)
      ) {
        ids.push(project.id)
      }
    }
    return ids
  }

  /** Whether a stored row passes the server's project and access-policy read filters. */
  rowReadable(row: ResourceRow, _interaction: AccessPolicyInteraction): boolean {
    if (!this.isSuperAdmin()) {
      const permitted = this.getPermittedProjectIds(row.resourceType)
      if (permitted && !permitted.includes(row.projectId)) return false
    }
    return true
  }

  removeHiddenFields<T extends Resource>(input: T): T {
    const policy = satisfiedAccessPolicy(
      input,
      AccessPolicyInteraction.READ,
      this.context.accessPolicy,
    )
    for (const field of policy?.hiddenFields ?? []) removeField(input, field)
    if (!this.context.extendedMode && input.meta) {
      const meta = input.meta
      meta.author = undefined
      meta.project = undefined
      meta.account = undefined
      meta.accounts = undefined
      meta.compartment = undefined
      meta.deleted = undefined
    }
    return input
  }

  private restoreReadonlyFields<T extends Resource>(input: T, original: T | undefined): T {
    const policy = satisfiedAccessPolicy(
      original ?? input,
      original ? AccessPolicyInteraction.UPDATE : AccessPolicyInteraction.CREATE,
      this.context.accessPolicy,
    )
    if (!policy?.readonlyFields && !policy?.hiddenFields) return input
    const fields = [...(policy.readonlyFields ?? []), ...(policy.hiddenFields ?? [])]
    for (const field of fields) {
      removeField(input, field)
      if (original && !field.includes(".") && !field.endsWith("[x]")) {
        const value = original[field as keyof T]
        if (value) input[field as keyof T] = value
      }
    }
    return input
  }

  // ---------------------------------------------------------------- read

  async readResource<T extends Resource>(resourceType: string, id: string): Promise<WithId<T>> {
    return this.removeHiddenFields(this.readResourceImpl<T>(resourceType, id))
  }

  readResourceImpl<T extends Resource>(resourceType: string, id: string): WithId<T> {
    if (!id || !isUUID(id)) throw new OperationOutcomeError(notFound)
    validateResourceType(resourceType)
    if (!this.supportsInteraction(AccessPolicyInteraction.READ, resourceType)) {
      throw new OperationOutcomeError(forbidden)
    }
    const row = this.store.get(resourceType, id)
    if (!row || !this.rowReadable(row, AccessPolicyInteraction.READ)) {
      throw new OperationOutcomeError(notFound)
    }
    if (row.deleted || !row.content) throw new OperationOutcomeError(gone)
    const resource = deepClone(row.content) as WithId<T>
    if (!this.canPerformInteraction(AccessPolicyInteraction.READ, resource)) {
      throw new OperationOutcomeError(notFound)
    }
    this.authorizeBinarySecurityContext(resource)
    return resource
  }

  private authorizeBinarySecurityContext(resource: Resource): void {
    if (resource.resourceType === "Binary" && resource.securityContext && !this.isSuperAdmin()) {
      if (resource.securityContext.reference?.startsWith("Binary/")) {
        throw new OperationOutcomeError(notFound)
      }
      const [type, id] = parseReference(resource.securityContext)
      this.readResourceImpl(type, id)
    }
  }

  async readReference<T extends Resource>(reference: Reference<T>): Promise<WithId<T>> {
    let parts: [T["resourceType"], string]
    try {
      parts = parseReference(reference)
    } catch {
      throw new OperationOutcomeError(badRequest("Invalid reference"))
    }
    return this.readResource<T>(parts[0], parts[1])
  }

  async readReferences<T extends Resource>(
    references: readonly Reference<T>[],
  ): Promise<(WithId<T> | Error)[]> {
    return references.map((reference) => {
      if (!reference.reference?.match(/^[A-Z][a-zA-Z]+\//)) {
        return new OperationOutcomeError(notFound)
      }
      try {
        const [resourceType, id] = parseReference(reference)
        validateResourceType(resourceType)
        if (!this.supportsInteraction(AccessPolicyInteraction.READ, resourceType)) {
          return new OperationOutcomeError(forbidden)
        }
        return this.removeHiddenFields(this.readResourceImpl<T>(resourceType, id))
      } catch (error) {
        if (error instanceof OperationOutcomeError) {
          if (isNotFound(error.outcome) || isGone(error.outcome)) return error
          throw error
        }
        throw new OperationOutcomeError(normalizeOperationOutcome(error), { cause: error })
      }
    })
  }

  async readHistory<T extends Resource>(
    resourceType: string,
    id: string,
    options?: ReadHistoryOptions,
  ): Promise<Bundle<WithId<T>>> {
    let resource: T | undefined
    try {
      resource = this.readResourceImpl<T>(resourceType, id)
      if (!this.canPerformInteraction(AccessPolicyInteraction.HISTORY, resource)) {
        throw new OperationOutcomeError(forbidden)
      }
    } catch (error) {
      if (!(error instanceof OperationOutcomeError) || !isGone(error.outcome)) throw error
    }
    const maxOffset = this.services.maxSearchOffset
    if (options?.offset !== undefined && maxOffset !== undefined && options.offset > maxOffset) {
      throw new OperationOutcomeError(
        badRequest(`Search offset exceeds maximum (got ${options.offset}, max ${maxOffset})`),
      )
    }
    const all = this.store.history(resourceType, id)
    const limit = Math.min(Math.max(0, options?.limit ?? 100), 1000)
    const offset = Math.max(0, options?.offset ?? 0)
    const entry: BundleEntry<WithId<T>>[] = []
    for (const row of all.slice(offset, offset + limit)) {
      const content = deepClone(row.content) as WithId<T>
      const deleted = Boolean(content.meta?.deleted)
      const outcome: OperationOutcome = deleted
        ? {
            resourceType: "OperationOutcome",
            id: "gone",
            issue: [
              {
                severity: "error",
                code: "deleted",
                details: { text: `Deleted on ${new Date(row.lastUpdated).toString()}` },
              },
            ],
          }
        : allOk
      entry.push({
        fullUrl: this.fullUrl(resourceType, row.id),
        request: {
          method: deleted ? "DELETE" : "GET",
          url: deleted
            ? `${resourceType}/${row.id}`
            : `${resourceType}/${row.id}/_history/${row.versionId}`,
        },
        response: { status: getStatus(outcome).toString(), outcome },
        ...(deleted ? {} : { resource: this.removeHiddenFields(content) }),
      })
    }
    return { resourceType: "Bundle", type: "history", entry, total: all.length }
  }

  async readVersion<T extends Resource>(
    resourceType: string,
    id: string,
    vid: string,
  ): Promise<WithId<T>> {
    if (!isUUID(id) || !isUUID(vid)) throw new OperationOutcomeError(notFound)
    try {
      const resource = this.readResourceImpl<T>(resourceType, id)
      if (!this.canPerformInteraction(AccessPolicyInteraction.VREAD, resource)) {
        throw new OperationOutcomeError(forbidden)
      }
    } catch (error) {
      if (!isGone(normalizeOperationOutcome(error))) throw error
    }
    const row = this.store.version(resourceType, id, vid)
    if (!row) throw new OperationOutcomeError(notFound)
    if (row.content.meta?.deleted) throw new OperationOutcomeError(gone)
    const resource = this.removeHiddenFields(deepClone(row.content)) as WithId<T>
    this.authorizeBinarySecurityContext(resource)
    return resource
  }

  // ---------------------------------------------------------------- delete / patch

  async deleteResource(resourceType: string, id: string): Promise<void> {
    let resource: WithId<Resource>
    try {
      resource = this.readResourceImpl(resourceType, id)
    } catch (error) {
      if (error instanceof OperationOutcomeError && isGone(error.outcome)) return
      throw error
    }
    if (!this.canPerformInteraction(AccessPolicyInteraction.DELETE, resource)) {
      throw new OperationOutcomeError(forbidden)
    }
    const lastUpdated = new Date(this.services.writeTime()).toISOString()
    const meta: Meta = {
      versionId: this.generateId(),
      lastUpdated,
      author: this.getAuthor(),
      deleted: true,
    }
    if (resource.meta?.project) meta.project = resource.meta.project
    this.store.write(
      {
        resourceType,
        id,
        deleted: true,
        lastUpdated,
        projectId: resource.meta?.project ?? SYSTEM_PROJECT_ID,
      },
      {
        id,
        versionId: meta.versionId as string,
        lastUpdated,
        content: { resourceType, id, meta } as Resource,
      },
    )
  }

  async patchResource<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    patch: Operation[] | Parameters,
    options?: UpdateResourceOptions,
  ): Promise<WithId<T>> {
    return this.withTransaction(async () => {
      const resource = this.readResourceImpl<T>(resourceType, id)
      if (resource.resourceType !== resourceType) {
        throw new OperationOutcomeError(badRequest("Incorrect resource type"))
      }
      if (resource.id !== id) throw new OperationOutcomeError(badRequest("Incorrect ID"))
      if (Array.isArray(patch)) {
        patchObject(resource, patch)
      } else if (patch.parameter) {
        fhirpathPatchTypedValue(toTypedValue(resource), parseFhirPathPatchParameters(patch))
      } else {
        return resource
      }
      return this.updateResourceImpl(resource, false, options)
    })
  }

  /** Permanently remove a resource and its history (`$expunge`, super admin only). */
  async expungeResource(resourceType: string, id: string): Promise<void> {
    if (!this.isSuperAdmin()) throw new OperationOutcomeError(forbidden)
    this.store.expunge(resourceType, id)
  }

  // ---------------------------------------------------------------- search

  async search<T extends Resource>(searchRequest: SearchRequest<T>): Promise<Bundle<WithId<T>>> {
    return searchImpl(this, searchRequest) as Promise<Bundle<WithId<T>>>
  }

  async searchByReference<T extends Resource>(
    searchRequest: SearchRequest<T>,
    referenceField: string,
    references: string[],
  ): Promise<Record<string, WithId<T>[]>> {
    return searchByReferenceImpl(this, searchRequest, referenceField, references) as Promise<
      Record<string, WithId<T>[]>
    >
  }

  private transactionDepth = 0

  async withTransaction<TResult>(callback: (txRepo: this) => Promise<TResult>): Promise<TResult> {
    if (this.transactionDepth > 0) return callback(this)
    this.transactionDepth++
    try {
      return await this.store.atomically(() => callback(this))
    } finally {
      this.transactionDepth--
    }
  }
}

/** `removeField` from the server's repo helpers: drop a (possibly dotted) path. */
const removeField = (target: object, path: string): void => {
  const input = target as Record<string, unknown>
  const [head, ...rest] = path.split(".")
  if (head === undefined) return
  if (rest.length === 0) {
    delete input[head]
    return
  }
  const next = input[head]
  if (Array.isArray(next)) {
    for (const item of next) if (item && typeof item === "object") removeField(item, rest.join("."))
  } else if (next && typeof next === "object") {
    removeField(next, rest.join("."))
  }
}

/** The server's `patchObject` (util/patch.ts): JSON Patch in place, with implicit array creation. */
const patchObject = (target: unknown, patch: Operation[]): void => {
  try {
    const errors = applyPatch(target, patch, { implicitArrayCreation: true }).filter(Boolean)
    if (errors.length) {
      throw new OperationOutcomeError(
        badRequest(errors.map((e) => (e as Error).message).join("\n")),
      )
    }
  } catch (error) {
    throw new OperationOutcomeError(normalizeOperationOutcome(error), { cause: error })
  }
}
