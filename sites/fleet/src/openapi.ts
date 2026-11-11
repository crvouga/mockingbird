/**
 * The API contract. Routes are declared once (see `api.ts`) with these schemas; the OpenAPI
 * document and request validation both come from that declaration, so they cannot disagree.
 */

export type Schema = {
  type?: "object" | "string" | "integer" | "boolean" | "array" | "null" | readonly string[]
  properties?: Record<string, Schema>
  required?: readonly string[]
  additionalProperties?: boolean | Schema
  items?: Schema
  enum?: readonly (string | null)[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  maxItems?: number
  maxProperties?: number
  format?: string
  description?: string
  example?: unknown
  $ref?: string
}

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` })
const timestamp: Schema = { type: "string", format: "date-time" }
/** The schema, or null. An enum must list null itself, or validators reject it. */
const nullable = (schema: Schema): Schema => ({
  ...schema,
  type: [schema.type as string, "null"],
  ...(schema.enum ? { enum: [...schema.enum, null] } : {}),
})
const slug: Schema = {
  type: "string",
  pattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$",
  description: "Lowercase letters, digits and hyphens; 1 to 40 characters.",
}
const name: Schema = { type: "string", minLength: 1, maxLength: 80 }
const object = (
  properties: Record<string, Schema>,
  required: readonly string[] = Object.keys(properties),
): Schema => ({ type: "object", properties, required, additionalProperties: false })
const list = (item: string): Schema => object({ data: { type: "array", items: ref(item) } })

const count: Schema = { type: "integer", minimum: 0 }
const LIMIT_NAMES = [
  "projectsPerOrg",
  "fleetsPerOrg",
  "emulatorsPerFleet",
  "membersPerOrg",
  "apiKeysPerOrg",
  "stateBytes",
  "requestsPerMonth",
  "fleetRequestsPerMinute",
] as const
const requestsPerMinute: Schema = {
  type: "integer",
  minimum: 1,
  maximum: 1_000_000,
  description: "Requests per minute this fleet accepts, at most the organization's ceiling.",
}

const role: Schema = { type: "string", enum: ["viewer", "member", "admin", "owner"] }
const durability: Schema = {
  type: "string",
  enum: ["strict", "buffered", "ephemeral"],
  description:
    "`strict`: each request is answered only after its state change is committed to object storage (slowest, loses nothing, safe across replicas). `buffered`: served from memory and written shortly after (fast; a crash loses up to the flush interval). `ephemeral`: memory only.",
}
const emulatorFields = {
  target: { type: "string", description: "Catalog name of the emulator, e.g. `stripe`." },
  durability,
  seed: { type: "string", maxLength: 200, description: "Seeds the emulator's random streams." },
  settings: {
    type: "object",
    additionalProperties: true,
    description: "The emulator's own boot settings, checked against its schema.",
  },
  flushIntervalMs: {
    type: "integer",
    minimum: 100,
    maximum: 60000,
    description: "`buffered` only: milliseconds from the first unsaved change to its write.",
  },
  webhookOrigins: {
    type: "array",
    maxItems: 20,
    items: { type: "string", maxLength: 300 },
    description:
      "HTTPS origins this emulator may deliver webhooks to. Deliveries are disabled when empty.",
  },
} satisfies Record<string, Schema>

export const SCHEMAS: Record<string, Schema> = {
  Error: object({
    error: object({ code: { type: "string" }, message: { type: "string" }, details: {} }, [
      "code",
      "message",
    ]),
  }),
  Config: object({
    publicUrl: { type: "string" },
    fleetUrl: { type: "string" },
    auth: object({
      oidc: { type: "boolean" },
      devLogin: { type: "boolean" },
      tokenLogin: { type: "boolean" },
    }),
    durability: { type: "array", items: durability },
  }),
  User: object({
    id: { type: "string" },
    email: nullable({ type: "string" }),
    name: nullable({ type: "string" }),
  }),
  Me: object(
    {
      kind: { type: "string", enum: ["user", "api_key"] },
      user: ref("User"),
      apiKey: ref("ApiKey"),
      orgs: { type: "array", items: ref("Org") },
    },
    ["kind", "orgs"],
  ),
  Org: object(
    {
      id: { type: "string" },
      slug,
      name,
      createdAt: timestamp,
      suspended: nullable({ type: "string" }),
      managed: {
        ...ref("Managed"),
        description:
          "Set when the organization is configured by a mockingbird.yaml: its projects, fleets and emulators can then be changed only by applying that file.",
      },
      role,
    },
    ["id", "slug", "name", "createdAt", "suspended", "managed"],
  ),
  OrgList: list("Org"),
  OrgCreate: object({ name, slug }, ["name"]),
  OrgUpdate: object({ name }),
  Member: object({
    userId: { type: "string" },
    email: nullable({ type: "string" }),
    name: nullable({ type: "string" }),
    role,
    joinedAt: timestamp,
  }),
  MemberList: list("Member"),
  MemberUpdate: object({ role }),
  Invite: object(
    {
      id: { type: "string" },
      email: { type: "string" },
      role,
      expiresAt: timestamp,
      createdAt: timestamp,
      token: { type: "string", description: "Returned once, when the invite is created." },
      acceptUrl: { type: "string", description: "Returned once, when the invite is created." },
    },
    ["id", "email", "role", "expiresAt", "createdAt"],
  ),
  InviteList: list("Invite"),
  InviteCreate: object(
    {
      email: { type: "string", minLength: 3, maxLength: 200, pattern: "^[^@\\s]+@[^@\\s]+$" },
      role: { type: "string", enum: ["viewer", "member", "admin"] },
    },
    ["email"],
  ),
  InviteAccept: object({ token: { type: "string", minLength: 10, maxLength: 200 } }),
  ApiKey: object(
    {
      id: { type: "string" },
      name,
      scope: { type: "string", enum: ["user", "org", "project"] },
      role: nullable(role),
      orgId: nullable({ type: "string" }),
      projectId: nullable({ type: "string" }),
      prefix: {
        type: "string",
        description: "The first characters of the key, to recognise it by.",
      },
      lastUsedAt: nullable(timestamp),
      expiresAt: nullable(timestamp),
      createdAt: timestamp,
      key: { type: "string", description: "The secret. Returned once, when the key is created." },
    },
    [
      "id",
      "name",
      "scope",
      "role",
      "orgId",
      "projectId",
      "prefix",
      "lastUsedAt",
      "expiresAt",
      "createdAt",
    ],
  ),
  ApiKeyList: list("ApiKey"),
  TokenCreate: object({ name, expiresInDays: { type: "integer", minimum: 1, maximum: 366 } }, [
    "name",
  ]),
  ApiKeyCreate: object(
    {
      name,
      role: { type: "string", enum: ["viewer", "member", "admin"] },
      projectId: { type: "string", description: "Restrict the key to one project." },
      expiresInDays: { type: "integer", minimum: 1, maximum: 366 },
    },
    ["name"],
  ),
  Project: object({
    id: { type: "string" },
    orgId: { type: "string" },
    slug,
    name,
    createdAt: timestamp,
  }),
  ProjectList: list("Project"),
  ProjectCreate: object({ name, slug }, ["name"]),
  ProjectUpdate: object({ name }),
  Emulator: object(
    {
      ...emulatorFields,
      url: { type: "string", description: "Base URL to point the vendor SDK at." },
      status: ref("EmulatorStatus"),
    },
    ["target", "durability", "url", "status"],
  ),
  EmulatorStatus: object({
    loaded: { type: "boolean" },
    durability,
    dirty: { type: "boolean" },
    lastSavedAt: nullable(timestamp),
    storedBytes: nullable({ type: "integer" }),
    lastError: nullable({ type: "string" }),
  }),
  EmulatorPut: object(emulatorFields, ["target"]),
  EmulatorPatch: object(emulatorFields, []),
  Fleet: object({
    id: { type: "string" },
    orgId: { type: "string" },
    projectId: { type: "string" },
    slug,
    name,
    access: ref("FleetAccess"),
    requestsPerMinute: nullable(requestsPerMinute),
    url: { type: "string", description: "Stable base URL of the fleet." },
    emulators: { type: "object", additionalProperties: ref("Emulator") },
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  FleetAccess: {
    type: "string",
    enum: ["open", "key"],
    description:
      "`open`: anyone who knows the fleet URL can call its emulators. `key`: every request needs an API key in `x-mockingbird-api-key`.",
  },
  FleetList: list("Fleet"),
  FleetCreate: object(
    {
      name,
      slug,
      access: ref("FleetAccess"),
      requestsPerMinute,
      emulators: {
        type: "object",
        maxProperties: 500,
        additionalProperties: ref("EmulatorPut"),
        description: "Emulators keyed by instance name.",
      },
    },
    ["name"],
  ),
  FleetUpdate: object({ name, access: ref("FleetAccess"), requestsPerMinute }, []),
  CatalogEntry: object(
    {
      target: { type: "string" },
      package: { type: "string" },
      displayName: { type: "string" },
      category: { type: "string" },
      description: { type: "string" },
      website: { type: "string" },
      docs: { type: "string" },
    },
    ["target", "package", "displayName", "category", "description"],
  ),
  Catalog: list("CatalogEntry"),
  StateDocument: object({
    format: { type: "string" },
    target: { type: "string" },
    namespaces: { type: "object", additionalProperties: true },
  }),
  Limits: object(Object.fromEntries(LIMIT_NAMES.map((key) => [key, count]))),
  Usage: object({
    suspended: nullable({ type: "string" }),
    limits: ref("Limits"),
    usage: object({
      projects: count,
      fleets: count,
      members: count,
      apiKeys: count,
      requestsThisMonth: count,
    }),
    daily: {
      type: "array",
      items: object({ day: { type: "string", format: "date" }, requests: count }),
    },
  }),
  AuditEntry: object({
    id: { type: "string" },
    actor: { type: "string" },
    action: {
      type: "string",
      description: "The operationId of the API call that made the change.",
    },
    target: { type: "string" },
    at: timestamp,
  }),
  AuditList: list("AuditEntry"),
  AdminOrg: object({
    id: { type: "string" },
    slug,
    name,
    createdAt: timestamp,
    managed: ref("Managed"),
    suspended: nullable({ type: "string" }),
    limitOverrides: { type: "object", additionalProperties: count },
    limits: ref("Limits"),
    requestsThisMonth: count,
  }),
  AdminOrgList: list("AdminOrg"),
  AdminOrgUpdate: object(
    {
      limits: {
        type: "object",
        additionalProperties: false,
        description:
          "Quotas to override for this organization. 0 is unlimited; null restores the default.",
        properties: Object.fromEntries(LIMIT_NAMES.map((key) => [key, nullable(count)])),
      },
      suspended: nullable({
        type: "string",
        minLength: 1,
        maxLength: 300,
        description: "A reason suspends the organization; null reinstates it.",
      }),
    },
    [],
  ),
  AdminUserCreate: object(
    {
      email: { type: "string", minLength: 3, maxLength: 200, pattern: "^[^@\\s]+@[^@\\s]+$" },
      name,
    },
    ["email"],
  ),
  AdminUser: object({ user: ref("User"), token: ref("ApiKey"), signInUrl: { type: "string" } }),
  Managed: {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["appliedAt", "appliedBy"],
    properties: { appliedAt: timestamp, appliedBy: { type: "string" } },
  },
  Declaration: {
    type: "object",
    additionalProperties: true,
    description:
      "A mockingbird.yaml document: `version: 1`, `organization` (slug), optional `name`, and `projects` by slug, each with `fleets` by slug, each with `name`, `access`, `requestsPerMinute` and `services` (emulators by instance name: `target`, `durability`, `seed`, `settings`, `flushIntervalMs`, `webhookOrigins`, `local`). Send it as JSON, or as YAML with `content-type: application/yaml`.",
  },
  DeclarationChange: object(
    {
      action: { type: "string", enum: ["create", "update", "delete", "unchanged"] },
      kind: { type: "string", enum: ["organization", "project", "fleet", "emulator"] },
      name: { type: "string" },
      detail: { type: "string" },
    },
    ["action", "kind", "name"],
  ),
  DeclarationResult: object({
    organization: nullable({
      type: "string",
      description: "The organization's id, once it exists.",
    }),
    applied: { type: "boolean", description: "False for a dry run." },
    changes: { type: "array", items: ref("DeclarationChange") },
  }),
  DeclarationView: object({
    managed: ref("Managed"),
    declaration: ref("Declaration"),
    yaml: { type: "string", description: "The declaration as a mockingbird.yaml file." },
  }),
  Ok: object({ ok: { type: "boolean" } }),
}

/** Validate `value` against `schema`, returning one message per problem (empty when valid). */
export function validate(schema: Schema, value: unknown, path = "body"): string[] {
  if (schema.$ref) {
    const target = SCHEMAS[schema.$ref.replace("#/components/schemas/", "")]
    return target ? validate(target, value, path) : [`${path}: unknown schema`]
  }
  const types = schema.type === undefined ? [] : [schema.type].flat()
  const actual =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value === "number"
          ? "integer"
          : typeof value
  if (types.length > 0 && !types.includes(actual))
    return [`${path}: expected ${types.join(" or ")}`]
  if (schema.enum && !schema.enum.includes(value as string))
    return [`${path}: must be one of ${schema.enum.join(", ")}`]
  const errors: string[] = []
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path}: must be at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path}: must be at most ${schema.maxLength} characters`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      errors.push(`${path}: ${schema.description ?? "has an invalid format"}`)
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) errors.push(`${path}: must be an integer`)
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: must be <= ${schema.maximum}`)
  } else if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path}: at most ${schema.maxItems} items`)
    if (schema.items)
      for (const [index, item] of value.entries())
        errors.push(...validate(schema.items, item, `${path}[${index}]`))
  } else if (actual === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
      errors.push(`${path}: at most ${schema.maxProperties} properties`)
    for (const key of schema.required ?? [])
      if (record[key] === undefined) errors.push(`${path}.${key}: required`)
    for (const key of keys) {
      const property = schema.properties?.[key]
      if (property) errors.push(...validate(property, record[key], `${path}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown field`)
      else if (typeof schema.additionalProperties === "object")
        errors.push(...validate(schema.additionalProperties, record[key], `${path}.${key}`))
    }
  }
  return errors
}

