import type { Scenario } from "../harness/scenario.js"

const id = (body: { id?: string }) => body?.id
const version = (body: { meta?: { versionId?: string } }) => body?.meta?.versionId
const entryId = (index: number) => (body: { entry?: { resource?: { id?: string } }[] }) =>
  body?.entry?.[index]?.resource?.id

export const writeScenarios: Scenario[] = [
  {
    name: "transaction bundle with urn:uuid references",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4",
        body: {
          resourceType: "Bundle",
          type: "transaction",
          entry: [
            {
              fullUrl: "urn:uuid:3f0a1c2e-0000-4000-8000-000000000001",
              request: { method: "POST", url: "Patient" },
              resource: { resourceType: "Patient", name: [{ family: "Transact" }] },
            },
            {
              request: { method: "POST", url: "Observation" },
              resource: {
                resourceType: "Observation",
                status: "final",
                code: { text: "glucose" },
                subject: { reference: "urn:uuid:3f0a1c2e-0000-4000-8000-000000000001" },
              },
            },
            { request: { method: "GET", url: "Patient?name=transact" } },
          ],
        },
        save: { patient: entryId(0), observation: entryId(1) },
      },
      { method: "GET", path: (v) => `/fhir/R4/Observation/${v.observation}` },
      {
        name: "a failing transaction rolls every entry back",
        method: "POST",
        path: "/fhir/R4",
        body: {
          resourceType: "Bundle",
          type: "transaction",
          entry: [
            {
              request: { method: "POST", url: "Patient" },
              resource: { resourceType: "Patient", name: [{ family: "RolledBack" }] },
            },
            {
              request: { method: "POST", url: "Observation" },
              resource: { resourceType: "Observation" },
            },
          ],
        },
      },
      { method: "GET", path: "/fhir/R4/Patient?name=rolledback" },
      {
        name: "update and delete inside a transaction",
        method: "POST",
        path: "/fhir/R4",
        body: (v) => ({
          resourceType: "Bundle",
          type: "transaction",
          entry: [
            {
              request: { method: "PUT", url: `Patient/${v.patient}` },
              resource: { resourceType: "Patient", id: v.patient, name: [{ family: "Updated" }] },
            },
            { request: { method: "DELETE", url: `Observation/${v.observation}` } },
          ],
        }),
      },
      { method: "GET", path: (v) => `/fhir/R4/Observation/${v.observation}` },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}` },
    ],
  },
  {
    name: "batch bundle: independent entries, mixed outcomes",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient", name: [{ family: "Batched" }] },
        save: { patient: id },
      },
      {
        method: "POST",
        path: "/fhir/R4",
        body: (v) => ({
          resourceType: "Bundle",
          type: "batch",
          entry: [
            { request: { method: "GET", url: `Patient/${v.patient}` } },
            { request: { method: "GET", url: "Patient/00000000-0000-4000-8000-000000000000" } },
            {
              request: { method: "POST", url: "Patient" },
              resource: { resourceType: "Patient", gender: "other" },
            },
            {
              request: { method: "POST", url: "Patient" },
              resource: { resourceType: "Patient", birthDate: "nope" },
            },
            { request: { method: "GET", url: "Patient?name=batched&_total=accurate" } },
            { request: { method: "DELETE", url: `Patient/${v.patient}` } },
            {
              request: { method: "PATCH", url: `Patient/${v.patient}` },
              resource: {
                resourceType: "Binary",
                contentType: "application/json-patch+json",
                data: btoa('[{"op":"add","path":"/active","value":true}]'),
              },
            },
          ],
        }),
      },
      {
        method: "POST",
        path: "/fhir/R4",
        body: { resourceType: "Bundle", type: "collection", entry: [] },
      },
      { method: "POST", path: "/fhir/R4", body: { resourceType: "Patient" } },
      { method: "POST", path: "/fhir/R4", body: { resourceType: "Bundle", type: "batch" } },
      {
        method: "POST",
        path: "/fhir/R4",
        body: {
          resourceType: "Bundle",
          type: "batch",
          entry: [
            { request: { method: "GET", url: "NotAType/1" } },
            { resource: { resourceType: "Patient" } },
          ],
        },
      },
    ],
  },
  {
    name: "conditional create, update, patch and delete",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        headers: { "if-none-exist": "identifier=https://example.org/mrn|COND-1" },
        body: {
          resourceType: "Patient",
          identifier: [{ system: "https://example.org/mrn", value: "COND-1" }],
        },
        save: { patient: id },
      },
      {
        name: "a second conditional create returns the existing patient",
        method: "POST",
        path: "/fhir/R4/Patient",
        headers: { "if-none-exist": "identifier=https://example.org/mrn|COND-1" },
        body: {
          resourceType: "Patient",
          identifier: [{ system: "https://example.org/mrn", value: "COND-1" }],
          active: true,
        },
      },
      {
        method: "PUT",
        path: "/fhir/R4/Patient?identifier=https://example.org/mrn|COND-1",
        body: {
          resourceType: "Patient",
          identifier: [{ system: "https://example.org/mrn", value: "COND-1" }],
          gender: "unknown",
        },
      },
      {
        name: "conditional update creates when nothing matches",
        method: "PUT",
        path: "/fhir/R4/Patient?identifier=https://example.org/mrn|COND-2",
        body: {
          resourceType: "Patient",
          identifier: [{ system: "https://example.org/mrn", value: "COND-2" }],
        },
      },
      {
        name: "conditional update with a client id and no match is refused",
        method: "PUT",
        path: "/fhir/R4/Patient?identifier=https://example.org/mrn|COND-3",
        body: { resourceType: "Patient", id: "00000000-0000-4000-8000-0000000000c3" },
      },
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: {
          resourceType: "Patient",
          identifier: [{ system: "https://example.org/mrn", value: "COND-1" }],
        },
      },
      {
        name: "multiple matches are a 412",
        method: "POST",
        path: "/fhir/R4/Patient",
        headers: { "if-none-exist": "identifier=https://example.org/mrn|COND-1" },
        body: { resourceType: "Patient" },
      },
      {
        method: "PATCH",
        path: "/fhir/R4/Patient?identifier=https://example.org/mrn|COND-2",
        contentType: "application/json-patch+json",
        body: [{ op: "add", path: "/active", value: true }],
      },
      {
        method: "PATCH",
        path: "/fhir/R4/Patient?identifier=https://example.org/mrn|NOPE",
        contentType: "application/json-patch+json",
        body: [{ op: "add", path: "/active", value: true }],
      },
      { method: "DELETE", path: "/fhir/R4/Patient?identifier=https://example.org/mrn|COND-2" },
      { method: "DELETE", path: "/fhir/R4/Patient?identifier=https://example.org/mrn|COND-1" },
      { method: "DELETE", path: "/fhir/R4/Patient?identifier=https://example.org/mrn|NOTHING" },
      {
        method: "GET",
        path: "/fhir/R4/Patient?identifier=https://example.org/mrn|&_total=accurate",
      },
    ],
  },
  {
    name: "patch: JSON Patch and FHIRPath Patch",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: {
          resourceType: "Patient",
          name: [{ given: ["Pat"], family: "Ch" }],
          gender: "female",
        },
        save: { patient: id, v1: version },
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        contentType: "application/json-patch+json",
        body: [
          { op: "replace", path: "/gender", value: "male" },
          { op: "add", path: "/name/0/given/-", value: "Middle" },
          { op: "add", path: "/telecom", value: [{ system: "phone", value: "555" }] },
        ],
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        contentType: "application/json-patch+json",
        body: [{ op: "test", path: "/gender", value: "female" }],
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        contentType: "application/json-patch+json",
        body: [{ op: "remove", path: "/nothing/here" }],
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        contentType: "application/json-patch+json",
        body: [{ op: "replace", path: "/birthDate", value: "not a date" }],
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        contentType: "application/json-patch+json",
        body: [{ op: "add", path: "/extra/deep", value: 1 }],
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        contentType: "application/json-patch+json",
        body: { op: "add" },
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        contentType: "application/fhir+json",
        body: {
          resourceType: "Parameters",
          parameter: [
            {
              name: "operation",
              part: [
                { name: "type", valueCode: "add" },
                { name: "path", valueString: "Patient" },
                { name: "name", valueString: "birthDate" },
                { name: "value", valueDate: "2000-01-01" },
              ],
            },
          ],
        },
      },
      {
        method: "PATCH",
        path: (v) => `/fhir/R4/Patient/${v.patient}`,
        contentType: "application/fhir+json",
        body: {
          resourceType: "Parameters",
          parameter: [
            {
              name: "operation",
              part: [
                { name: "type", valueCode: "replace" },
                { name: "path", valueString: "Patient.gender" },
                { name: "value", valueCode: "other" },
              ],
            },
          ],
        },
      },
      {
        method: "PATCH",
        path: "/fhir/R4/Patient/00000000-0000-4000-8000-000000000000",
        contentType: "application/json-patch+json",
        body: [],
      },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/_history` },
    ],
  },
  {
    name: "resource variety: create and read common clinical resources",
    steps: [
      {
        method: "POST",
        path: "/fhir/R4/Patient",
        body: { resourceType: "Patient" },
        save: { patient: id },
      },
      {
        method: "POST",
        path: "/fhir/R4/Practitioner",
        body: { resourceType: "Practitioner", name: [{ family: "Doc" }] },
        save: { doc: id },
      },
      {
        method: "POST",
        path: "/fhir/R4/Appointment",
        body: (v) => ({
          resourceType: "Appointment",
          status: "booked",
          start: "2025-01-02T15:00:00Z",
          end: "2025-01-02T15:30:00Z",
          participant: [
            { actor: { reference: `Patient/${v.patient}` }, status: "accepted" },
            { actor: { reference: `Practitioner/${v.doc}` }, status: "accepted" },
          ],
        }),
        save: { appointment: id },
      },
      { method: "GET", path: (v) => `/fhir/R4/Appointment?patient=${v.patient}` },
      { method: "GET", path: "/fhir/R4/Appointment?date=ge2025-01-01&_sort=date" },
      {
        method: "POST",
        path: "/fhir/R4/Appointment",
        body: { resourceType: "Appointment", status: "booked" },
      },
      {
        method: "POST",
        path: "/fhir/R4/ServiceRequest",
        body: (v) => ({
          resourceType: "ServiceRequest",
          status: "active",
          intent: "order",
          subject: { reference: `Patient/${v.patient}` },
          code: { text: "CBC" },
        }),
        save: { order: id },
      },
      {
        method: "POST",
        path: "/fhir/R4/DiagnosticReport",
        body: (v) => ({
          resourceType: "DiagnosticReport",
          status: "final",
          code: { text: "CBC" },
          subject: { reference: `Patient/${v.patient}` },
          basedOn: [{ reference: `ServiceRequest/${v.order}` }],
        }),
      },
      {
        method: "GET",
        path: (v) => `/fhir/R4/DiagnosticReport?based-on=ServiceRequest/${v.order}`,
      },
      {
        method: "POST",
        path: "/fhir/R4/MedicationRequest",
        body: (v) => ({
          resourceType: "MedicationRequest",
          status: "active",
          intent: "order",
          medicationCodeableConcept: { text: "Aspirin" },
          subject: { reference: `Patient/${v.patient}` },
        }),
      },
      { method: "GET", path: "/fhir/R4/MedicationRequest?code:text=aspirin" },
      {
        method: "POST",
        path: "/fhir/R4/Questionnaire",
        body: {
          resourceType: "Questionnaire",
          status: "active",
          url: "https://example.org/q/intake",
          item: [{ linkId: "1", type: "string", text: "Name?" }],
        },
      },
      {
        method: "POST",
        path: "/fhir/R4/QuestionnaireResponse",
        body: (v) => ({
          resourceType: "QuestionnaireResponse",
          status: "completed",
          questionnaire: "https://example.org/q/intake",
          subject: { reference: `Patient/${v.patient}` },
          item: [{ linkId: "1", answer: [{ valueString: "Pat" }] }],
        }),
      },
      {
        method: "GET",
        path: "/fhir/R4/QuestionnaireResponse?questionnaire=https://example.org/q/intake",
      },
      { method: "GET", path: "/fhir/R4/QuestionnaireResponse?questionnaire.status=active" },
      {
        method: "POST",
        path: "/fhir/R4/Task",
        body: (v) => ({
          resourceType: "Task",
          status: "requested",
          intent: "order",
          for: { reference: `Patient/${v.patient}` },
          code: { text: "Call patient" },
        }),
      },
      { method: "GET", path: "/fhir/R4/Task?code=Call%20patient" },
      {
        method: "POST",
        path: "/fhir/R4/Communication",
        body: (v) => ({
          resourceType: "Communication",
          status: "completed",
          subject: { reference: `Patient/${v.patient}` },
          payload: [{ contentString: "hi" }],
        }),
      },
      {
        method: "POST",
        path: "/fhir/R4/AllergyIntolerance",
        body: (v) => ({
          resourceType: "AllergyIntolerance",
          patient: { reference: `Patient/${v.patient}` },
          code: { text: "Peanut" },
        }),
      },
      {
        method: "POST",
        path: "/fhir/R4/Coverage",
        body: (v) => ({
          resourceType: "Coverage",
          status: "active",
          beneficiary: { reference: `Patient/${v.patient}` },
          payor: [{ display: "Acme" }],
        }),
      },
      {
        method: "POST",
        path: "/fhir/R4/CarePlan",
        body: (v) => ({
          resourceType: "CarePlan",
          status: "active",
          intent: "plan",
          subject: { reference: `Patient/${v.patient}` },
        }),
      },
      {
        method: "POST",
        path: "/fhir/R4/DocumentReference",
        body: (v) => ({
          resourceType: "DocumentReference",
          status: "current",
          subject: { reference: `Patient/${v.patient}` },
          content: [{ attachment: { contentType: "text/plain", data: btoa("hello") } }],
        }),
      },
      {
        method: "POST",
        path: "/fhir/R4/Schedule",
        body: (v) => ({
          resourceType: "Schedule",
          actor: [{ reference: `Practitioner/${v.doc}` }],
        }),
        save: { schedule: id },
      },
      {
        method: "POST",
        path: "/fhir/R4/Slot",
        body: (v) => ({
          resourceType: "Slot",
          schedule: { reference: `Schedule/${v.schedule}` },
          status: "free",
          start: "2025-02-01T10:00:00Z",
          end: "2025-02-01T10:30:00Z",
        }),
      },
      { method: "GET", path: "/fhir/R4/Slot?status=free&start=ge2025-02-01" },
      { method: "GET", path: (v) => `/fhir/R4/Patient/${v.patient}/$everything` },
      {
        method: "POST",
        path: "/fhir/R4/Observation",
        body: {
          resourceType: "Observation",
          status: "final",
          code: { text: "x" },
          valueString: "a",
          valueBoolean: true,
        },
      },
      {
        method: "POST",
        path: "/fhir/R4/Observation",
        body: (_v) => ({
          resourceType: "Observation",
          status: "final",
          code: { text: "x" },
          subject: { reference: "Patient?identifier=nothing" },
        }),
      },
    ],
  },
]
