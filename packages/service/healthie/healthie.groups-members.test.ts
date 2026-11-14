import { describe, expect, test } from "bun:test"
import { createRuntime, SEED } from "./src/index.js"

/**
 * Issue #761: `userGroups(keywords)` and `organizationMembers(licensed_in_state)` with
 * `User.state_licenses`. Best guess from Healthie's 2024-06-01 schema reference, not
 * oracle-verified (see README "User groups and organization members").
 */

const HOST = "http://healthie.mock"
const ORG_KEY = "gh_sbox_org_api_key"

// biome-ignore lint/suspicious/noExplicitAny: GraphQL payloads are asserted field by field.
type Json = Record<string, any>

const setup = () => {
  const runtime = createRuntime()
  const gql = async (query: string, auth: string | null = ORG_KEY) =>
    (await (
      await runtime.fetch(
        new Request(`${HOST}/graphql`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          },
          body: JSON.stringify({ query }),
        }),
      )
    ).json()) as Json
  const admin = async (path: string, body?: unknown) => {
    const response = await runtime.fetch(
      new Request(`${HOST}/__admin${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: response.status, body: (await response.json()) as Json }
  }
  return { runtime, gql, admin }
}

describe("userGroups (issue #761, best guess from vendor docs)", () => {
  test("the reported document validates and keywords match group names case-insensitively", async () => {
    const { gql, admin } = setup()
    const weight = await admin("/user-groups", {
      name: "Weight Loss Cohort",
      user_ids: [SEED.patientId],
    })
    expect(weight.status).toBe(201)
    await admin("/user-groups", { name: "Sleep Program" })
    await admin("/user-groups", { name: "Weightlifting" })

    const reported = await gql(
      'query { userGroups(keywords: "x") { id name } organizationMembers(licensed_in_state: "AZ") { id state_licenses { state } } }',
    )
    expect(reported.errors).toBeUndefined()
    expect(reported.data.userGroups).toEqual([])

    const hits = await gql('{ userGroups(keywords: "WEIGHT") { id name } }')
    expect(hits.data.userGroups.map((g: Json) => g.name)).toEqual([
      "Weight Loss Cohort",
      "Weightlifting",
    ])
    // "Blank values are ignored."
    const blank = await gql('{ userGroups(keywords: "  ") { name } }')
    expect(blank.data.userGroups).toHaveLength(3)

    const detail = await gql(
      `{ userGroups(keywords: "cohort") { id name users_count user_ids users { id } created_at } }`,
    )
    expect(detail.data.userGroups).toEqual([
      {
        id: weight.body.id,
        name: "Weight Loss Cohort",
        users_count: 1,
        user_ids: [SEED.patientId],
        users: [{ id: SEED.patientId }],
        created_at: expect.any(String),
      },
    ])
    const member = await gql(
      `{ user(id: "${SEED.patientId}") { user_group_id user_group { name } } }`,
    )
    expect(member.data.user).toEqual({
      user_group_id: weight.body.id,
      user_group: { name: "Weight Loss Cohort" },
    })
  })

  test("pagination applies only when should_paginate is true; order_by sorts; patients and anonymous see none", async () => {
    const { gql, admin } = setup()
    for (const name of ["Charlie", "alpha", "Bravo"]) await admin("/user-groups", { name })
    const all = await gql("{ userGroups(offset: 1, page_size: 1) { name } }")
    expect(all.data.userGroups.map((g: Json) => g.name)).toEqual(["Charlie", "alpha", "Bravo"])
    const page = await gql(
      "{ userGroups(should_paginate: true, offset: 1, page_size: 1, order_by: NAME_ASC) { name } }",
    )
    expect(page.data.userGroups.map((g: Json) => g.name)).toEqual(["Bravo"])
    const desc = await gql('{ userGroups(sort_by: "name_desc") { name } }')
    expect(desc.data.userGroups.map((g: Json) => g.name)).toEqual(["Charlie", "Bravo", "alpha"])

    const patient = await admin("/users", { email: "p761@example.test", password: "pw" })
    expect((await gql("{ userGroups { id } }", patient.body.api_key)).data.userGroups).toEqual([])
    expect((await gql("{ userGroups { id } }", null)).data.userGroups).toEqual([])
  })

  test("admin validation: name required, unknown members 404", async () => {
    const { admin } = setup()
    expect((await admin("/user-groups", {})).status).toBe(400)
    expect((await admin("/user-groups", { name: "x", user_ids: ["999999"] })).status).toBe(404)
    await admin("/user-groups", { name: "Listed" })
    expect((await admin("/user-groups")).body.user_groups.map((g: Json) => g.name)).toEqual([
      "Listed",
    ])
  })
})

describe("organizationMembers and User.state_licenses (issue #761, best guess from vendor docs)", () => {
  test("licensed_in_state filters providers by a state license; patients are never members", async () => {
    const { gql, admin } = setup()
    const az = await admin("/users", {
      email: "az@example.test",
      password: "pw",
      role: "provider",
      first_name: "Avery",
      last_name: "Stone",
      state_licenses: ["AZ", "ca"],
    })
    expect(az.status).toBe(201)
    expect(az.body.user.state_licenses).toEqual([
      { id: expect.any(String), state: "AZ" },
      { id: expect.any(String), state: "CA" },
    ])
    const ny = await admin("/users", {
      email: "ny@example.test",
      password: "pw",
      role: "provider",
      first_name: "Noel",
      last_name: "York",
    })
    expect((await admin(`/users/${ny.body.user.id}/state-licenses`, { state: "NY" })).status).toBe(
      201,
    )
    // A patient holding a license is still not an organization member.
    await admin("/users", { email: "pt@example.test", password: "pw", state_licenses: ["AZ"] })

    const result = await gql(
      '{ organizationMembers(licensed_in_state: "az") { id state_licenses { state full_state_name } } }',
    )
    expect(result.errors).toBeUndefined()
    expect(result.data.organizationMembers).toEqual([
      {
        id: az.body.user.id,
        state_licenses: [
          { state: "AZ", full_state_name: "Arizona" },
          { state: "CA", full_state_name: "California" },
        ],
      },
    ])

    const everyone = await gql("{ organizationMembers(page_size: 100) { id is_patient } }")
    expect(everyone.data.organizationMembers.map((u: Json) => u.id)).toEqual([
      SEED.orgAdminId,
      SEED.dietitianId,
      az.body.user.id,
      ny.body.user.id,
    ])
    const named = await gql('{ organizationMembers(keywords: "york") { id } }')
    expect(named.data.organizationMembers).toEqual([{ id: ny.body.user.id }])
    const paged = await gql("{ organizationMembers(offset: 1, page_size: 2) { id } }")
    expect(paged.data.organizationMembers.map((u: Json) => u.id)).toEqual([
      SEED.dietitianId,
      az.body.user.id,
    ])
    const noLicense = await gql(`{ user(id: "${SEED.dietitianId}") { state_licenses { id } } }`)
    expect(noLicense.data.user.state_licenses).toEqual([])
  })

  test("patients and anonymous callers get no members; bad license input is a 400", async () => {
    const { gql, admin } = setup()
    const patient = await admin("/users", { email: "p@example.test", password: "pw" })
    expect(
      (await gql("{ organizationMembers { id } }", patient.body.api_key)).data.organizationMembers,
    ).toEqual([])
    expect((await gql("{ organizationMembers { id } }", null)).data.organizationMembers).toEqual([])
    expect(
      (
        await admin("/users", {
          email: "bad@example.test",
          password: "pw",
          state_licenses: ["Arizona"],
        })
      ).status,
    ).toBe(400)
    expect((await admin(`/users/${SEED.dietitianId}/state-licenses`, { state: "ZZ" })).status).toBe(
      400,
    )
    expect((await admin("/users/999999/state-licenses", { state: "AZ" })).status).toBe(404)
  })
})
