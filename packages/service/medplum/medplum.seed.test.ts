/** Declarative seeding: `resources`, and user fixtures that pin their profile id and fields. */
import { describe, expect, test } from "bun:test"
import type { Patient, Practitioner, Resource } from "@medplum/fhirtypes"
import { createRuntime, DEFAULT_PROJECT_ID, MedplumAPI } from "./src/index.js"

const BASE = "http://localhost:8103/"
const PRACTITIONER_ID = "0c0f2f6e-8f3d-4c5c-a0a1-0d9d6f6f0101"
const PATIENT_ID = "0c0f2f6e-8f3d-4c5c-a0a1-0d9d6f6f0102"
const ORG_ID = "0c0f2f6e-8f3d-4c5c-a0a1-0d9d6f6f0103"
const EXTENSION = {
  url: "https://example.test/StructureDefinition/staff-number",
  valueString: "S-17",
}

describe("user fixtures", () => {
  test("a pinned profileId and profile fields land on the profile resource", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { profile, membership } = await api.addUser({
      email: "dr@example.org",
      password: "long-password",
      firstName: "Ada",
      lastName: "Lovelace",
      profileId: PRACTITIONER_ID,
      profile: { extension: [EXTENSION], gender: "female" },
    })
    expect(profile.id).toBe(PRACTITIONER_ID)
    expect(membership.profile?.reference).toBe(`Practitioner/${PRACTITIONER_ID}`)
    const [stored] = await api.resources<Practitioner>("Practitioner")
    const found = (await api.resources<Practitioner>("Practitioner")).find(
      (p) => p.id === PRACTITIONER_ID,
    )
    expect(stored).toBeDefined()
    expect(found).toMatchObject({
      gender: "female",
      extension: [EXTENSION],
      name: [{ given: ["Ada"], family: "Lovelace" }],
      meta: { project: DEFAULT_PROJECT_ID },
    })
  })

  test("without them the profile is generated as before", async () => {
    const api = new MedplumAPI({ baseUrl: BASE })
    const { profile } = await api.addUser({ email: "dr@example.org", password: "long-password" })
    expect(profile.id).not.toBe(PRACTITIONER_ID)
    expect(profile).toMatchObject({
      resourceType: "Practitioner",
      name: [{ given: ["Mock"], family: "User" }],
    })
  })

  test("a Patient fixture takes Patient fields, and the profile is the sign-in profile", async () => {
    const api = new MedplumAPI({
      baseUrl: BASE,
      project: {
        users: [
          {
            email: "pat@example.org",
            password: "long-password",
            profileType: "Patient",
            profileId: PATIENT_ID,
            profile: { birthDate: "1990-02-03" } as Partial<Patient>,
          },
        ],
      },
    })
    await api.ready()
    const patient = (await api.resources<Patient>("Patient")).find((p) => p.id === PATIENT_ID)
    expect(patient).toMatchObject({ birthDate: "1990-02-03" })
    const login = await api.fetch(
      new Request(`${BASE}auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "pat@example.org",
          password: "long-password",
          projectId: DEFAULT_PROJECT_ID,
          scope: "openid",
        }),
      }),
    )
    expect(login.status).toBe(200)
  })

  test("POST /__admin/medplum/users accepts them", async () => {
    const runtime = createRuntime()
    const response = await runtime.fetch(
      new Request(`${BASE}__admin/medplum/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "dr@example.org",
          password: "long-password",
          profileId: PRACTITIONER_ID,
          profile: { extension: [EXTENSION] },
        }),
      }),
    )
    expect(response.status).toBe(201)
    expect(((await response.json()) as { profile: Practitioner }).profile).toMatchObject({
      id: PRACTITIONER_ID,
      extension: [EXTENSION],
    })
  })
})

describe("resources", () => {
  const resources: Resource[] = [
    { resourceType: "Organization", id: ORG_ID, name: "Acme Clinic" },
    {
      resourceType: "Patient",
      id: PATIENT_ID,
      name: [{ family: "Seed" }],
      managingOrganization: { reference: `Organization/${ORG_ID}` },
    },
  ]

  test("are present on the first request with their ids, in the default project", async () => {
    const runtime = createRuntime({ resources: [...resources] })
    const token = await runtime.instance().accessToken()
    const response = await runtime.fetch(
      new Request(`${BASE}fhir/R4/Patient/${PATIENT_ID}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    expect(response.status).toBe(200)
    const stored = (await runtime.instance().resources("Patient")).find((p) => p.id === PATIENT_ID)
    expect(stored?.meta?.project).toBe(DEFAULT_PROJECT_ID)
    expect(await response.json()).toMatchObject({
      id: PATIENT_ID,
      managingOrganization: { reference: `Organization/${ORG_ID}` },
    })
  })

  test("come after the users, so they may reference the pinned profiles", async () => {
    const api = new MedplumAPI({
      baseUrl: BASE,
      project: {
        users: [{ email: "dr@example.org", password: "long-password", profileId: PRACTITIONER_ID }],
      },
      resources: [
        {
          resourceType: "Task",
          id: ORG_ID,
          status: "requested",
          intent: "order",
          owner: { reference: `Practitioner/${PRACTITIONER_ID}` },
        },
      ],
    })
    expect(await api.resources("Task")).toHaveLength(1)
    expect(
      (await api.resources<Practitioner>("Practitioner")).some((p) => p.id === PRACTITIONER_ID),
    ).toBe(true)
  })

  test("survive reset()", async () => {
    const api = new MedplumAPI({ baseUrl: BASE, resources: [...resources] })
    await api.ready()
    await api.reset()
    expect((await api.resources("Patient")).map((p) => p.id)).toEqual([PATIENT_ID])
  })

  test("an invalid seed resource fails loudly instead of being skipped", async () => {
    const api = new MedplumAPI({
      baseUrl: BASE,
      resources: [{ resourceType: "Patient", id: "not-a-uuid" }],
    })
    await expect(api.ready()).rejects.toThrow()
  })
})
