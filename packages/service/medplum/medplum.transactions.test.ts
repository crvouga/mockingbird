import { beforeEach, describe, expect, test } from "bun:test"
import type { Bundle, Project, Resource, Slot } from "@medplum/fhirtypes"
import {
  type Project as Credentials,
  mockTarget,
  provisionProject,
  type Target,
} from "./test/harness/target.js"

// The identical regressions can be sent to the pinned self-hosted oracle.
const oracleUrl = process.env.MOCKINGBIRD_MEDPLUM_ORACLE_URL
let target: Target
let credentials: Credentials
const request = async (method: string, path: string, body?: unknown, superAdmin = false) => {
  const response = await target.fetch(
    new Request(new URL(path, target.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${superAdmin ? credentials.superToken : credentials.token}`,
        "content-type": "application/fhir+json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}
const enableTransactions = async () => {
  const project = await request("GET", `fhir/R4/Project/${credentials.projectId}`, undefined, true)
  const result = await request(
    "PUT",
    `fhir/R4/Project/${credentials.projectId}`,
    { ...project.body, features: ["transaction-bundles"] } as Project,
    true,
  )
  expect(result.status).toBe(200)
}
const postBundle = (entry: Bundle["entry"], type = "transaction") =>
  request("POST", "fhir/R4", { resourceType: "Bundle", type, entry })

beforeEach(async () => {
  target = oracleUrl
    ? { name: "oracle", baseUrl: oracleUrl, fetch: (req) => fetch(req) }
    : mockTarget()
  credentials = await provisionProject(target, "Transaction regression")
})

describe("transaction atomicity (#354)", () => {
  test("an invalid create rolls back earlier writes and history when the feature is enabled", async () => {
    await enableTransactions()
    const created = await request("POST", "fhir/R4/Slot", {
      resourceType: "Slot",
      status: "free",
      schedule: { reference: "Schedule/00000000-0000-4000-8000-000000000001" },
      start: "2026-01-01T10:00:00Z",
      end: "2026-01-01T11:00:00Z",
    })
    expect(created.status).toBe(201)
    const slot = created.body as Slot
    const result = await postBundle([
      {
        request: { method: "PUT", url: `Slot/${slot.id}`, ifMatch: `W/"${slot.meta?.versionId}"` },
        resource: { ...slot, status: "busy-unavailable" },
      },
      {
        request: { method: "POST", url: "Appointment" },
        resource: { resourceType: "Appointment" } as Resource,
      },
    ])
    expect(result.status).toBe(400)
    expect(result.body.resourceType).toBe("OperationOutcome")
    expect((await request("GET", `fhir/R4/Slot/${slot.id}`)).body).toEqual(slot)
    expect((await request("GET", `fhir/R4/Slot/${slot.id}/_history`)).body.entry).toHaveLength(1)
    expect((await request("GET", "fhir/R4/Appointment")).body.entry ?? []).toHaveLength(0)
  })

  test("without the feature flag, transaction entries commit independently like batch entries", async () => {
    const result = await postBundle([
      {
        request: { method: "POST", url: "Patient" },
        resource: { resourceType: "Patient", active: true },
      },
      {
        request: { method: "POST", url: "Appointment" },
        resource: { resourceType: "Appointment" } as Resource,
      },
    ])
    expect(result.status).toBe(200)
    expect(
      result.body.entry.map((e: { response: { status: string } }) => e.response.status),
    ).toEqual(["201", "400"])
    expect((await request("GET", "fhir/R4/Patient")).body.entry).toHaveLength(1)
  })

  test("competing version guards commit exactly one booking, preserving the winner on rollback", async () => {
    await enableTransactions()
    const patient = (await request("POST", "fhir/R4/Patient", { resourceType: "Patient" })).body
    const slot = (
      await request("POST", "fhir/R4/Slot", {
        resourceType: "Slot",
        status: "free",
        schedule: { reference: "Schedule/00000000-0000-4000-8000-000000000001" },
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T11:00:00Z",
      })
    ).body
    const entry: Bundle["entry"] = [
      {
        request: { method: "PUT", url: `Slot/${slot.id}`, ifMatch: `W/"${slot.meta.versionId}"` },
        resource: { ...slot, status: "busy-unavailable" } as Resource,
      },
      {
        request: { method: "POST", url: "Appointment" },
        resource: {
          resourceType: "Appointment",
          status: "booked",
          start: "2026-01-01T10:00:00Z",
          end: "2026-01-01T11:00:00Z",
          participant: [{ actor: { reference: `Patient/${patient.id}` }, status: "accepted" }],
        },
      },
    ]
    const results = await Promise.all(Array.from({ length: 6 }, () => postBundle(entry)))
    expect(results.map((r) => r.status).sort()).toEqual([200, 412, 412, 412, 412, 412])
    expect(results.find((r) => r.status === 412)?.body.resourceType).toBe("OperationOutcome")
    expect((await request("GET", `fhir/R4/Slot/${slot.id}`)).body.status).toBe("busy-unavailable")
    expect((await request("GET", "fhir/R4/Appointment")).body.entry).toHaveLength(1)
    expect((await request("GET", `fhir/R4/Slot/${slot.id}/_history`)).body.entry).toHaveLength(2)
  })
  test("a failed transaction cannot erase a concurrent successful request", async () => {
    await enableTransactions()
    const [failed, created] = await Promise.all([
      postBundle([
        ...Array.from({ length: 12 }, () => ({
          request: { method: "POST" as const, url: "Patient" },
          resource: { resourceType: "Patient" as const, active: false },
        })),
        {
          request: { method: "POST", url: "Observation" },
          resource: { resourceType: "Observation" } as Resource,
        },
      ]),
      postBundle([
        {
          request: { method: "POST", url: "Patient" },
          resource: { resourceType: "Patient", active: true },
        },
      ]),
    ])
    expect(failed.status).toBe(400)
    expect(created.status).toBe(200)
    const patient = created.body.entry[0].resource
    expect((await request("GET", `fhir/R4/Patient/${patient.id}`)).body).toEqual(patient)
    expect((await request("GET", "fhir/R4/Patient")).body.entry).toHaveLength(1)
  })
})
