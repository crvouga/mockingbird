/**
 * `searchImpl` from packages/server/src/fhir/search.ts: count/offset limits, security filters,
 * sort order, paging links (offset or cursor), `_include`/`_revinclude`, `_total`, `_summary`
 * and `_elements`, over the mock's rows instead of SQL.
 */
import {
  AccessPolicyInteraction,
  badRequest,
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_SEARCH_COUNT,
  forbidden,
  formatSearchQuery,
  getDataType,
  getSearchParameter,
  OperationOutcomeError,
  parseSearchRequest,
  resolveId,
  type SearchRequest,
  type SortRule,
  serverError,
  splitN,
  subsetResource,
  validateResourceType,
  type WithId,
} from "@medplum/core"
import type { AccessPolicy, Bundle, BundleEntry, BundleLink, Resource } from "@medplum/fhirtypes"
import type { MockRepository } from "../fhir/repo.js"
import type { ResourceRow } from "../fhir/store.js"
import { getExtraEntries } from "../vendor/fhir-router/index.js"
import {
  addressRows,
  type ColumnValue,
  columnValue,
  getSearchImpl,
  humanNameSortValue,
  tokenColumns,
} from "./columns.js"
import {
  and,
  type CompileContext,
  compileFilter,
  type IndexedRow,
  or,
  type Predicate,
  type RowSource,
} from "./filters.js"

const MIN_CURSOR_PAGE_SIZE = 20

type CountedRequest = SearchRequest & { count: number; offset: number }

const PROJECT_ADMIN_TYPES = [
  "Package",
  "PackageRelease",
  "PackageInstallation",
  "Project",
  "ProjectMembership",
  "User",
  "UserSecurityRequest",
]

const toIndexed = (row: ResourceRow): IndexedRow => ({
  resourceType: row.resourceType,
  id: row.id,
  deleted: row.deleted,
  lastUpdated: row.lastUpdated,
  projectId: row.projectId,
  resource: row.content ?? ({ resourceType: row.resourceType } as Resource),
  compartments: (row.content?.meta?.compartment ?? [])
    .map((ref) => resolveId(ref))
    .filter((id): id is string => typeof id === "string"),
  cache: new Map(),
})

/** Row access for one search: every row of a type, read once and indexed lazily. */
class Rows implements RowSource {
  private readonly byType = new Map<string, IndexedRow[]>()
  private readonly byId = new Map<string, IndexedRow>()
  constructor(private readonly repo: MockRepository) {}
  all(resourceType: string): IndexedRow[] {
    let rows = this.byType.get(resourceType)
    if (!rows) {
      rows = this.repo.store.rows(resourceType).map(toIndexed)
      this.byType.set(resourceType, rows)
      for (const row of rows) this.byId.set(`${resourceType}/${row.id}`, row)
    }
    return rows
  }
  get(resourceType: string, id: string): IndexedRow | undefined {
    this.all(resourceType)
    return this.byId.get(`${resourceType}/${id}`)
  }
}

const validateSearchResourceType = (repo: MockRepository, resourceType: string): void => {
  validateResourceType(resourceType)
  if (resourceType === "Binary") {
    throw new OperationOutcomeError(badRequest("Cannot search on Binary resource type"))
  }
  if (!repo.supportsInteraction(AccessPolicyInteraction.SEARCH, resourceType)) {
    throw new OperationOutcomeError(forbidden)
  }
}

const validateSearchResourceTypes = (repo: MockRepository, request: SearchRequest): void => {
  if (request.types) for (const type of request.types) validateSearchResourceType(repo, type)
  else validateSearchResourceType(repo, request.resourceType)
  for (const include of request.include ?? [])
    validateSearchResourceType(repo, include.resourceType)
  for (const include of request.revInclude ?? [])
    validateSearchResourceType(repo, include.resourceType)
}

