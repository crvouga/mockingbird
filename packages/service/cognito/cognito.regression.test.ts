import { describe, expect, test } from "bun:test"
import { createPublicKey, type JsonWebKey as NodeJsonWebKey, verify } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime } from "./src/runtime.js"
import { serveTarget } from "./src/server.js"

const origin = "http://cognito.test"
const poolId = "us-east-1_fixture"
const clientId = "fixture-client"
const user = { username: "fixture@example.test", password: "Synthetic1", confirmed: true }
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString())
const request = (path: string, body?: unknown, headers = {}) =>
  new Request(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const auth = async (runtime: ReturnType<typeof createRuntime>, prefix = "", headers = {}) => {
  const response = await runtime.fetch(
    request(
      `${prefix}/`,
      {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: user.username, PASSWORD: user.password },
      },
      { "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth", ...headers },
    ),
  )
  expect(response.status).toBe(200)
  return (await response.json()).AuthenticationResult.IdToken as string
}
const publicKeys = async (runtime: ReturnType<typeof createRuntime>, prefix = "") =>
  (await (await runtime.fetch(request(`${prefix}/${poolId}/.well-known/jwks.json`))).json()).keys
const validates = (token: string, keys: (NodeJsonWebKey & { kid: string })[]) => {
  const [header, payload, signature] = token.split(".") as [string, string, string]
  const matches = keys.filter((key) => key.kid === decode(header).kid)
  return (
    matches.length === 1 &&
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: matches[0] as NodeJsonWebKey, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    )
  )
}

describe("Cognito namespace identity and portable signing state", () => {
  test("path and header discovery identify the same isolated issuer and verify all token claims", async () => {
    const runtime = createRuntime({ users: [user], poolId, clientId })
    for (const carrier of ["path", "header"]) {
      const prefix = carrier === "path" ? "/__admin/ns/beta" : ""
      const headers = carrier === "header" ? { "x-mockingbird-namespace": "beta" } : {}
      const token = await auth(runtime, prefix, headers)
      const claims = decode(token.split(".")[1] as string)
      const discovery = await (
        await runtime.fetch(
          request(`${prefix}/${poolId}/.well-known/openid-configuration`, undefined, headers),
        )
      ).json()
      expect(discovery.issuer).toBe(`${origin}/__admin/ns/beta/${poolId}`)
      expect(claims).toMatchObject({ iss: discovery.issuer, aud: clientId, token_use: "id" })
      const keys = (await (await runtime.fetch(new Request(discovery.jwks_uri))).json()).keys
      expect(validates(token, keys)).toBe(true)
      expect(validates(token, await publicKeys(runtime))).toBe(false)
    }
  })

  test("frozen-time rotations have unique kids and retain two prior keys without moving time", async () => {
    const runtime = createRuntime({
      users: [user],
      poolId,
      clientId,
      adminControls: { clock: { now: Date.parse("2030-01-01T00:00:00Z"), frozen: true } },
    })
    const before = runtime.namespaceClock().now()
    expect(before).toBe(Date.parse("2030-01-01T00:00:00Z"))
    const tokens = [await auth(runtime)]
    for (let i = 0; i < 2; i++) {
      await runtime.fetch(request("/__admin/keys/rotate", { retainPrevious: true }))
      tokens.push(await auth(runtime))
    }
    const keys = await publicKeys(runtime)
    expect(keys).toHaveLength(3)
    expect(new Set(keys.map((key: { kid: string }) => key.kid)).size).toBe(3)
    for (const token of tokens) expect(validates(token, keys)).toBe(true)
    expect(runtime.namespaceClock().now()).toBe(before)
  })

  test("portable restore replaces signing rings and user changes, then rotates and resets independently", async () => {
    const runtime = createRuntime({ users: [user], poolId, clientId })
    const token = await auth(runtime, "/__admin/ns/beta")
    await runtime.fetch(request("/__admin/ns/beta/__admin/keys/rotate", { retainPrevious: true }))
    const newer = await auth(runtime, "/__admin/ns/beta")
    const keys = await publicKeys(runtime, "/__admin/ns/beta")
    const archive = runtime.fleetExport(runtime.fleetSnapshot("beta"))
    await runtime.fetch(request("/__admin/ns/beta/__admin/keys/rotate", { retainPrevious: false }))
    const replacement = createRuntime({ users: [user], poolId, clientId })
    await auth(replacement, "/__admin/ns/beta")
    replacement.fleetRestore(replacement.fleetImport("beta", archive), "beta")
    expect(await publicKeys(replacement, "/__admin/ns/beta")).toEqual(keys)
    for (const t of [token, newer]) expect(validates(t, keys)).toBe(true)
    await replacement.fetch(
      request("/__admin/ns/beta/__admin/keys/rotate", { retainPrevious: true }),
    )
    const rotated = await publicKeys(replacement, "/__admin/ns/beta")
    expect(rotated).toHaveLength(3)
    expect(validates(newer, rotated)).toBe(true)
    expect(validates(newer, await publicKeys(replacement))).toBe(false)
    await replacement.reset("beta")
    expect(validates(newer, await publicKeys(replacement, "/__admin/ns/beta"))).toBe(false)
  })

  test("admin POST and GET users redact credentials, codes and unknown nested identity fields", async () => {
    const runtime = createRuntime({ poolId, clientId, adminKey: "fixture-admin" })
    const headers = { "x-mockingbird-admin-key": "fixture-admin" }
    const created = await runtime.fetch(
      request(
        "/__admin/users",
        {
          ...user,
          confirmationCode: "111111",
          resetCode: "222222",
          identities: [
            {
              providerName: "Google",
              userId: "fixture-id",
              password: "nested-secret",
              session: { token: "secret" },
            },
          ],
        },
        headers,
      ),
    )
    expect(created.status).toBe(201)
    const posted = await created.json()
    const listed = await (await runtime.fetch(request("/__admin/users", undefined, headers))).json()
    for (const body of [posted, listed]) {
      const encoded = JSON.stringify(body)
      for (const secret of [user.password, "111111", "222222", "nested-secret", "secret"])
        expect(encoded).not.toContain(secret)
    }
    expect(posted.identities).toEqual([{ providerName: "Google", userId: "fixture-id" }])
    expect(
      await (
        await runtime.fetch(
          request(
            `/__admin/codes?username=${encodeURIComponent(user.username)}`,
            undefined,
            headers,
          ),
        )
      ).json(),
    ).toMatchObject({ confirmationCode: "111111", resetCode: "222222" })
    const token = await auth(runtime)
    expect(decode(token.split(".")[1] as string).identities).toEqual([
      { providerName: "Google", userId: "fixture-id" },
    ])
  })
})

