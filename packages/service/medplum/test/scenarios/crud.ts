import type { Scenario } from "../harness/scenario.js"

const patient = {
  resourceType: "Patient",
  identifier: [{ system: "https://example.org/mrn", value: "MRN-0001" }],
  active: true,
  name: [{ use: "official", given: ["Ada", "King"], family: "Lovelace" }],
  telecom: [
    { system: "email", value: "Ada@Example.org" },
    { system: "phone", value: "+1 555 0100" },
  ],
  gender: "female",
  birthDate: "1815-12-10",
  address: [
    { line: ["12 St James's Square"], city: "London", postalCode: "SW1Y 4JH", country: "UK" },
  ],
}

const id = (body: { id?: string }) => body?.id
const version = (body: { meta?: { versionId?: string } }) => body?.meta?.versionId

export const crudScenarios: Scenario[] = [
  {
    name: "super admin expunges a resource and all history",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: patient,
        save: { patient: id },
      },
      {
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        body: (v) => ({ ...patient, id: v.patient, active: false }),
      },
      {
        name: "a project client cannot expunge",
        method: "POST",
        path: (v) => `/fhir/R4/Patient/${v.patient}/$expunge`,
      },
      {
        method: "POST",
        path: (v) => `/fhir/R4/Patient/${v.patient}/$expunge`,
        auth: "super",
      },
      {
        method: "GET",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        auth: "super",
      },
      {
        method: "GET",
        path: (v) => `/fhir/R4/Patient/${v.patient}/_history`,
        auth: "super",
      },
    ],
  },
  {
    name: "patient lifecycle: create, read, update, vread, history, delete, gone",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: patient,
        save: { patient: id, v1: version },
      },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}` },
      {
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        body: (v) => ({
          ...patient,
          id: v.patient,
          name: [{ given: ["Augusta"], family: "King" }],
        }),
        save: { v2: version },
      },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/_history/${v.v1}` },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/_history/${v.v2}` },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/_history` },
      { method: "DELETE", path: (v) => `/fhir/R4/Patient/${v.patient}` },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}` },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/_history` },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/_history/${v.v1}` },
      { method: "DELETE", path: (v) => `/fhir/R4/Patient/${v.patient}` },
      {
        name: "PUT restores a deleted patient",
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        body: (v) => ({ resourceType: "Patient", id: v.patient, active: false }),
      },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/_history?_count=2&_offset=1` },
    ],
  },
  {
    name: "update that changes nothing keeps the version",
    steps: [
      { method: "POST", path: "/fhir/R4/Patient", body: patient, save: { patient: id } },
      {
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        body: (v) => ({ ...patient, id: v.patient }),
      },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/_history` },
    ],
  },
  {
    name: "read errors",
    steps: [
      { method: "GET", path: "/fhir/R4/Patient/not-a-uuid" },
      { method: "GET", path: "/fhir/R4/Patient/00000000-0000-4000-8000-000000000000" },
      { method: "GET", path: "/fhir/R4/NotAType/00000000-0000-4000-8000-000000000000" },
      { method: "GET", path: "/fhir/R4/Patient/00000000-0000-4000-8000-000000000000/_history" },
      {
        method: "GET",
        path: "/fhir/R4/Patient/00000000-0000-4000-8000-000000000000/_history/00000000-0000-4000-8000-000000000001",
      },
      { method: "DELETE", path: "/fhir/R4/Patient/00000000-0000-4000-8000-000000000000" },
      { method: "DELETE", path: "/fhir/R4/Patient/nope" },
    ],
  },
  {
    name: "validation errors on create",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient", birthDate: "not-a-date" },
      },
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient", unknownField: 1 },
      },
      { method: "POST", path: "/fhir/R4/Patient", body: { resourceType: "Patient", gender: 7 } },
      { method: "POST", path: "/fhir/R4/Patient", body: { resourceType: "Patient", name: "Ada" } },
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient", name: [{ given: "Ada" }] },
      },
      { method: "POST", path: "/fhir/R4/Patient", body: { resourceType: "Patient", active: null } },
      { method: "POST", path: "/fhir/R4/Patient", body: { resourceType: "Observation" } },
      { method: "POST", path: "/fhir/R4/Patient", body: {} },
      { method: "POST", path: "/fhir/R4/Observation", body: { resourceType: "Observation" } },
      {
        method: "POST",
        path: "/fhir/R4/Observation",
        body: { resourceType: "Observation", status: "bogus", code: { text: "x" } },
      },
      { method: "POST", path: "/fhir/R4/Patient", raw: "{not json" },
      { method: "POST", path: "/fhir/R4/Patient", raw: '"a string"' },
      { method: "POST", path: "/fhir/R4/NotAType", body: { resourceType: "NotAType" } },
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient", birthDate: "1990-02-30" },
      },
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient", extension: [{ valueString: "x" }] },
      },
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient", id: "client-chosen" },
      },
    ],
  },
  {
    name: "update errors",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient" },
        save: { patient: id },
      },
      {
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        body: { resourceType: "Patient" },
      },
      {
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        body: (v) => ({ resourceType: "Observation", id: v.patient }),
      },
      {
        method: "PUT",
        path: "/fhir/R4/Patient/not-a-uuid",
        body: { resourceType: "Patient", id: "not-a-uuid" },
      },
      {
        method: "PUT",
        path: "/fhir/R4/Patient/00000000-0000-4000-8000-00000000000a",
        body: { resourceType: "Patient", id: "00000000-0000-4000-8000-00000000000a" },
      },
      {
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        body: (v) => ({ resourceType: "Patient", id: v.patient, birthDate: "x" }),
      },
    ],
  },
  {
    name: "version-aware update with If-Match",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient" },
        save: { patient: id, v1: version },
      },
      {
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        headers: (v) => ({ "if-match": `W/"${v.v1}"` }),
        body: (v) => ({ resourceType: "Patient", id: v.patient, active: true }),
        save: { v2: version },
      },
      {
        name: "stale If-Match is refused",
        method: "PUT",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        headers: (v) => ({ "if-match": `W/"${v.v1}"` }),
        body: (v) => ({ resourceType: "Patient", id: v.patient, active: false }),
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        headers: (v) => ({ "if-match": `W/"${v.v1}"` }),
        contentType: "application/json-patch+json",
        body: [{ op: "add", path: "/gender", value: "male" }],
      },
    ],
  },
  {
    name: "Prefer and formatting headers",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        headers: { prefer: "return=minimal" },
        body: { resourceType: "Patient" },
        save: { location: (_b, r) => r.headers.get("location")?.split("/").pop() },
      },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.location}?_pretty=true` },
      {
        method: "GET",
        path: (v) => `/fhir/R4/Patient/${v.location}`,
        headers: { "x-medplum": "extended" },
      },
    ],
  },
]