const applyCountAndOffsetLimits: (
  request: SearchRequest,
  maxOffset: number | undefined,
) => asserts request is CountedRequest = (request, maxOffset) => {
  if (request.count === undefined) request.count = DEFAULT_SEARCH_COUNT
  else if (request.count > DEFAULT_MAX_SEARCH_COUNT) request.count = DEFAULT_MAX_SEARCH_COUNT
  if (request.offset === undefined) request.offset = 0
  else if (maxOffset !== undefined && request.offset > maxOffset) {
    throw new OperationOutcomeError(
      badRequest(`Search offset exceeds maximum (got ${request.offset}, max ${maxOffset})`),
    )
  }
}

// ------------------------------------------------------------------ predicates

const compileContext = (repo: MockRepository, rows: Rows): CompileContext => ({
  source: rows,
  validateType: (type) => validateSearchResourceType(repo, type),
})

/** `addSearchFilters` + `addDeletedFilter` + `addSecurityFilters`, for one resource type. */
const buildPredicate = (
  repo: MockRepository,
  rows: Rows,
  resourceType: string,
  request: SearchRequest,
): Predicate => {
  const context = compileContext(repo, rows)
  const parts: Predicate[] = []
  if (!request.filters?.some((f) => f.code === "_deleted"))
    parts.push((row) => row.deleted === false)
  if (!repo.isSuperAdmin()) {
    const permitted = repo.getPermittedProjectIds(resourceType)
    if (permitted) parts.push((row) => permitted.includes(row.projectId))
  }
  const policy = accessPolicyPredicate(repo, context, resourceType)
  if (policy) parts.push(policy)
  for (const filter of request.filters ?? [])
    parts.push(compileFilter(context, resourceType, filter))
  return (row) => and(parts.map((p) => p(row)))
}

/** `addAccessPolicyFilters`: criteria and compartment restrictions from the caller's policy. */
const accessPolicyPredicate = (
  repo: MockRepository,
  context: CompileContext,
  resourceType: string,
): Predicate | undefined => {
  const accessPolicy: AccessPolicy | undefined = repo.context.accessPolicy
  if (!accessPolicy?.resource || resourceType === "Binary") return undefined
  const isAdminType = PROJECT_ADMIN_TYPES.includes(resourceType)
  const expressions: Predicate[] = []
  for (const policy of accessPolicy.resource) {
    if (
      (policy.resourceType === resourceType || (policy.resourceType === "*" && !isAdminType)) &&
      (!policy.interaction || policy.interaction.includes(AccessPolicyInteraction.SEARCH))
    ) {
      const compartmentId = resolveId(policy.compartment)
      if (compartmentId) {
        expressions.push((row) => row.compartments.includes(compartmentId))
      } else if (policy.criteria) {
        if (!policy.criteria.startsWith(`${policy.resourceType}?`)) return undefined
        let criteria = policy.criteria
        if (policy.resourceType === "*")
          criteria = `${resourceType}?${criteria.slice(criteria.indexOf("?") + 1)}`
        const criteriaRequest = parseSearchRequest(criteria)
        const filters = (criteriaRequest.filters ?? []).map((f) =>
          compileFilter(context, criteriaRequest.resourceType, f),
        )
        if (filters.length > 0) expressions.push((row) => and(filters.map((f) => f(row))))
      } else {
        return undefined
      }
    }
  }
  if (expressions.length === 0) return undefined
  return (row) => or(expressions.map((e) => e(row)))
}

// ------------------------------------------------------------------ sorting

type SortKey = (row: IndexedRow) => ColumnValue | ColumnValue[]

