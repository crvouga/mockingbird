/**
 * How the self-hosted server indexes each search parameter, ported from
 * packages/server/src/fhir/{searchparameter,tokens,token-column}.ts,
 * repository/row-builder.ts and lookups/{humanname,address,reference}.ts.
 *
 * The server writes one SQL column (or token array, or lookup-table rows) per parameter and
 * searches with SQL; the mock computes the same column values from the resource on demand
 * and evaluates the same predicates over them (see ./filters.ts).
 */
import {
  convertToSearchableDates,
  convertToSearchableNumbers,
  convertToSearchableQuantities,
  convertToSearchableReferences,
  convertToSearchableStrings,
  convertToSearchableTokens,
  convertToSearchableUris,
  deriveIdentifierSearchParameter,
  evalFhirPathTyped,
  formatAddress,
  formatFamilyName,
  formatGivenName,
  formatHumanName,
  getSearchParameterDetails,
  getSearchParameters,
  isResource,
  isUUID,
  PropertyType,
  resolveId,
  type SearchParameterDetails,
  SearchParameterType,
  type TypedValue,
  toTypedValue,
} from "@medplum/core"
import type { Address, HumanName, Resource, SearchParameter } from "@medplum/fhirtypes"

export const DELIM = "\x01"
export const NULL_SYSTEM = "\x02"
const TEXT_SEARCH_SYSTEM = "\x04"

export type ColumnValue = boolean | number | string | null | undefined

export type ColumnImpl = SearchParameterDetails & {
  strategy: "column"
  code: string
  columnName: string
  singleTargetType?: string | undefined
}

export type TokenImpl = SearchParameterDetails & {
  strategy: "token-column"
  code: string
  hasDedicatedColumns: boolean
  caseInsensitive: boolean
  textSearch: boolean
}

export type LookupImpl = SearchParameterDetails & {
  strategy: "lookup-table"
  code: string
  table: "HumanName" | "Address"
  /** The lookup-table column this parameter searches. */
  column: string
  /** HumanName parameters sort by a dedicated column on the resource table. */
  sortColumn: boolean
}

export type SearchImpl = ColumnImpl | TokenImpl | LookupImpl

const CONTAINS_SUPPORT_IDS = new Set([
  "individual-email",
  "individual-phone",
  "individual-telecom",
  "NamingSystem-telecom",
  "OrganizationAffiliation-email",
  "OrganizationAffiliation-phone",
  "OrganizationAffiliation-telecom",
])

export const HUMAN_NAME_PARAM_IDS = new Set([
  "individual-given",
  "individual-family",
  "Patient-name",
  "Person-name",
  "Practitioner-name",
  "RelatedPerson-name",
])

const HUMAN_NAME_TYPES = new Set(["Patient", "Person", "Practitioner", "RelatedPerson"])

const ADDRESS_PARAM_IDS = new Set(
  ["individual", "InsurancePlan", "Location", "Organization"].flatMap((base) =>
    ["", "-city", "-country", "-postalcode", "-state", "-use"].map((s) => `${base}-address${s}`),
  ),
)

const ADDRESS_TYPES = new Set([
  "Patient",
  "Person",
  "Practitioner",
  "RelatedPerson",
  "InsurancePlan",
  "Location",
  "Organization",
])

const DEDICATED_TOKEN_OVERRIDES: Record<string, boolean> = {
  "AuditEvent|entity-type": false,
  "AuditEvent|agent-role": false,
  "AuditEvent|subtype": false,
  "AuditEvent|_tag": false,
  "Observation|component-data-absent-reason": false,
  "Encounter|special-arrangement": false,
  "ServiceRequest|body-site": false,
  "Condition|body-site": false,
  "Condition|evidence": false,
  "DiagnosticReport|conclusion": false,
  "DocumentReference|setting": false,
  "DocumentReference|event": false,
  "EvidenceVariable|context": false,
  "EvidenceVariable|context-type": false,
  "EvidenceVariable|jurisdiction": false,
  "EvidenceVariable|topic": false,
  "MedicationRequest|intended-performertype": false,
  "ResearchStudy|category": false,
  "ResearchStudy|classifier": false,
  "ResearchStudy|focus": false,
  "ResearchStudy|location": false,
  "ResearchStudy|objective-type": false,
  "ResearchStudy|region": false,
  "Appointment|reason-code": false,
  "Observation|patient:identifier": true,
  "Observation|performer:identifier": true,
  "Observation|subject:identifier": true,
  "ServiceRequest|subject:identifier": true,
  "ResearchStudy|eligibility:identifier": true,
  "DiagnosticReport|result:identifier": true,
}

