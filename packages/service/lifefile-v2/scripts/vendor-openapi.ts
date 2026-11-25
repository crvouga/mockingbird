import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

type Json = Record<string, unknown>

const source = process.argv[2]
if (source === undefined) {
  console.error("usage: bun scripts/vendor-openapi.ts <path to LifeFile's openapi.json (API v2)>")
  process.exit(2)
}
const upstream = JSON.parse(await readFile(source, "utf8")) as Json
const upstreamPaths = upstream.paths as Record<string, Record<string, Json>>
const upstreamComponents = upstream.components as {
  schemas: Record<string, Json>
  parameters: Record<string, Json>
}

type Overlay = {
  method: string
  path: string
  id: string
  privilege: string
  unsafe?: string
  add?: Record<string, Json>
}

const OPERATIONS: readonly Overlay[] = [
  { method: "post", path: "/auth/token", id: "IssueToken", privilege: "" },
  {
    method: "delete",
    path: "/auth/token",
    id: "RevokeCurrentToken",
    privilege: "auth.token.revoke",
    unsafe: "Revokes the bearer token the run is using.",
  },
  { method: "get", path: "/auth/me", id: "CurrentApiUser", privilege: "auth.me" },
  {
    method: "post",
    path: "/auth/secret/rotate",
    id: "RotateCurrentSecret",
    privilege: "auth.secret.rotate",
    unsafe: "Rotates the real API user's secret and revokes every token it holds.",
  },
  { method: "get", path: "/orders", id: "ListOrders", privilege: "orders.list" },
  {
    method: "post",
    path: "/orders",
    id: "CreateOrder",
    privilege: "orders.create",
    unsafe: "Places a real order with the pharmacy.",
  },
  { method: "get", path: "/orders/{orderId}", id: "ShowOrder", privilege: "orders.view" },
  {
    method: "get",
    path: "/orders/{orderId}/status",
    id: "GetOrderStatus",
    privilege: "orders.status.view",
  },
  {
    method: "put",
    path: "/orders/{orderId}/status",
    id: "UpdateOrderStatus",
    privilege: "orders.status.update",
    unsafe: "Moves a real order through the pharmacy's workflow.",
  },
  {
    method: "get",
    path: "/orders/{orderId}/shipping",
    id: "GetOrderShipping",
    privilege: "orders.shipping.view",
  },
  {
    method: "put",
    path: "/orders/{orderId}/shipping",
    id: "UpdateOrderShipping",
    privilege: "orders.shipping.update",
    unsafe: "Changes where a real order ships.",
    add: { "500": { $ref: "#/components/responses/ServerError" } },
  },
  { method: "get", path: "/locations", id: "ListLocations", privilege: "locations.list" },
  {
    method: "get",
    path: "/locations/{locationId}",
    id: "ShowLocation",
    privilege: "locations.view",
  },
  {
    method: "get",
    path: "/locations/{locationId}/shipping-configurations",
    id: "ListLocationShippingConfigurations",
    privilege: "locations.shipping-configurations.list",
  },
  {
    method: "get",
    path: "/shipping-services",
    id: "ListShippingServices",
    privilege: "shipping-services.list",
  },
  {
    method: "get",
    path: "/practices/{practiceId}/shipping-services",
    id: "ListPracticeShippingServices",
    privilege: "practices.shipping-services.list",
  },
  { method: "get", path: "/statuses", id: "ListStatuses", privilege: "order-statuses.list" },
  { method: "get", path: "/ping", id: "Ping", privilege: "utility.ping" },
]

const PROSE = new Set(["description", "example", "examples", "x-property-order"])

const stripProse = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripProse)
  if (value === null || typeof value !== "object") return value
  const out: Json = {}
  for (const [key, entry] of Object.entries(value as Json)) {
    if (PROSE.has(key)) continue
    out[key] = stripProse(entry)
  }
  return out
}

const refsIn = (value: unknown, found: Set<string>): Set<string> => {
  if (Array.isArray(value)) {
    for (const entry of value) refsIn(entry, found)
    return found
  }
  if (value === null || typeof value !== "object") return found
  for (const [key, entry] of Object.entries(value as Json)) {
    if (key === "$ref" && typeof entry === "string") found.add(entry)
    else refsIn(entry, found)
  }
  return found
}

const RESPONSE_DESCRIPTION: Record<string, string> = {
  "200": "Success",
  "201": "Created",
  "401": "Missing, malformed, expired or revoked bearer token, or no X-Vendor-ID",
  "403": "The API user lacks the privilege, or the order's practice is outside its scope",
  "404": "Not found",
  "422": "Validation error",
  "429": "Rate limited",
  "500": "Server error",
}

const paths: Record<string, Record<string, Json>> = {}
const wanted = new Set<string>()
for (const overlay of OPERATIONS) {
  const operation = upstreamPaths[overlay.path]?.[overlay.method]
  if (!operation) throw new Error(`upstream has no ${overlay.method} ${overlay.path}`)
  const cleaned = stripProse(operation) as Json
  delete cleaned.operationId
  delete cleaned.tags
  const responses = (cleaned.responses ?? {}) as Record<string, Json>
  for (const [status, response] of Object.entries(responses)) {
    response.description = RESPONSE_DESCRIPTION[status] ?? "Response"
  }
  if (overlay.id !== "IssueToken") {
    responses["429"] = { $ref: "#/components/responses/RateLimited" }
    responses["500"] = { $ref: "#/components/responses/ServerError" }
  } else {
    responses["429"] = { $ref: "#/components/responses/TokenRateLimited" }
  }
  Object.assign(responses, overlay.add ?? {})
  cleaned.responses = responses
  cleaned.operationId = overlay.id
  cleaned.tags = [overlay.path.split("/")[1] ?? "api"]
  if (overlay.privilege) cleaned["x-lifefile-privilege"] = overlay.privilege
  if (overlay.unsafe) cleaned["x-mockingbird"] = { parity: { safe: false, reason: overlay.unsafe } }
  const key = `/api/v2${overlay.path}`
  paths[key] = { ...(paths[key] ?? {}), [overlay.method]: cleaned }
  refsIn(cleaned, wanted)
}