const sortKeyFor = (resourceType: string, rule: SortRule): SortKey => {
  if (rule.code === "_id") return (row) => row.id
  if (rule.code === "_lastUpdated") return (row) => Date.parse(row.lastUpdated)
  const param = getSearchParameter(resourceType, rule.code)
  if (!param?.code)
    throw new OperationOutcomeError(badRequest(`Unknown search parameter: ${rule.code}`))
  const impl = getSearchImpl(resourceType, param)
  if (impl.strategy === "token-column")
    return (row) => tokenColumns(row.resource, impl).sort ?? null
  if (impl.strategy === "lookup-table") {
    if (impl.sortColumn) return (row) => humanNameSortValue(row.resource, impl.code) ?? null
    return (row) => {
      const values = addressRows(row.resource)
        .map((entry) => (entry as Record<string, string | undefined>)[impl.column])
        .filter((v): v is string => v !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return values[0] ?? null
    }
  }
  return (row) => {
    const value = columnValue(row.resource, impl, param)
    if (typeof value === "string" && impl.type === "DATETIME") return Date.parse(value)
    return value
  }
}

const compareScalar = (a: ColumnValue, b: ColumnValue): number => {
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Postgres ORDER BY: NULLS LAST ascending, NULLS FIRST descending; arrays compare elementwise. */
const compareSortValues = (
  a: ColumnValue | ColumnValue[],
  b: ColumnValue | ColumnValue[],
  descending: boolean,
) => {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull && bNull) return 0
  if (aNull) return descending ? -1 : 1
  if (bNull) return descending ? 1 : -1
  let c: number
  if (Array.isArray(a) && Array.isArray(b)) {
    c = 0
    for (let i = 0; i < Math.min(a.length, b.length) && c === 0; i++) c = compareScalar(a[i], b[i])
    if (c === 0) c = a.length - b.length
  } else {
    c = compareScalar(a as ColumnValue, b as ColumnValue)
  }
  return descending ? -c : c
}

const sortRows = (rows: IndexedRow[], resourceType: string, rules: SortRule[]): IndexedRow[] => {
  if (rules.length === 0) return rows
  const keys = rules.map((rule) => ({
    key: sortKeyFor(resourceType, rule),
    descending: Boolean(rule.descending),
  }))
  const decorated = rows.map((row, index) => ({ row, index, values: keys.map((k) => k.key(row)) }))
  decorated.sort((x, y) => {
    for (let i = 0; i < keys.length; i++) {
      const c = compareSortValues(
        x.values[i] as ColumnValue,
        y.values[i] as ColumnValue,
        (keys[i] as { descending: boolean }).descending,
      )
      if (c !== 0) return c
    }
    return x.index - y.index
  })
  return decorated.map((d) => d.row)
}

/**
 * The values a resource sorts by under `rules` (one per rule, as the server's ORDER BY sees
 * them). Exposed for the parity harness, which treats equal keys as ties the server may return
 * in any order.
 */
export const sortValues = (resource: Resource, rules: SortRule[]): unknown[] => {
  const row = toIndexed({
    resourceType: resource.resourceType,
    id: resource.id ?? "",
    deleted: false,
    lastUpdated: resource.meta?.lastUpdated ?? "",
    projectId: "",
    content: resource,
  })
  return rules.map((rule) => sortKeyFor(resource.resourceType, rule)(row))
}

// ------------------------------------------------------------------ query execution

type Cursor = { version: string; nextInstant: string; excludedIds?: string[] | undefined }

const parseCursor = (cursor: string): Cursor | undefined => {
  const version = cursor.slice(0, cursor.indexOf("-"))
  if (version === "1") {
    const [v, nextInstant, nextId] = splitN(cursor, "-", 3)
    if (!nextId) return undefined
    return {
      version: v as string,
      nextInstant: new Date(Number.parseInt(nextInstant as string, 10)).toISOString(),
    }
  }
  if (version === "2") {
    const [v, nextInstant, excluded] = splitN(cursor, "-", 3)
    if (!nextInstant) return undefined
    return {
      version: v as string,
      nextInstant: new Date(Number.parseInt(nextInstant, 10)).toISOString(),
      excludedIds: excluded?.split(","),
    }
  }
  return undefined
}

const formatCursor = (cursor: Cursor): string => {
  let text = `${cursor.version}-${new Date(cursor.nextInstant).getTime()}`
  if (cursor.excludedIds?.length) text += `-${cursor.excludedIds.join(",")}`
  return text
}

/** Matching rows in result order, before paging. */
const matchingRows = (repo: MockRepository, rows: Rows, request: CountedRequest): IndexedRow[] => {
  const types = request.types ?? [request.resourceType]
  let result: IndexedRow[] = []
  for (const type of types) {
    const predicate = buildPredicate(repo, rows, type, request)
    result.push(...rows.all(type).filter((row) => predicate(row) === true))
  }
  result = sortRows(result, request.resourceType, request.sortRules ?? [])
  if (request.offset > 0) {
    if (request.cursor)
      throw new OperationOutcomeError(badRequest("Cannot use both offset and cursor"))
  } else if (request.cursor) {
    const cursor = parseCursor(request.cursor)
    if (cursor) {
      const instant = Date.parse(cursor.nextInstant)
      result = sortRows(
        result.filter(
          (row) =>
            Date.parse(row.lastUpdated) >= instant && !(cursor.excludedIds ?? []).includes(row.id),
        ),
        request.resourceType,
        [...(request.sortRules ?? []), { code: "_lastUpdated" }],
      )
    }
  }
  return result
}

const removeResourceFields = (
  resource: Resource,
  repo: MockRepository,
  request: SearchRequest,
): void => {
  repo.removeHiddenFields(resource)
  if (request.fields) {
    const schema = getDataType(resource.resourceType)
    subsetResource(
      resource,
      schema.mandatoryProperties
        ? [...schema.mandatoryProperties, ...request.fields]
        : request.fields,
    )
  } else if (request.summary) {
    const schema = getDataType(resource.resourceType)
    if (request.summary === "data") {
      subsetResource(
        resource,
        Object.keys(resource).filter((k) => k !== "text"),
      )
    } else if (request.summary === "text") {
      subsetResource(
        resource,
        schema.mandatoryProperties ? ["text", ...schema.mandatoryProperties] : ["text"],
      )
    } else if (request.summary === "true") {
      subsetResource(resource, schema.summaryProperties ? [...schema.summaryProperties] : [])
    }
  }
}

const resourceOfRow = (row: IndexedRow, fallbackType: string): WithId<Resource> =>
  row.deleted
    ? ({
        resourceType: fallbackType,
        id: row.id,
        meta: { lastUpdated: row.lastUpdated },
      } as WithId<Resource>)
    : (structuredClone(row.resource) as WithId<Resource>)

const getSearchEntries = async (
  repo: MockRepository,
  rows: Rows,
  request: CountedRequest,
): Promise<{ entry: BundleEntry[]; rowCount: number; nextResource: Resource | undefined }> => {
  const all = matchingRows(repo, rows, request)
  // SQL `OFFSET` is only emitted for a positive offset; links keep the raw value.
  const start = request.offset > 0 ? request.offset : 0
  const page = all.slice(start, start + request.count + 1)
  const rowCount = Math.min(page.length, request.count + 1)
  const resources = page.map((row) => resourceOfRow(row, row.resourceType))
  let nextResource: Resource | undefined
  if (resources.length > request.count) nextResource = resources.pop()
  const entries: BundleEntry[] = resources.map((resource) => ({
    fullUrl: repo.fullUrl(resource.resourceType, resource.id),
    search: { mode: "match" },
    resource,
  }))
  if (request.include || request.revInclude) {
    await getExtraEntries(repo, request, resources, entries, {
      fullUrl: (type, id) => repo.fullUrl(type, id),
      executeSearch: async (sub) => {
        const subRows = new Rows(repo)
        applyCountAndOffsetLimits(sub, repo.services.maxSearchOffset)
        const found = await getSearchEntries(repo, subRows, sub as CountedRequest)
        return found.entry.map((e) => e.resource as WithId<Resource>)
      },
    })
  }
  for (const entry of entries)
    if (entry.resource) removeResourceFields(entry.resource, repo, request)
  return { entry: entries, rowCount: Math.min(rowCount, request.count), nextResource }
}

// ------------------------------------------------------------------ links

const searchUrl = (repo: MockRepository, request: SearchRequest): string =>
  `${repo.services.baseUrl}fhir/R4/${request.resourceType}${formatSearchQuery(request)}`

const canUseCursorLinks = (request: CountedRequest): boolean =>
  request.offset === 0 &&
  request.count >= MIN_CURSOR_PAGE_SIZE &&
  request.sortRules?.length === 1 &&
  request.sortRules[0]?.code === "_lastUpdated" &&
  !request.sortRules[0]?.descending

const getSearchLinks = (
  repo: MockRepository,
  request: CountedRequest,
  entries: BundleEntry[] | undefined,
  nextResource: Resource | undefined,
): BundleLink[] => {
  const result: BundleLink[] = [{ relation: "self", url: searchUrl(repo, request) }]
  if (request.count > 0 && entries?.length) {
    if (canUseCursorLinks(request)) {
      if (entries[0]?.resource?.meta?.lastUpdated === nextResource?.meta?.lastUpdated) {
        throw new OperationOutcomeError(serverError(new Error("Cursor fails to make progress")))
      }
      const excludedIds = entries
        .filter((e) => e.resource?.meta?.lastUpdated === nextResource?.meta?.lastUpdated)
        .map((e) => e.resource?.id)
        .filter((id): id is string => id !== undefined)
      result.push({
        relation: "first",
        url: searchUrl(repo, { ...request, cursor: undefined, offset: undefined } as SearchRequest),
      })
      if (nextResource) {
        result.push({
          relation: "next",
          url: searchUrl(repo, {
            ...request,
            cursor: formatCursor({
              version: "2",
              nextInstant: nextResource.meta?.lastUpdated as string,
              excludedIds,
            }),
            offset: undefined,
          } as SearchRequest),
        })
      }
    } else {
      result.push({ relation: "first", url: searchUrl(repo, { ...request, offset: 0 }) })
      if (nextResource) {
        result.push({
          relation: "next",
          url: searchUrl(repo, { ...request, offset: request.offset + request.count }),
        })
      }
      if (request.offset > 0) {
        result.push({
          relation: "previous",
          url: searchUrl(repo, { ...request, offset: request.offset - request.count }),
        })
      }
    }
  }
  return result
}

// ------------------------------------------------------------------ entry points

export const searchImpl = async (
  repo: MockRepository,
  searchRequest: SearchRequest,
): Promise<Bundle> => {
  validateSearchResourceTypes(repo, searchRequest)
  applyCountAndOffsetLimits(searchRequest, repo.services.maxSearchOffset)
  const rows = new Rows(repo)
  let entry: BundleEntry[] | undefined
  let rowCount: number | undefined
  let nextResource: Resource | undefined
  if (searchRequest.count > 0) {
    ;({ entry, rowCount, nextResource } = await getSearchEntries(repo, rows, searchRequest))
  }
  let total: number | undefined
  if (searchRequest.total === "accurate" || searchRequest.total === "estimate") {
    total = matchingRows(repo, new Rows(repo), {
      ...searchRequest,
      offset: 0,
      cursor: undefined,
    } as CountedRequest).length
    void rowCount
  }
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry,
    total,
    link: getSearchLinks(repo, searchRequest, entry, nextResource),
  } as Bundle
}

