import type { Scenario } from "../harness/scenario.js"

const id = (body: { id?: string }) => body?.id

export const miscScenarios: Scenario[] = [
  {
    name: "binary: raw upload, download, FHIR JSON, attachments",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Binary",
        raw: "hello, binary",
        contentType: "text/plain",
        save: { binary: id, version: (b) => b?.meta?.versionId, url: (b) => b?.url },
      },
      { method: "GET", path: (v) => `/fhir/R4/Binary/${v.binary}` },
      {
        method: "GET",
        path: (v) => `/fhir/R4/Binary/${v.binary}`,
        headers: { accept: "application/fhir+json" },
      },
      {
        name: "download through the presigned URL",
        method: "GET",
        auth: "none",
        path: (v) => `/${(v.url ?? "").replace(/^https?:\/\/[^/]+\//, "")}`,
      },
      {
        name: "a presigned URL without its signature",
        method: "GET",
        auth: "none",
        path: (v) => `/storage/${v.binary}/${v.version}`,
      },
      {
        method: "PUT",
        path: (v) => `/fhir/R4/Binary/${v.binary}`,
        raw: '{"a":1}',
        contentType: "application/json",
      },
      { method: "GET", path: (v) => `/fhir/R4/Binary/${v.binary}` },
      {
        method: "POST",
        path: "/fhir/R4/Binary",
        body: { resourceType: "Binary", contentType: "text/plain", data: btoa("inline data") },
        save: { inline: id },
      },
      { method: "GET", path: (v) => `/fhir/R4/Binary/${v.inline}` },
      {
        method: "POST",
        path: "/fhir/R4/DocumentReference",
        body: (v) => ({
          resourceType: "DocumentReference",
          status: "current",
          content: [{ attachment: { contentType: "text/plain", url: `Binary/${v.binary}` } }],
        }),
        save: { document: id },
      },
      {
        name: "attachment URLs come back presigned",
        method: "GET",
        path: (v) => `/fhir/R4/DocumentReference/${v.document}`,
      },
      { method: "GET", path: "/fhir/R4/Binary" },
      { method: "GET", path: "/fhir/R4/Binary/00000000-0000-4000-8000-000000000000" },
      { method: "DELETE", path: (v) => `/fhir/R4/Binary/${v.inline}` },
      { method: "GET", path: (v) => `/fhir/R4/Binary/${v.inline}` },
    ],
  },
  {
    name: "server: health, metadata and unknown routes",
    steps: [
      { method: "GET", path: "/", auth: "none" },
      { method: "GET", path: "/robots.txt", auth: "none" },
      { method: "GET", path: "/nope", auth: "none" },
      { method: "POST", path: "/nope/deeper", auth: "none", body: {} },
      { method: "GET", path: "/api/nope", auth: "none" },
      { method: "GET", path: "/fhir/R4/$versions", auth: "none" },
      { method: "GET", path: "/fhir/R4/NotAType/x/y/z" },
      {
        method: "PATCH",
        path: "/fhir/R4/Patient",
        contentType: "application/json-patch+json",
        body: [],
      },
      { method: "DELETE", path: "/fhir/R4/Patient" },
      { method: "GET", path: "/fhir/R4/Patient/$nope" },
      { method: "POST", path: "/fhir/R4/$nope", body: {} },
      {
        method: "POST",
        path: "/fhir/R4/Patient/$validate",
        body: { resourceType: "Patient", birthDate: "x" },
      },
      { method: "POST", path: "/fhir/R4/Patient/$validate", body: { resourceType: "Patient" } },
      { method: "GET", path: "/api/fhir/R4/Patient?_count=1" },
    ],
  },
  {
    name: "graphql",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient", name: [{ given: ["Q"], family: "Graph" }] },
        save: { patient: id },
      },
      {
        method: "POST",
        path: "/fhir/R4/Observation",
        body: (v) => ({
          resourceType: "Observation",
          status: "final",
          code: { text: "gq" },
          subject: { reference: `Patient/${v.patient}` },
        }),
      },
      {
        method: "POST",
        path: "/fhir/R4/$graphql",
        contentType: "application/json",
        body: { query: '{ PatientList(name: "graph") { id name { given family } } }' },
      },
      {
        method: "POST",
        path: "/fhir/R4/$graphql",
        contentType: "application/json",
        body: (v) => ({
          query: `{ Patient(id: "${v.patient}") { id ObservationList(_reference: subject) { status code { text } } } }`,
        }),
      },
      {
        method: "POST",
        path: "/fhir/R4/$graphql",
        contentType: "application/json",
        body: { query: "{ nope }" },
      },
      { method: "POST", path: "/fhir/R4/$graphql", contentType: "application/json", body: {} },
      {
        method: "POST",
        path: "/fhir/R4/$graphql",
        contentType: "application/json",
        body: {
          query:
            'mutation { PatientCreate(res: { resourceType: "Patient", gender: "other" }) { gender } }',
        },
      },
    ],
  },
]
