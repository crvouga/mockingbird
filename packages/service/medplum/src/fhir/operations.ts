/**
 * `GET|POST /Patient/:id/$everything`, ported from
 * packages/server/src/fhir/operations/patienteverything.ts and utils/caredate.ts: the patient's
 * compartment across its resource types (by `_lastUpdated`), filtered by care date, plus the
 * Organizations, Locations, Practitioners, … it references, deduplicated.
 */
import {
  AccessPolicyInteraction,
  allOk,
  evalFhirPathTyped,
  type Filter,
  getReferenceString,
  isReference,
  isResource,
  Operator,
  sortStringArray,
  toTypedValue,
  type WithId,
} from "@medplum/core"
import type {
  Bundle,
  BundleEntry,
  BundleLink,
  Patient,
  Reference,
  Resource,
} from "@medplum/fhirtypes"
import type { FhirRepository, FhirRequest, FhirResponse } from "../vendor/fhir-router/index.js"
import { getPatientResourceTypes } from "./patient.js"
import type { MockRepository } from "./repo.js"

const DEFAULT_MAX_RESULTS = 1000

const stringParam = (req: FhirRequest, name: string): string | undefined => {
  const fromBody =
    req.method === "POST" ? (req.body as Record<string, unknown> | undefined) : undefined
  const bodyValue = fromBody?.resourceType === "Parameters" ? undefined : fromBody?.[name]
  const value = req.query?.[name] ?? (typeof bodyValue === "string" ? bodyValue : undefined)
  return Array.isArray(value) ? value.find((v) => typeof v === "string") : value
}

const intParam = (req: FhirRequest, name: string): number | undefined => {
  const value = stringParam(req, name)
  return value === undefined ? undefined : Number.parseInt(value, 10)
}

const CARE_DATE_EXPRESSIONS: Record<string, string> = {
  AllergyIntolerance: "recordedDate",
  CarePlan: "created",
  ClinicalImpression: "date",
  Condition: "recordedDate",
  DeviceUseStatement: "recordedOn",
  DiagnosticReport: "issued",
  Encounter: "period.start",
  Goal: "startDate",
  Immunization: "occurrenceDateTime",
  MedicationRequest: "authoredOn",
  Observation: "issued",
  Procedure: "performedDateTime",
  ServiceRequest: "occurrenceDateTime",
}

const normalizeDateTime = (input: string | undefined): string | undefined => {
  if (!input) return undefined
  try {
    return new Date(input).toISOString()
  } catch {
    return undefined
  }
}

const careDate = (resource: Resource): string | undefined => {
  const expression = CARE_DATE_EXPRESSIONS[resource.resourceType]
  if (!expression) return undefined
  return normalizeDateTime(evalFhirPathTyped(expression, [toTypedValue(resource)])?.[0]?.value)
}

const ALLOWED_REFERENCE_TYPES =
  /^(Organization|Location|Practitioner|PractitionerRole|Medication|Device)\//

const collectReferences = (value: unknown, found = new Set<string>()): Set<string> => {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key]
      if (item && typeof item === "object") {
        if (isReference(item)) found.add(item.reference)
        else collectReferences(item, found)
      }
    }
  }
  return found
}

const addResolvedReferences = async (
  repo: MockRepository,
  entries: BundleEntry[],
): Promise<void> => {
  const processed = new Set<string>()
  let page: BundleEntry[] = entries
  while (page.length) {
    const references = new Set<string>()
    for (const entry of page) {
      const resource = entry.resource as WithId<Resource>
      const ref = getReferenceString(resource)
      if (processed.has(ref)) continue
      processed.add(ref)
      for (const reference of collectReferences(resource)) {
        if (!processed.has(reference) && ALLOWED_REFERENCE_TYPES.test(reference))
          references.add(reference)
      }
    }
    const resolved = await repo.readReferences(
      [...references].map((reference): Reference => ({ reference })),
    )
    page = resolved
      .filter((resource): resource is WithId<Resource> => isResource(resource))
      .map((resource): BundleEntry => ({ resource, search: { mode: "include" } }))
    entries.push(...page)
  }
}

const rewriteLink = (
  repo: MockRepository,
  link: BundleLink,
  patient: WithId<Patient>,
  params: { start?: string; end?: string; since?: string; count?: number; types: string[] },
): BundleLink => {
  const searchUrl = new URL(link.url as string)
  const url = new URL(`${repo.services.baseUrl}fhir/R4/Patient/${patient.id}/$everything`)
  const set = (name: string, value: string | number | undefined | null) => {
    if (value !== undefined && value !== null && value !== "")
      url.searchParams.set(name, String(value))
  }
  set("start", params.start)
  set("end", params.end)
  set("_since", params.since)
  set("_count", searchUrl.searchParams.get("_count") ?? params.count)
  set("_offset", searchUrl.searchParams.get("_offset"))
  set("_cursor", searchUrl.searchParams.get("_cursor"))
  if (params.types.length > 0) url.searchParams.set("_type", params.types.join(","))
  return { ...link, url: url.toString() }
}

export const patientEverything = async (
  req: FhirRequest,
  fhirRepo: FhirRepository,
): Promise<FhirResponse> => {
  const repo = fhirRepo as MockRepository
  const { id } = req.params as { id: string }
  const patient = await repo.readResource<Patient>("Patient", id)
  const requestedTypes = (stringParam(req, "_type") ?? "").split(",").filter(Boolean)
  const params = {
    start: stringParam(req, "start"),
    end: stringParam(req, "end"),
    since: stringParam(req, "_since"),
    count: intParam(req, "_count"),
    types: requestedTypes,
  }
  const types = [patient.resourceType as string]
  if (requestedTypes.length > 0) {
    types.push(...requestedTypes)
  } else {
    for (const type of getPatientResourceTypes()) {
      if (type !== "Binary" && repo.supportsInteraction(AccessPolicyInteraction.SEARCH, type))
        types.push(type)
    }
  }
  const uniqueTypes = [...new Set(types)]
  sortStringArray(uniqueTypes)
  const filters: Filter[] = []
  if (params.since) {
    filters.push({
      code: "_lastUpdated",
      operator: Operator.GREATER_THAN_OR_EQUALS,
      value: params.since,
    })
  }
  filters.push({
    code: "_compartment",
    operator: Operator.EQUALS,
    value: getReferenceString(patient),
  })
  const bundle = (await repo.search({
    resourceType: "Patient",
    types: uniqueTypes as Resource["resourceType"][],
    filters,
    count: params.count ?? DEFAULT_MAX_RESULTS,
    offset: intParam(req, "_offset"),
    cursor: stringParam(req, "_cursor"),
    sortRules: [{ code: "_lastUpdated" }],
  })) as Bundle<WithId<Resource>>
  if (bundle.link?.length)
    bundle.link = bundle.link.map((link) => rewriteLink(repo, link, patient, params))
  if (bundle.entry && (params.start || params.end)) {
    const start = normalizeDateTime(params.start)
    const end = normalizeDateTime(params.end)
    bundle.entry = bundle.entry.filter((entry) => {
      const date = careDate(entry.resource as Resource)
      if (!date) return true
      return (!start || date >= start) && (!end || date < end)
    })
  }
  if (bundle.entry) {
    await addResolvedReferences(repo, bundle.entry)
    const seen = new Set<string>()
    bundle.entry = bundle.entry.filter((entry) => {
      const ref = getReferenceString(entry.resource as WithId<Resource>)
      if (seen.has(ref)) return false
      seen.add(ref)
      return true
    })
  }
  return [allOk, bundle]
}