export const searchByReferenceImpl = async (
  repo: MockRepository,
  searchRequest: SearchRequest,
  referenceField: string,
  referenceValues: string[],
): Promise<Record<string, WithId<Resource>[]>> => {
  validateSearchResourceTypes(repo, searchRequest)
  const param = getSearchParameter(searchRequest.resourceType, referenceField)
  if (param?.type !== "reference") {
    throw new OperationOutcomeError(
      badRequest(
        `Invalid reference search parameter on ${searchRequest.resourceType}: ${referenceField}`,
      ),
    )
  }
  applyCountAndOffsetLimits(searchRequest, repo.services.maxSearchOffset)
  const results: Record<string, WithId<Resource>[]> = Object.create(null)
  for (const value of referenceValues) {
    const rows = new Rows(repo)
    const request = {
      ...searchRequest,
      filters: [
        ...(searchRequest.filters ?? []),
        { code: referenceField, operator: "eq" as const, value },
      ],
    } as CountedRequest
    const matches = matchingRows(repo, rows, request).slice(
      request.offset,
      request.offset + request.count,
    )
    results[value] = matches.map((row) => {
      const resource = resourceOfRow(row, row.resourceType)
      removeResourceFields(resource, repo, searchRequest)
      return resource
    })
  }
  return results
}