const hasDedicatedTokenColumns = (param: SearchParameter, resourceType: string): boolean => {
  const override = DEDICATED_TOKEN_OVERRIDES[`${resourceType}|${param.code}`]
  if (override !== undefined) return override
  if (param.code.endsWith(":identifier")) return false
  if (param.code === "_security") return false
  return true
}

/** `getTokenIndexType`: "CASE_SENSITIVE" | "CASE_INSENSITIVE" for token-table parameters. */
const tokenIndexType = (
  param: SearchParameter,
  resourceType: string,
): "CASE_SENSITIVE" | "CASE_INSENSITIVE" | undefined => {
  if (param.type !== "token") return undefined
  if (param.code?.endsWith(":identifier")) return "CASE_SENSITIVE"
  const details = getSearchParameterDetails(resourceType, param)
  if (!details.elementDefinitions?.length) return undefined
  for (const element of details.elementDefinitions) {
    for (const type of element.type ?? []) {
      if (type.code === PropertyType.ContactPoint) return "CASE_INSENSITIVE"
    }
  }
  for (const element of details.elementDefinitions) {
    for (const type of element.type ?? []) {
      if (
        type.code === PropertyType.Identifier ||
        type.code === PropertyType.CodeableConcept ||
        type.code === PropertyType.Coding
      ) {
        return "CASE_SENSITIVE"
      }
    }
  }
  return undefined
}

const columnName = (code: string): string => {
  if (code === "_compartment") return "compartments"
  return code
    .split(/[-:]/)
    .reduce(
      (result, word, index) =>
        result + (index ? word.charAt(0).toUpperCase() + word.slice(1) : word),
      "",
    )
}

const addressColumn = (code: string): string => {
  if (code === "address") return "address"
  if (code === "address-postalcode") return "postalCode"
  return code.replace("address-", "")
}

const implCache = new Map<string, SearchImpl>()

/** `getSearchParameterImplementation`: which strategy (and column) the server indexes a parameter with. */
export const getSearchImpl = (resourceType: string, param: SearchParameter): SearchImpl => {
  const key = `${resourceType}|${param.code}|${param.id ?? ""}`
  const cached = implCache.get(key)
  if (cached) return cached
  const impl = buildSearchImpl(resourceType, param)
  implCache.set(key, impl)
  return impl
}

const buildSearchImpl = (resourceType: string, param: SearchParameter): SearchImpl => {
  const details = getSearchParameterDetails(resourceType, param)
  const code = param.code
  if (param.type === "date" || param.type === "number" || param.type === "quantity") {
    // Range columns are only searched when `rangeSearch` is on (off by default), so these
    // behave as plain columns.
    return { ...details, strategy: "column", code, columnName: columnName(code) }
  }
  const tokenType = tokenIndexType(param, resourceType)
  if (tokenType) {
    return {
      ...details,
      strategy: "token-column",
      code,
      hasDedicatedColumns: hasDedicatedTokenColumns(param, resourceType),
      caseInsensitive: tokenType === "CASE_INSENSITIVE",
      textSearch: CONTAINS_SUPPORT_IDS.has(param.id as string),
    }
  }
  if (ADDRESS_PARAM_IDS.has(param.id as string)) {
    return {
      ...details,
      strategy: "lookup-table",
      code,
      table: "Address",
      column: addressColumn(code),
      sortColumn: false,
    }
  }
  if (HUMAN_NAME_PARAM_IDS.has(param.id as string)) {
    return {
      ...details,
      strategy: "lookup-table",
      code,
      table: "HumanName",
      column: code,
      sortColumn: true,
    }
  }
  const impl: ColumnImpl = { ...details, strategy: "column", code, columnName: columnName(code) }
  if (
    param.type === "reference" &&
    details.type !== SearchParameterType.CANONICAL &&
    details.referenceTargetTypes?.length === 1
  ) {
    impl.singleTargetType = details.referenceTargetTypes[0]
  }
  return impl
}

/** `truncateTextColumn`: empty values are dropped; long ones cut to 2048 UTF-8 bytes. */
const MAX_INDEX_DATA_BYTES = 2048
const encoder = new TextEncoder()
const decoder = new TextDecoder()
export const truncateTextColumn = (value: string | undefined | null): string | undefined => {
  if (!value) return undefined
  if (encoder.encode(value).length <= MAX_INDEX_DATA_BYTES) return value
  const buffer = new Uint8Array(MAX_INDEX_DATA_BYTES)
  const { written } = encoder.encodeInto(value, buffer)
  return decoder.decode(buffer.subarray(0, written))
}

const typedValuesOf = (resource: Resource, impl: SearchParameterDetails): TypedValue[] =>
  evalFhirPathTyped(impl.parsedExpression, [toTypedValue(resource)])

/** `compareColumnValues`: how the server orders an array column's values before writing. */
export const compareColumnValues = (a: ColumnValue, b: ColumnValue): number => {
  if ((a ?? null) === (b ?? null)) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  return String(a).localeCompare(String(b))
}