export type RouteDoc = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  path: string
  operationId: string
  summary: string
  tag: string
  auth: "public" | "required" | "operator"
  body?: string
  response: string
  status?: number
}

export function openApiDocument(routes: readonly RouteDoc[], serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {}
  const failure = (description: string) => ({
    description,
    content: { "application/json": { schema: ref("Error") } },
  })
  for (const route of routes) {
    const parameters = [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }))
    const item = paths[route.path] ?? {}
    paths[route.path] = item
    item[route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: route.summary,
      tags: [route.tag],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.auth === "public"
        ? { security: [] }
        : route.auth === "operator"
          ? { security: [{ operator: [] }] }
          : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: ref(route.body) } },
            },
          }
        : {}),
      responses: {
        [String(route.status ?? 200)]: {
          description: "Success",
          content: { "application/json": { schema: ref(route.response) } },
        },
        ...(route.body ? { "400": failure("The request is invalid") } : {}),
        ...(route.auth !== "public"
          ? {
              "429": failure("Rate limit reached; see Retry-After"),
              "401": failure("No valid credential"),
              "403": failure("The credential lacks access"),
              "404": failure("No such resource"),
            }
          : {}),
      },
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Mockingbird Fleet Cloud API",
      version: "1.0.0",
      description:
        "Control plane for hosted Mockingbird fleets: organizations, members, projects, fleets, emulators and API keys. The dashboard is a client of this API and nothing else.\n\nAuthenticate with `Authorization: Bearer <key>`. A personal token (`mbf_u_…`) acts as its user; an organization key (`mbf_o_…`) or project key (`mbf_p_…`) acts with its role inside that organization or project.",
    },
    servers: [{ url: `${serverUrl}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "A personal token or API key." },
        operator: {
          type: "http",
          scheme: "bearer",
          description: "The server's OPERATOR_TOKEN. Only the /admin routes accept it.",
        },
      },
      schemas: SCHEMAS,
    },
    paths,
  }
}
