import type { CognitoAppClient, CognitoSeedUser, CognitoUser } from "./state.js"

export type CognitoFixtures = {
  users: readonly CognitoSeedUser[]
  appClients?: readonly CognitoAppClient[]
}
const identityFields = new Set([
  "userId",
  "providerName",
  "providerType",
  "issuer",
  "primary",
  "dateCreated",
  "ProviderName",
  "ProviderAttributeName",
  "ProviderAttributeValue",
])
const userFields = new Set([
  "username",
  "password",
  "sub",
  "attributes",
  "confirmed",
  "enabled",
  "status",
  "createdAt",
  "groups",
  "identities",
  "confirmationCode",
  "resetCode",
])
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}
const string = (value: unknown, path: string) => {
  if (typeof value !== "string" || !value.length || value.length > 4096)
    fail(path, "expected a nonempty string of at most 4096 characters")
}

/** Strict, value-free diagnostics: synthetic passwords never become startup error text. */
export function validateCognitoFixtures(value: unknown): CognitoFixtures {
  if (!record(value)) fail("fixtures", "expected an object")
  for (const key of Object.keys(value))
    if (key !== "users" && key !== "appClients") fail(`fixtures.${key}`, "unknown field")
  if (value.appClients !== undefined) {
    if (!Array.isArray(value.appClients)) fail("fixtures.appClients", "expected an array")
    const ids = new Set<string>()
    for (const [i, client] of (value.appClients as unknown[]).entries()) {
      const { clientId } = validateAppClient(client, `fixtures.appClients[${i}]`)
      if (ids.has(clientId)) fail(`fixtures.appClients[${i}].clientId`, "duplicate clientId")
      ids.add(clientId)
    }
  }
  if (!Array.isArray(value.users)) fail("fixtures.users", "expected an array")
  const usernames = new Set<string>()
  const subjects = new Set<string>()
  const aliases = new Set<string>()
  const identities = new Set<string>()
  const users = value.users as unknown[]
  for (const [i, user] of users.entries()) {
    const path = `fixtures.users[${i}]`
    if (!record(user)) fail(path, "expected a user object")
    for (const key of Object.keys(user))
      if (!userFields.has(key)) fail(`${path}.${key}`, "unknown field")
    for (const key of ["username", "password"]) string(user[key], `${path}.${key}`)
    if (usernames.has(user.username as string)) fail(`${path}.username`, "duplicate username")
    usernames.add(user.username as string)
    for (const key of ["sub", "status", "confirmationCode", "resetCode"])
      if (user[key] !== undefined) string(user[key], `${path}.${key}`)
    if (user.sub !== undefined) {
      if (subjects.has(user.sub as string)) fail(`${path}.sub`, "duplicate subject")
      subjects.add(user.sub as string)
    }
    for (const key of ["confirmed", "enabled"])
      if (user[key] !== undefined && typeof user[key] !== "boolean")
        fail(`${path}.${key}`, "expected a boolean")
    if (
      user.createdAt !== undefined &&
      (typeof user.createdAt !== "number" || !Number.isFinite(user.createdAt) || user.createdAt < 0)
    )
      fail(`${path}.createdAt`, "expected a nonnegative finite timestamp")
    for (const key of ["attributes", "groups", "identities"])
      if (user[key] !== undefined && !Array.isArray(user[key]))
        fail(`${path}.${key}`, "expected an array")
    for (const [j, group] of ((user.groups ?? []) as unknown[]).entries())
      string(group, `${path}.groups[${j}]`)
    const names = new Set<string>()
    for (const [j, attribute] of ((user.attributes ?? []) as unknown[]).entries()) {
      const field = `${path}.attributes[${j}]`
      if (!record(attribute)) fail(field, "expected an attribute object")
      for (const key of Object.keys(attribute))
        if (!["Name", "Value"].includes(key)) fail(`${field}.${key}`, "unknown field")
      string(attribute.Name, `${field}.Name`)
      if (attribute.Value !== undefined && typeof attribute.Value !== "string")
        fail(`${field}.Value`, "expected a string")
      if (names.has(attribute.Name as string)) fail(`${field}.Name`, "duplicate attribute")
      names.add(attribute.Name as string)
      if (attribute.Name === "sub" && attribute.Value !== user.sub)
        fail(`${field}.Value`, "subject conflicts with sub")
      if (attribute.Name === "email" && typeof attribute.Value === "string") {
        if (aliases.has(attribute.Value)) fail(`${field}.Value`, "duplicate email alias")
        aliases.add(attribute.Value)
      }
    }
    for (const [j, identity] of ((user.identities ?? []) as unknown[]).entries()) {
      const field = `${path}.identities[${j}]`
      if (!record(identity)) fail(field, "expected an identity object")
      if (!Object.keys(identity).length) fail(field, "expected an identity relationship")
      for (const [key, entry] of Object.entries(identity)) {
        if (!identityFields.has(key)) fail(`${field}.${key}`, "unknown identity field")
        if (typeof entry !== "string" && !(key === "issuer" && entry === null))
          fail(`${field}.${key}`, "expected a string (issuer also accepts null)")
      }
      const provider = identity.providerName ?? identity.ProviderName
      const subject = identity.userId ?? identity.ProviderAttributeValue
      if (typeof provider !== "string" || typeof subject !== "string" || !provider || !subject)
        fail(field, "provider and subject are required for an identity relationship")
      const identityId = JSON.stringify([provider, subject])
      if (identities.has(identityId)) fail(field, "duplicate or conflicting provider identity")
      identities.add(identityId)
    }
  }
  // A username resolves before email aliases, so collisions across users would make fixtures ambiguous.
  for (const [i, user] of (users as CognitoSeedUser[]).entries())
    for (const [j, attribute] of (user.attributes ?? []).entries())
      if (
        attribute.Name === "email" &&
        attribute.Value !== user.username &&
        usernames.has(attribute.Value ?? "")
      )
        fail(
          `fixtures.users[${i}].attributes[${j}].Value`,
          "email alias conflicts with another username",
        )
  return structuredClone(value) as CognitoFixtures
}