/**
 * The value the server writes into a "column" strategy parameter's column: a scalar, or a
 * sorted array (undefined when empty) for array parameters. `null` is SQL NULL.
 */
export const columnValue = (
  resource: Resource,
  impl: ColumnImpl,
  param: SearchParameter,
): ColumnValue | ColumnValue[] => {
  const values = buildColumnValues(param, impl, typedValuesOf(resource, impl))
  if (impl.array) {
    values.sort(compareColumnValues)
    return values.length > 0 ? values : null
  }
  return values[0] ?? null
}

const buildColumnValues = (
  param: SearchParameter,
  details: SearchParameterDetails,
  typedValues: TypedValue[],
): ColumnValue[] => {
  const defined = <T>(values: (T | undefined)[]): T[] =>
    values.filter((v): v is T => v !== undefined)
  if (details.type === SearchParameterType.BOOLEAN) {
    const value = typedValues[0]?.value
    if (value === undefined || value === null) return [null]
    return [value === true || value === "true"]
  }
  if (details.type === SearchParameterType.DATE) {
    return defined(
      convertToSearchableDates(typedValues).map((p) => (p.start ?? p.end)?.substring(0, 10)),
    )
  }
  if (details.type === SearchParameterType.DATETIME) {
    return defined(convertToSearchableDates(typedValues).map((p) => p.start ?? p.end))
  }
  if (param.type === "number") {
    return defined(convertToSearchableNumbers(typedValues).map(([low, high]) => low ?? high))
  }
  if (param.type === "quantity") {
    return defined(convertToSearchableQuantities(typedValues).map((q) => q.value))
  }
  if (param.type === "reference") {
    return defined(convertToSearchableReferences(typedValues).map(truncateTextColumn))
  }
  if (param.type === "token") {
    return defined(convertToSearchableTokens(typedValues).map((t) => truncateTextColumn(t.value)))
  }
  if (param.type === "string") {
    return defined(convertToSearchableStrings(typedValues).map(truncateTextColumn))
  }
  if (param.type === "uri") {
    return defined(convertToSearchableUris(typedValues).map(truncateTextColumn))
  }
  return []
}

/** A token parameter's indexed values (`buildTokenColumns`), unhashed. */
export type TokenColumns = { tokens: Set<string>; text: string[]; sort: string | undefined }

export const tokenColumns = (resource: Resource, impl: TokenImpl): TokenColumns => {
  const typedValues = typedValuesOf(resource, impl)
  const all = convertToSearchableTokens(typedValues, {
    caseInsensitive: impl.caseInsensitive,
    textSearchSystem: TEXT_SEARCH_SYSTEM,
  })
  const tokens = new Set<string>()
  const text: string[] = []
  let sort: string | null = null
  const code = impl.code
  for (const token of all) {
    const system = token.system?.trim?.()
    let value = token.value?.trim?.()
    if (!system && !value) continue
    if (value && impl.caseInsensitive) value = value.toLocaleLowerCase()
    if (value && (system === TEXT_SEARCH_SYSTEM || impl.textSearch)) {
      text.push(impl.hasDedicatedColumns ? value : code + DELIM + value)
    }
    if (!impl.hasDedicatedColumns) tokens.add(code)
    const prefix = impl.hasDedicatedColumns ? "" : code + DELIM
    if (system && system !== TEXT_SEARCH_SYSTEM) {
      tokens.add(prefix + system)
      if (value) tokens.add(prefix + system + DELIM + value)
    }
    if (value) {
      sort = sort && sort.localeCompare(value) <= 0 ? sort : value
      tokens.add(prefix + DELIM + value)
      if (!system) tokens.add(prefix + NULL_SYSTEM + DELIM + value)
    }
  }
  return { tokens, text, sort: truncateTextColumn(sort) }
}

export type HumanNameRow = {
  name?: string | undefined
  given?: string | undefined
  family?: string | undefined
}
export type AddressRow = {
  address?: string | undefined
  city?: string | undefined
  country?: string | undefined
  postalCode?: string | undefined
  state?: string | undefined
  use?: string | undefined
}

const tokensOf = (input: string | undefined): Set<string> =>
  new Set(typeof input === "string" ? input.toLowerCase().split(/\s+/).filter(Boolean) : [])

/** `getNameString`: the formatted name plus any extra tokens from `text`. */
export const getNameString = (name: HumanName): string => {
  let result = formatHumanName(name)
  if (name.text) {
    const resultTokens = tokensOf(result)
    for (const token of tokensOf(name.text)) {
      if (!resultTokens.has(token)) {
        result += ` ${token}`
        resultTokens.add(token)
      }
    }
  }
  return result
}