describe("Cognito fleet fixtures", () => {
  test("inline and explicit fixture files seed groups, identity, sub and reset baseline independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cognito-fixtures-"))
    const fixtures = {
      users: [
        {
          ...user,
          sub: "synthetic-sub",
          groups: ["testers"],
          attributes: [{ Name: "email", Value: user.username }],
          identities: [{ providerName: "Google", userId: "synthetic-provider-user" }],
        },
      ],
    }
    const file = join(directory, "fixtures.json")
    await writeFile(file, JSON.stringify(fixtures))
    try {
      for (const [values, common] of [
        [{}, { fixtures }],
        [{ fixtures: file }, {}],
      ] as const) {
        const runtime = (await serveTarget.create(
          { "pool-id": poolId, "client-id": clientId, ...values },
          { adminKey: undefined, seed: undefined, onLog: undefined, ...common },
        )) as ReturnType<typeof createRuntime>
        const token = await auth(runtime)
        expect(decode(token.split(".")[1] as string)).toMatchObject({
          sub: "synthetic-sub",
          "cognito:groups": ["testers"],
          identities: fixtures.users[0]?.identities,
        })
        runtime.instance("beta").state.users.delete(user.username)
        expect(runtime.instance().state.find(user.username)).toBeDefined()
        const document = runtime.fleetExport(runtime.fleetSnapshot("beta"))
        await runtime.reset("beta")
        expect(runtime.instance("beta").state.find(user.username)).toBeDefined()
        runtime.fleetRestore(runtime.fleetImport("beta", document), "beta")
        expect(runtime.instance("beta").state.find(user.username)).toBeUndefined()
      }
      await writeFile(file, '{"users":')
      await expect(
        serveTarget.create(
          { fixtures: file },
          { adminKey: undefined, seed: undefined, onLog: undefined },
        ),
      ).rejects.toThrow("Cannot read --fixtures")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("invalid field paths and conflicting aliases fail before a runtime is returned without revealing values", async () => {
    const cases = [
      [{ users: [{ username: user.username }] }, "fixtures.users[0].password"],
      [{ users: [{ ...user, confirmed: "yes" }] }, "fixtures.users[0].confirmed"],
      [{ users: [user, user] }, "fixtures.users[1].username"],
      [
        {
          users: [
            { ...user, sub: "same" },
            { ...user, username: "other@example.test", sub: "same" },
          ],
        },
        "fixtures.users[1].sub",
      ],
      [
        {
          users: [
            user,
            {
              ...user,
              username: "other@example.test",
              attributes: [{ Name: "email", Value: user.username }],
            },
          ],
        },
        "fixtures.users[1].attributes[0].Value",
      ],
      [{ users: [{ ...user, groups: [42] }] }, "fixtures.users[0].groups[0]"],
      [
        { users: [{ ...user, identities: [{ password: "never-show-this" }] }] },
        "fixtures.users[0].identities[0].password",
      ],
      [
        {
          users: [
            { ...user, identities: [{ providerName: "Google", userId: "same" }] },
            {
              ...user,
              username: "other@example.test",
              identities: [{ providerName: "Google", userId: "same" }],
            },
          ],
        },
        "fixtures.users[1].identities[0]",
      ],
    ] as const
    for (const [fixtures, path] of cases) {
      await expect(
        serveTarget.create(
          {},
          { fixtures, adminKey: undefined, seed: undefined, onLog: undefined },
        ),
      ).rejects.toThrow(path)
    }
  })
})
