/**
 * The CapabilityStatement at `GET /fhir/R4/metadata`, ported from
 * packages/server/src/fhir/metadata.ts and config/capabilitystatement.ts (default config).
 * Apache-2.0, Copyright Orangebot, Inc. and Medplum contributors.
 */
import {
  ContentType,
  concatUrls,
  getAllDataTypes,
  getSearchParameters,
  HTTP_TERMINOLOGY_HL7_ORG,
  type InternalTypeSchema,
  isResourceType,
  MEDPLUM_VERSION,
} from "@medplum/core"
import type {
  CapabilityStatement,
  CapabilityStatementRestResource,
  CapabilityStatementRestResourceOperation,
  CapabilityStatementRestResourceSearchParam,
  ResourceType,
} from "@medplum/fhirtypes"

/** The server stamps `date` once, when the statement is first built. */
const STARTED_AT = new Date().toISOString()

const DEFAULT_RESOURCE_INTERACTIONS = [
  "read",
  "vread",
  "update",
  "patch",
  "delete",
  "history-instance",
  "create",
  "search-type",
] as const

/**
 * The base CapabilityStatement that seeds the server generated statement.
 */
const baseStmt: CapabilityStatement = {
  resourceType: "CapabilityStatement",
  id: "medplum-server",
  version: MEDPLUM_VERSION,
  name: "MedplumCapabilityStatement",
  title: "Medplum Capability Statement",
  status: "active",
  date: STARTED_AT,
  publisher: "Medplum",
  contact: [
    {
      telecom: [
        {
          system: "url",
          value: "https://www.medplum.com",
        },
      ],
    },
  ],
  description: "Medplum FHIR Capability Statement",
  jurisdiction: [
    {
      coding: [
        {
          system: "urn:iso:std:iso:3166",
          code: "US",
          display: "United States of America",
        },
      ],
    },
  ],
  kind: "instance",
  instantiates: [
    "http://hl7.org/fhir/us/core/CapabilityStatement/us-core-server",
    "http://hl7.org/fhir/uv/bulkdata/CapabilityStatement/bulk-data",
  ],
  implementationGuide: [
    "http://hl7.org/fhir/uv/fhircast/ImplementationGuide/hl7.fhir.uv.fhircast|3.0.0",
  ],
  fhirVersion: "4.0.1",
  format: ["json"],
  patchFormat: [ContentType.JSON_PATCH],
}

/**
 * A list of profiles that represent different use cases supported by the system.
 *
 * For a server, "supported by the system" means the system hosts/produces a set of resources that are conformant to a
 * particular profile, and allows clients that use its services to search using this profile and to find appropriate
 * data. For a client, it means the system will search by this profile and process data according to the guidance
 * implicit in the profile.
 *
 * See: https://www.hl7.org/fhir/capabilitystatement-definitions.html#CapabilityStatement.rest.resource.supportedProfile
 */
const supportedProfiles: Record<string, string[]> = {
  AllergyIntolerance: [
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-allergyintolerance",
  ],
  CarePlan: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-careplan"],
  CareTeam: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-careteam"],
  Condition: [
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-encounter-diagnosis",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-problems-health-concerns",
  ],
  Coverage: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-coverage"],
  Device: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-implantable-device"],
  DiagnosticReport: [
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-diagnosticreport-note",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-diagnosticreport-lab",
  ],
  DocumentReference: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-documentreference"],
  Encounter: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-encounter"],
  Goal: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-goal"],
  Immunization: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-immunization"],
  Location: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-location"],
  Medication: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-medication"],
  MedicationDispense: [
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-medicationdispense",
  ],
  MedicationRequest: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-medicationrequest"],
  Observation: [
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-bmi",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-head-circumference",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-height",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-weight",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-temperature",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-heart-rate",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-respiratory-rate",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-clinical-result",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-occupation",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-pregnancyintent",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-pregnancystatus",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-screening-assessment",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-sexual-orientation",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-treatment-intervention-preference",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-care-experience-preference",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-average-blood-pressure",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-smokingstatus",
    "http://hl7.org/fhir/us/core/StructureDefinition/pediatric-weight-for-height",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-observation-lab",
    "http://hl7.org/fhir/us/core/StructureDefinition/pediatric-bmi-for-age",
    "http://hl7.org/fhir/us/core/StructureDefinition/us-core-pulse-oximetry",
    "http://hl7.org/fhir/us/core/StructureDefinition/head-occipital-frontal-circumference-percentile",
    "http://hl7.org/fhir/StructureDefinition/heartrate",
    "http://hl7.org/fhir/StructureDefinition/bodyheight",
    "http://hl7.org/fhir/StructureDefinition/bp",
    "http://hl7.org/fhir/StructureDefinition/bodyweight",
    "http://hl7.org/fhir/StructureDefinition/bodytemp",
    "http://hl7.org/fhir/StructureDefinition/resprate",
  ],
  Organization: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-organization"],
  Patient: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"],
  Practitioner: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner"],
  PractitionerRole: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitionerrole"],
  Procedure: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-procedure"],
  Provenance: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-provenance"],
  RelatedPerson: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-relatedperson"],
  ServiceRequest: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-servicerequest"],
  Specimen: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-specimen"],
}