const appClientFields = new Set([
  "clientId",
  "clientSecret",
  "callbackUrls",
  "identityProviders",
  "scopes",
  "preventUserExistenceErrors",
])
/** A hosted-UI app client; callback URLs must be absolute and fragment-free, as in Cognito. */
export function validateAppClient(value: unknown, path: string): CognitoAppClient {
  if (!record(value)) fail(path, "expected an app client object")
  for (const key of Object.keys(value))
    if (!appClientFields.has(key)) fail(`${path}.${key}`, "unknown field")
  string(value.clientId, `${path}.clientId`)
  if (value.clientSecret !== undefined) string(value.clientSecret, `${path}.clientSecret`)
  if (!Array.isArray(value.callbackUrls)) fail(`${path}.callbackUrls`, "expected an array")
  for (const [i, url] of (value.callbackUrls as unknown[]).entries()) {
    string(url, `${path}.callbackUrls[${i}]`)
    let parsed: URL | undefined
    try {
      parsed = new URL(url as string)
    } catch {}
    if (!parsed || parsed.hash)
      fail(`${path}.callbackUrls[${i}]`, "expected an absolute URL without a fragment")
  }
  for (const key of ["identityProviders", "scopes"]) {
    if (value[key] === undefined) continue
    if (!Array.isArray(value[key])) fail(`${path}.${key}`, "expected an array")
    for (const [i, entry] of (value[key] as unknown[]).entries())
      string(entry, `${path}.${key}[${i}]`)
  }
  if (
    value.preventUserExistenceErrors !== undefined &&
    typeof value.preventUserExistenceErrors !== "boolean"
  )
    fail(`${path}.preventUserExistenceErrors`, "expected a boolean")
  return structuredClone(value) as CognitoAppClient
}
/** App-client admin responses never include the secret. */
export const redactedAppClient = ({ clientSecret, ...client }: CognitoAppClient) => ({
  ...client,
  hasSecret: clientSecret !== undefined,
})

/** Shared allowlist for user-control responses; codes have their dedicated endpoint. */
export const redactedUser = (user: CognitoUser) => ({
  username: user.username,
  sub: user.sub,
  attributes: user.attributes.map(({ Name, Value }) => ({
    Name,
    ...(Value !== undefined ? { Value } : {}),
  })),
  confirmed: user.confirmed,
  enabled: user.enabled,
  status: user.status,
  groups: user.groups.filter((value) => typeof value === "string"),
  identities: user.identities.map((identity) =>
    Object.fromEntries(
      Object.entries(identity).filter(
        ([key, value]) =>
          identityFields.has(key) &&
          (typeof value === "string" || (key === "issuer" && value === null)),
      ),
    ),
  ),
})
