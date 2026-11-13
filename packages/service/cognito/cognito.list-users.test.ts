import { describe, expect, test } from "bun:test"
import { createRuntime } from "./src/runtime.js"

// ListUsers filters server-side and returns only the requested attributes (#743), as the API
// reference describes: https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ListUsers.html
// Best guess from the docs, not oracle-verified.
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const users = [
  {
    username: "ada",
    password: "Synthetic1",
    sub: "00000000-0000-4000-8000-00000000000a",
    confirmed: true,
    attributes: [
      { Name: "email", Value: "ada@example.test" },
      { Name: "email_verified", Value: "true" },
      { Name: "name", Value: "Ada" },
    ],
  },
  {
    username: "adele",
    password: "Synthetic1",
    attributes: [{ Name: "email", Value: "adele@example.test" }],
  },
  {
    username: "grace",
    password: "Synthetic1",
    confirmed: true,
    attributes: [{ Name: "email", Value: "grace@example.test" }],
  },
]
type Runtime = ReturnType<typeof createRuntime>
const setup = () => createRuntime({ poolId, clientId, users })
const listUsers = async (runtime: Runtime, body: Record<string, unknown>) => {
  const response = await runtime.fetch(
    new Request("http://cognito.test/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.ListUsers",
        authorization: "AWS4-HMAC-SHA256 Credential=fixture/x",
      },
      body: JSON.stringify({ UserPoolId: poolId, ...body }),
    }),
  )
  return { status: response.status, body: await response.json() }
}
const usernames = (body: { Users: { Username: string }[] }) =>
  body.Users.map((user) => user.Username)

describe("ListUsers Filter, AttributesToGet, Limit and PaginationToken (#743)", () => {
  test("an exact email filter returns only that user", async () => {
    const result = await listUsers(setup(), { Filter: 'email = "ada@example.test"' })
    expect(result.status).toBe(200)
    expect(usernames(result.body)).toEqual(["ada"])
  })

  test("a starts-with filter returns every user whose attribute has the prefix", async () => {
    const result = await listUsers(setup(), { Filter: 'email ^= "ad"' })
    expect(usernames(result.body)).toEqual(["ada", "adele"])
  })

  test("cognito:user_status filters by status", async () => {
    const result = await listUsers(setup(), { Filter: 'cognito:user_status = "UNCONFIRMED"' })
    expect(usernames(result.body)).toEqual(["adele"])
  })

  test("sub filters by the user's subject", async () => {
    const result = await listUsers(setup(), {
      Filter: 'sub = "00000000-0000-4000-8000-00000000000a"',
    })
    expect(usernames(result.body)).toEqual(["ada"])
    expect((await listUsers(setup(), { Filter: 'sub = "x"' })).body.Users).toEqual([])
  })

  test("an unsearchable attribute or a malformed filter is InvalidParameterException", async () => {
    for (const Filter of ['bogus = "x"', "email = ada", 'email != "x"']) {
      const result = await listUsers(setup(), { Filter })
      expect(result.status).toBe(400)
      expect(result.body.__type).toBe("InvalidParameterException")
    }
  })

  test("AttributesToGet returns only the named attributes", async () => {
    const result = await listUsers(setup(), {
      Filter: 'username = "ada"',
      AttributesToGet: ["email"],
    })
    expect(result.body.Users[0].Attributes).toEqual([{ Name: "email", Value: "ada@example.test" }])
    const none = await listUsers(setup(), { Filter: 'username = "ada"', AttributesToGet: [] })
    expect(none.body.Users[0].Attributes).toEqual([])
  })

  test("Limit above 60 is InvalidParameterException", async () => {
    const result = await listUsers(setup(), { Limit: 61 })
    expect(result.status).toBe(400)
    expect(result.body.__type).toBe("InvalidParameterException")
  })

  test("a garbage PaginationToken is InvalidParameterException; real tokens page the filter", async () => {
    const garbage = await listUsers(setup(), { PaginationToken: "not-a-token" })
    expect(garbage.status).toBe(400)
    expect(garbage.body.__type).toBe("InvalidParameterException")
    const runtime = setup()
    const first = await listUsers(runtime, { Filter: 'email ^= "ad"', Limit: 1 })
    expect(usernames(first.body)).toEqual(["ada"])
    const second = await listUsers(runtime, {
      Filter: 'email ^= "ad"',
      Limit: 1,
      PaginationToken: first.body.PaginationToken,
    })
    expect(usernames(second.body)).toEqual(["adele"])
    expect(second.body.PaginationToken).toBeUndefined()
  })
})