const supportedOperations: Record<string, CapabilityStatementRestResourceOperation[]> = {
  Group: [
    {
      name: "export",
      definition: "http://hl7.org/fhir/uv/bulkdata/OperationDefinition/group-export",
    },
  ],
}

/**
 * A list of the advanced search parameters that are FHIR Search Result Parameters applicable to the server.
 * See: https://www.hl7.org/fhir/search.html#modifyingresults
 */
const supportedSearchParams: CapabilityStatementRestResourceSearchParam[] = [
  {
    name: "_sort",
    definition: "https://www.hl7.org/fhir/search.html#_sort",
    type: "string",
  },
  {
    name: "_total",
    definition: "https://www.hl7.org/fhir/search.html#_total",
    type: "string",
  },
  {
    name: "_count",
    definition: "https://www.hl7.org/fhir/search.html#_count",
    type: "number",
  },
  {
    name: "_summary",
    definition: "https://www.hl7.org/fhir/search.html#_summary",
    type: "token",
  },
  {
    name: "_elements",
    definition: "https://www.hl7.org/fhir/search.html#_elements",
    type: "string",
  },
]

const cache = new Map<string, CapabilityStatement>()

export const capabilityStatement = (baseUrl: string): CapabilityStatement => {
  const existing = cache.get(baseUrl)
  if (existing) return existing
  const fhirBaseUrl = concatUrls(baseUrl, "fhir/R4/")
  const statement: CapabilityStatement = {
    ...baseStmt,
    url: concatUrls(fhirBaseUrl, "metadata"),
    software: { name: "medplum", version: MEDPLUM_VERSION },
    implementation: { description: "medplum", url: fhirBaseUrl },
    rest: [
      {
        mode: "server",
        security: {
          cors: true,
          service: ["OAuth", "Basic", "SMART-on-FHIR"].map((service) => ({
            coding: [
              {
                system: `${HTTP_TERMINOLOGY_HL7_ORG}/CodeSystem/restful-security-service`,
                code: service,
              },
            ],
          })),
          extension: [
            {
              url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
              extension: [
                { url: "authorize", valueUri: `${baseUrl}oauth2/authorize` },
                { url: "token", valueUri: `${baseUrl}oauth2/token` },
                { url: "introspect", valueUri: `${baseUrl}oauth2/introspect` },
              ],
            },
          ],
        },
        resource: Object.entries(getAllDataTypes())
          .filter(
            ([resourceType, typeSchema]) =>
              isResourceType(resourceType) &&
              typeSchema.url?.startsWith("http://hl7.org/fhir/StructureDefinition/") &&
              typeSchema.version === "4.0.1",
          )
          .map(
            ([resourceType, typeSchema]) =>
              ({
                type: resourceType as ResourceType,
                profile: typeSchema.url,
                supportedProfile: supportedProfiles[resourceType]?.length
                  ? supportedProfiles[resourceType]
                  : undefined,
                interaction: DEFAULT_RESOURCE_INTERACTIONS.map((code) => ({ code })),
                versioning: "versioned",
                readHistory: true,
                updateCreate: false,
                conditionalCreate: true,
                conditionalUpdate: true,
                conditionalRead: "not-supported",
                conditionalDelete: "single",
                referencePolicy: ["literal", "logical", "local"],
                searchParam: buildSearchParameters(typeSchema),
                operation: supportedOperations[resourceType],
              }) satisfies CapabilityStatementRestResource,
          ),
        interaction: [{ code: "transaction" }, { code: "batch" }],
        searchParam: supportedSearchParams,
        extension: [
          {
            extension: [{ url: "hub.url", valueUrl: `${baseUrl}fhircast/STU3` }],
            url: "http://hl7.org/fhir/uv/fhircast/StructureDefinition/fhircast-configuration-extension",
          },
        ],
      },
    ],
  }
  cache.set(baseUrl, statement)
  return statement
}

const buildSearchParameters = (
  typeSchema: InternalTypeSchema,
): CapabilityStatementRestResourceSearchParam[] | undefined => {
  const searchParams = getSearchParameters(typeSchema.name)
  if (!searchParams) return undefined
  const entries = Object.values(searchParams)
  if (entries.length === 0) return undefined
  return entries.map((param) => ({ name: param.code, definition: param.url, type: param.type }))
}