/** `HumanNameTable.extractValues`: one row per distinct, non-empty name. */
export const humanNameRows = (resource: Resource): HumanNameRow[] => {
  if (!HUMAN_NAME_TYPES.has(resource.resourceType)) return []
  const out: HumanNameRow[] = []
  for (const name of ((resource as { name?: (HumanName | null)[] }).name ??
    []) as (HumanName | null)[]) {
    if (!name) continue
    const row = {
      name: getNameString(name) || undefined,
      given: formatGivenName(name) || undefined,
      family: formatFamilyName(name) || undefined,
    }
    if (
      (row.name || row.given || row.family) &&
      !out.some((n) => n.name === row.name && n.given === row.given && n.family === row.family)
    ) {
      out.push(row)
    }
  }
  return out
}

const USE_PRECEDENCE: Record<string, number> = {
  usual: 1,
  official: 2,
  "": 3,
  temp: 4,
  nickname: 5,
  anonymous: 6,
  old: 7,
  maiden: 8,
}

/** `getHumanNameSortValue`: the name a HumanName parameter sorts by. */
export const humanNameSortValue = (resource: Resource, code: string): string | undefined => {
  let result: string | undefined
  let precedence = Number.POSITIVE_INFINITY
  for (const name of ((resource as { name?: (HumanName | null)[] }).name ??
    []) as (HumanName | null)[]) {
    if (!name) continue
    const candidate =
      code === "given"
        ? formatGivenName(name)
        : code === "family"
          ? formatFamilyName(name)
          : getNameString(name)
    if (!candidate) continue
    const candidatePrecedence = USE_PRECEDENCE[name.use ?? ""] ?? 3
    if (
      !result ||
      candidatePrecedence < precedence ||
      (candidatePrecedence === precedence && candidate.localeCompare(result) < 0)
    ) {
      result = candidate
      precedence = candidatePrecedence
    }
  }
  return truncateTextColumn(result)
}

/** `AddressTable.extractValues`. */
export const addressRows = (resource: Resource): AddressRow[] => {
  if (!ADDRESS_TYPES.has(resource.resourceType)) return []
  let addresses: (Address | undefined | null)[] | undefined
  const r = resource as unknown as Record<string, unknown>
  if (resource.resourceType === "InsurancePlan") {
    addresses = ((r.contact as { address?: Address }[] | undefined) ?? []).map((c) => c.address)
  } else if (resource.resourceType === "Location") {
    addresses = r.address ? [r.address as Address] : undefined
  } else {
    addresses = r.address as Address[] | undefined
  }
  if (!Array.isArray(addresses)) return []
  const out: AddressRow[] = []
  for (const address of addresses) {
    if (!address) continue
    const row: AddressRow = {
      address: formatAddress(address) || undefined,
      city: address.city?.trim() || undefined,
      country: address.country?.trim() || undefined,
      postalCode: address.postalCode?.trim() || undefined,
      state: address.state?.trim() || undefined,
      use: address.use?.trim() || undefined,
    }
    const keys = ["address", "city", "country", "postalCode", "state", "use"] as const
    if (keys.some((k) => row[k]) && !out.some((a) => keys.every((k) => a[k] === row[k]))) {
      out.push(row)
    }
  }
  return out
}

/** `getSearchReferences`: the `<Type>_References` rows (code → target UUID) of a resource. */
export const referenceRows = (resource: Resource): { code: string; targetId: string }[] => {
  const params = getSearchParameters(resource.resourceType)
  if (!params) return []
  const rows = new Map<string, { code: string; targetId: string }>()
  for (const param of Object.values(params)) {
    if (
      param.type !== "reference" ||
      param.code === "_compartment" ||
      param.code.endsWith(":identifier")
    ) {
      continue
    }
    const details = getSearchParameterDetails(resource.resourceType, param)
    for (const value of evalFhirPathTyped(details.parsedExpression, [toTypedValue(resource)])) {
      if (value.type === PropertyType.Reference && value.value?.reference) {
        const targetId = resolveId(value.value)
        if (targetId && isUUID(targetId))
          rows.set(`${param.code}|${targetId}`, { code: param.code, targetId })
      }
      if (isResource(value.value) && value.value.id && isUUID(value.value.id)) {
        rows.set(`${param.code}|${value.value.id}`, { code: param.code, targetId: value.value.id })
      }
    }
  }
  return [...rows.values()]
}

/** Standard plus derived (`<code>:identifier`) search parameters, as the server indexes them. */
export const standardAndDerivedParameters = (resourceType: string): SearchParameter[] => {
  const standard = Object.values(getSearchParameters(resourceType) ?? {})
  return [
    ...standard,
    ...standard
      .filter((p) => p.type === "reference")
      .map((p) => deriveIdentifierSearchParameter(p)),
  ]
}