const schemas: Record<string, Json> = {}
const parameters: Record<string, Json> = {}
const queue = [...wanted]
while (queue.length > 0) {
  const ref = queue.pop() as string
  const [, , kind, name] = ref.split("/")
  if (!name) continue
  if (kind === "schemas") {
    if (schemas[name]) continue
    const schema = upstreamComponents.schemas[name]
    if (!schema) continue
    schemas[name] = stripProse(schema) as Json
    for (const inner of refsIn(schemas[name], new Set())) queue.push(inner)
  } else if (kind === "parameters") {
    if (parameters[name]) continue
    const parameter = upstreamComponents.parameters[name]
    if (!parameter) throw new Error(`upstream has no parameter ${name}`)
    parameters[name] = stripProse(parameter) as Json
    for (const inner of refsIn(parameters[name], new Set())) queue.push(inner)
  }
}

const schema = (name: string) => {
  const found = schemas[name]
  if (!found) throw new Error(`schema ${name} was not vendored`)
  return found as Json & { properties: Record<string, Json>; required?: string[] }
}

const message = schema("CreateOrderMessage")
message.properties.id = { type: ["integer", "string"] }

const created = schema("OrderCreateResult").properties.data as Json & {
  properties: Record<string, Json>
  required: string[]
}
created.required = ["orderId"]
created.properties.orderId = {
  type: "integer",
  format: "int32",
  "x-mockingbird-volatile": { kind: "id" },
}

schemas.OrderStatusFastTrackData = {
  type: "object",
  required: [
    "order_status_changed",
    "original_order_status",
    "current_order_status",
    "process_fast_track_result",
  ],
  properties: {
    order_status_changed: { type: "integer" },
    original_order_status: { type: "string" },
    current_order_status: { type: "string" },
    process_fast_track_result: { type: "array" },
  },
}
schemas.OrderStatusUpdateResult = {
  type: "object",
  required: ["type", "message", "data"],
  properties: {
    type: { type: "string", enum: ["success"] },
    message: { type: "string" },
    data: {
      oneOf: [
        {
          type: "object",
          required: ["status"],
          properties: { status: { type: "string" } },
        },
        { $ref: "#/components/schemas/OrderStatusFastTrackData" },
      ],
    },
  },
}

const token = schema("OAuthTokenResponse")
token.properties.access_token = {
  type: "string",
  "x-mockingbird-volatile": { kind: "token" },
}

for (const name of ["OrderListItem"]) {
  const order = schema(name)
  for (const field of ["createdOn", "lastUpdatedOn"]) {
    order.properties[field] = {
      ...(order.properties[field] ?? {}),
      "x-mockingbird-volatile": { kind: "timestamp" },
    }
  }
  order.properties.id = {
    ...(order.properties.id ?? {}),
    "x-mockingbird-volatile": { kind: "id" },
  }
}

const orderIdParameter = parameters.OrderIdPath as Json & { schema: Json }
orderIdParameter.schema = {
  type: "integer",
  format: "int32",
  minimum: 1,
}

const envelopeError = {
  type: "object",
  required: ["type", "message", "data"],
  properties: {
    type: { type: "string", enum: ["error"] },
    message: { type: "string" },
    data: { type: ["object", "array", "null"] },
  },
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "LifeFile API v2, vendored for Mockingbird",
    version: (upstream.info as Json).version,
    "x-mockingbird-upstream": {
      sandbox: "https://apitest.lifefile.net:10165/api/v2",
      tokenUrl: "/api/v2/auth/token",
      note: "Trimmed to the operations the emulator models. Field names, types, limits and statuses come from LifeFile's published v2 contract; prose is left out. Where the recorded sandbox replies differ, the recordings win.",
    },
  },
  servers: [{ url: "https://apitest.lifefile.net:10165" }],
  security: [{ OAuth2ClientCredentials: ["*"] }],
  paths,
  components: {
    securitySchemes: {
      OAuth2ClientCredentials: {
        type: "oauth2",
        flows: { clientCredentials: { tokenUrl: "/api/v2/auth/token", scopes: { "*": "all" } } },
      },
    },
    parameters,
    responses: {
      RateLimited: {
        description: "Rate limited",
        content: { "application/json": { schema: envelopeError } },
      },
      TokenRateLimited: {
        description: "Token requests rate limited",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error", "error_description"],
              properties: { error: { type: "string" }, error_description: { type: "string" } },
            },
          },
        },
      },
      ServerError: {
        description: "Server error",
        content: { "application/json": { schema: envelopeError } },
      },
    },
    schemas,
  },
}

const yaml = Bun.YAML.stringify(document, null, 2)
  .split("\n")
  .map((line) => line.trimEnd())
  .join("\n")
const header = [
  "# Generated by scripts/vendor-openapi.ts from LifeFile's API v2 contract (version in info);",
  "# edit the overlay in that script, not this file, then `bun run generate`.",
  "",
].join("\n")
await writeFile(join(import.meta.dir, "..", "openapi.yaml"), `${header}${yaml}\n`)
console.log(`wrote openapi.yaml (${OPERATIONS.length} operations) from ${source}`)
