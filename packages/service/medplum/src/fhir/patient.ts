import {
  evalFhirPath,
  getReferenceString,
  getSearchParameter,
  getSearchParameterDetails,
} from "@medplum/core"
import type { Patient, Reference, Resource } from "@medplum/fhirtypes"
import { patientCompartment } from "../generated/definitions-data.js"

/** The search parameters that place `resourceType` in a Patient's compartment, if any. */
export const getPatientCompartmentParams = (resourceType: string): string[] | undefined =>
  patientCompartment[resourceType]

/** Every resource type in the Patient compartment. */
export const getPatientResourceTypes = (): string[] => Object.keys(patientCompartment)

/**
 * The patients a resource belongs to, as `Patient/<id>` references (the server's
 * `getPatients` in fhir/patient.ts): itself for a Patient, plus every `Patient/…` reference
 * reached through its compartment search parameters.
 */
export const getPatients = (resource: Resource): (Reference<Patient> & { reference: string })[] => {
  const result = new Set<string>()
  if (resource.resourceType === "Patient" && resource.id) {
    result.add(getReferenceString(resource as Patient & { id: string }))
  }
  for (const code of getPatientCompartmentParams(resource.resourceType) ?? []) {
    const searchParam = getSearchParameter(resource.resourceType, code)
    if (!searchParam) continue
    const details = getSearchParameterDetails(resource.resourceType, searchParam)
    for (const value of evalFhirPath(details.parsedExpression, resource)) {
      const reference = (value as Reference | undefined)?.reference
      if (value && typeof value === "object" && reference?.startsWith("Patient/")) {
        result.add(reference)
      }
    }
  }
  return [...result].map((reference) => ({ reference }))
}
