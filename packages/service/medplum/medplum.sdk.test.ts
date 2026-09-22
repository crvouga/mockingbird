/**
 * Drop-in: Medplum's own SDK (`MedplumClient` from `@medplum/core`) pointed at the mock, the
 * way a consumer backend or app uses it — client-credentials and password (PKCE) sign-in, CRUD,
 * the search helpers, conditional writes, patch, batch, GraphQL, attachments and the admin API.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { getReferenceString, MedplumClient, OperationOutcomeError } from "@medplum/core"
import type {
  Bundle,
  Observation,
  Patient,
  Practitioner,
  ProjectMembership,
} from "@medplum/fhirtypes"
import {
  createRuntime,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  DEFAULT_PROJECT_ID,
  MedplumAPI,
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_PASSWORD,
} from "./src/index.js"

const BASE = "http://localhost:8103/"

let api: MedplumAPI
let medplum: MedplumClient

const clientFor = (target: { fetch: (request: Request) => Promise<Response> }, options = {}) =>
  new MedplumClient({
    baseUrl: BASE,
    fetch: (url: string, init?: RequestInit) => target.fetch(new Request(url, init)),
    ...options,
  })

beforeEach(async () => {
  api = new MedplumAPI({ baseUrl: BASE })
  medplum = clientFor(api)
  await medplum.startClientLogin(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET)
})

describe("MedplumClient against the mock", () => {
  test("client-credentials sign-in resolves the client's profile and project", async () => {
    const profile = medplum.getProfile()
    expect(profile?.resourceType as string).toBe("ClientApplication")
    expect(profile?.id).toBe(DEFAULT_CLIENT_ID)
    expect(medplum.getProject()?.id).toBe(DEFAULT_PROJECT_ID)
    expect(medplum.isAuthenticated()).toBe(true)
  })

  test("createResource, readResource, updateResource, deleteResource", async () => {
    const created = await medplum.createResource<Patient>({
      resourceType: "Patient",
      name: [{ given: ["Ada"], family: "Lovelace" }],
    })
    expect(created.id).toBeString()
    expect(created.meta?.versionId).toBeString()
    const read = await medplum.readResource("Patient", created.id as string)
    expect(read).toEqual(created)
    const updated = await medplum.updateResource<Patient>({ ...read, gender: "female" })
    expect(updated.gender).toBe("female")
    expect(updated.meta?.versionId).not.toBe(created.meta?.versionId)
    await medplum.deleteResource("Patient", created.id as string)
    medplum.invalidateAll()
    const gone = await medplum.readResource("Patient", created.id as string).catch((error) => error)
    expect(gone).toBeInstanceOf(OperationOutcomeError)
    expect((gone as OperationOutcomeError).outcome.id).toBe("gone")
  })

  test("search helpers: searchResources, searchOne, search bundles and pages", async () => {
    for (const family of ["Turing", "Hopper", "Lovelace", "Babbage", "Knuth"]) {
      await medplum.createResource<Patient>({ resourceType: "Patient", name: [{ family }] })
    }
    const found = await medplum.searchResources("Patient", { name: "hop" })
    expect(found.map((p) => p.name?.[0]?.family)).toEqual(["Hopper"])
    expect((await medplum.searchOne("Patient", "name=turing"))?.name?.[0]?.family).toBe("Turing")
    const bundle = await medplum.search("Patient", {
      _total: "accurate",
      _sort: "family",
      _count: "2",
    })
    expect(bundle.total).toBe(5)
    expect(bundle.entry?.map((e) => (e.resource as Patient).name?.[0]?.family)).toEqual([
      "Babbage",
      "Hopper",
    ])
    const pages: string[][] = []
    for await (const page of medplum.searchResourcePages("Patient", {
      _sort: "family",
      _count: "2",
    })) {
      pages.push(page.map((p) => p.name?.[0]?.family as string))
    }
    expect(pages).toEqual([["Babbage", "Hopper"], ["Knuth", "Lovelace"], ["Turing"]])
  })

  test("conditional writes: createResourceIfNoneExist and upsertResource", async () => {
    const identifier = [{ system: "https://example.org/mrn", value: "MRN-42" }]
    const first = await medplum.createResourceIfNoneExist<Patient>(
      { resourceType: "Patient", identifier },
      "identifier=https://example.org/mrn|MRN-42",
    )
    const again = await medplum.createResourceIfNoneExist<Patient>(
      { resourceType: "Patient", identifier, active: true },
      "identifier=https://example.org/mrn|MRN-42",
    )
    expect(again.id).toBe(first.id)
    const upserted = await medplum.upsertResource<Patient>(
      { resourceType: "Patient", identifier, gender: "other" },
      "identifier=https://example.org/mrn|MRN-42",
    )
    expect(upserted.id).toBe(first.id)
    expect(upserted.gender).toBe("other")
    expect(await medplum.searchResources("Patient", "identifier=MRN-42")).toHaveLength(1)
  })

  test("patchResource with JSON Patch, and readHistory / readVersion", async () => {
    const created = await medplum.createResource<Patient>({
      resourceType: "Patient",
      gender: "female",
    })
    const patched = await medplum.patchResource("Patient", created.id as string, [
      { op: "replace", path: "/gender", value: "male" },
      { op: "add", path: "/active", value: true },
    ])
    expect(patched.gender).toBe("male")
    const history = await medplum.readHistory("Patient", created.id as string)
    expect(history.entry).toHaveLength(2)
    const first = await medplum.readVersion(
      "Patient",
      created.id as string,
      created.meta?.versionId as string,
    )
    expect(first.gender).toBe("female")
  })

  test("executeBatch runs a transaction with urn:uuid references", async () => {
    const result = (await medplum.executeBatch({
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        {
          fullUrl: "urn:uuid:4c5a6c55-0000-4000-8000-000000000001",
          request: { method: "POST", url: "Patient" },
          resource: { resourceType: "Patient", name: [{ family: "Batch" }] },
        },
        {
          request: { method: "POST", url: "Observation" },
          resource: {
            resourceType: "Observation",
            status: "final",
            code: { text: "heart rate" },
            subject: { reference: "urn:uuid:4c5a6c55-0000-4000-8000-000000000001" },
          },
        },
      ],
    })) as Bundle
    expect(result.type).toBe("transaction-response")
    const patient = result.entry?.[0]?.resource as Patient
    const observation = result.entry?.[1]?.resource as Observation
    expect(observation.subject?.reference).toBe(getReferenceString(patient))
    expect(
      await medplum.searchResources("Observation", { subject: getReferenceString(patient) }),
    ).toHaveLength(1)
  })

  test("graphql queries and mutations", async () => {
    const patient = await medplum.createResource<Patient>({
      resourceType: "Patient",
      name: [{ family: "Graph" }],
    })
    const result = await medplum.graphql(`{ PatientList(name: "graph") { id name { family } } }`)
    expect(result.data.PatientList).toEqual([{ id: patient.id, name: [{ family: "Graph" }] }])
  })

  test("createAttachment uploads a Binary the SDK can download", async () => {
    const attachment = await medplum.createAttachment({
      data: "hello attachment",
      contentType: "text/plain",
      filename: "hello.txt",
    })
    expect(attachment.url).toContain("/storage/")
    const blob = await medplum.download(attachment.url as string)
    expect(await blob.text()).toBe("hello attachment")
  })

  test("validation failures surface as OperationOutcomeError with the server's issues", async () => {
    const error = await medplum
      .createResource({ resourceType: "Observation" } as Observation)
      .catch((e) => e)
    expect(error).toBeInstanceOf(OperationOutcomeError)
    expect((error as OperationOutcomeError).outcome.issue?.map((i) => i.expression?.[0])).toEqual([
      "Observation.status",
      "Observation.code",
    ])
  })

  test("the project admin client invites a practitioner, who signs in with a password (PKCE)", async () => {
    const membership = (await medplum.invite(DEFAULT_PROJECT_ID, {
      resourceType: "Practitioner",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.org",
      password: "cobol-rules-1959",
      scope: "project",
      sendEmail: false,
    })) as ProjectMembership
    expect(membership.resourceType).toBe("ProjectMembership")

    const practitioner = clientFor(api)
    const login = await practitioner.startLogin({
      email: "grace@example.org",
      password: "cobol-rules-1959",
      projectId: DEFAULT_PROJECT_ID,
    } as never)
    expect(login.code).toBeString()
    const profile = (await practitioner.processCode(login.code as string)) as Practitioner
    expect(profile.resourceType).toBe("Practitioner")
    expect(profile.name?.[0]?.family).toBe("Hopper")
    const me = await practitioner.get("auth/me")
    expect(me.membership.id).toBe(membership.id)
  })

  test("the seeded super admin signs in with the server's default credentials", async () => {
    const admin = clientFor(api)
    const login = await admin.startLogin({
      email: SUPER_ADMIN_EMAIL,
      password: SUPER_ADMIN_PASSWORD,
    })
    const profile = await admin.processCode(login.code as string)
    expect(profile.resourceType).toBe("Practitioner")
    expect(admin.getProject()?.name).toBe("Super Admin")
  })

  test("through the runtime, a /ns/<name>/ base URL isolates a namespace", async () => {
    const runtime = createRuntime({ baseUrl: BASE })
    const one = new MedplumClient({
      baseUrl: "http://localhost:8103/ns/one/",
      fetch: (url: string, init?: RequestInit) => runtime.fetch(new Request(url, init)),
    })
    const two = new MedplumClient({
      baseUrl: "http://localhost:8103/ns/two/",
      fetch: (url: string, init?: RequestInit) => runtime.fetch(new Request(url, init)),
    })
    await one.startClientLogin(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET)
    await two.startClientLogin(DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET)
    await one.createResource<Patient>({ resourceType: "Patient", name: [{ family: "OnlyInOne" }] })
    expect(await one.searchResources("Patient", "name=onlyinone")).toHaveLength(1)
    expect(await two.searchResources("Patient", "name=onlyinone")).toHaveLength(0)
  })
})
