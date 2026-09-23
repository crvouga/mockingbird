/**
 * Vendor the supported subset of Stripe's official OpenAPI spec into `openapi.yaml`.
 *
 * Source: https://github.com/stripe/openapi (spec3.json), pinned by commit below. Only the
 * operations Mockingbird implements are kept, together with the component schemas they
 * transitively reference. Expandable fields are collapsed to their unexpanded (id-only) shape
 * because the mock never expands. Mockingbird metadata is layered on top so the differential
 * runner knows identities, references, volatile fields and unsupported parameters.
 *
 * Run with `bun run vendor` inside packages/service/stripe (network access required).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { stringify } from "yaml"
import { IDENTITIES, MISSING_ID, SURFACE } from "./surface.js"

const UPSTREAM = {
  repository: "stripe/openapi",
  commit: "6ed8e70ed90416a4f37603fffcf2fb1f96b405d5",
  file: "openapi/spec3.json",
} as const

const packageDir = resolve(import.meta.dir, "..")
const cachePath = resolve(packageDir, "node_modules/.cache/stripe-spec3.json")
const outputPath = resolve(packageDir, "openapi.yaml")

type Json = Record<string, unknown>
type Schema = Json

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const fetchUpstream = async (): Promise<Json> => {
  try {
    return JSON.parse(await readFile(cachePath, "utf8")) as Json
  } catch {
    const url = `https://raw.githubusercontent.com/${UPSTREAM.repository}/${UPSTREAM.commit}/${UPSTREAM.file}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`failed to fetch ${url}: ${response.status}`)
    const text = await response.text()
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, text)
    return JSON.parse(text) as Json
  }
}

// --- metadata helpers -------------------------------------------------------------------------

const identity = (type: string) => ({ "x-mockingbird-resource": { type, identity: true } })
const ref = (type: string, missing: string) => ({ "x-mockingbird-resource-ref": { type, missing } })
const volatile = (kind: "id" | "timestamp" | "token" | "url" | "account" | "opaque") => ({
  "x-mockingbird-volatile": { kind },
})
const unsupported = (reason: string) => ({ "x-mockingbird-unsupported": { reason } })
const scope = (value: "run-id" | "walk-start-unix" | "walk-start-iso") => ({
  "x-mockingbird-scope": { value },
})

const MISSING = {
  customer: "cus_mockingbird_missing",
  product: "prod_mockingbird_missing",
  price: "price_mockingbird_missing",
} as const

/** The generator only needs a handful of currencies; the mock still knows Stripe's full list. */
const CURRENCY: Schema = { type: "string", enum: ["usd", "eur", "gbp", "jpy", "cad", "aud"] }
/** Stripe validates IETF language tags; keep the generator to well-formed ones. */
const LOCALE_ITEM: Schema = {
  type: "string",
  enum: ["en", "en-US", "en-GB", "fr", "fr-CA", "de", "es", "ja", "pt-BR"],
}

const idOnly = (extra: Json = {}): Schema => ({ maxLength: 5000, type: "string", ...extra })
const nullableIdOnly = (extra: Json = {}): Schema => ({
  maxLength: 5000,
  type: ["string", "null"],
  ...extra,
})

// --- schema shaping ---------------------------------------------------------------------------

/** Property-level edits applied to a component schema. `null` deletes the property. */
type Shape = Record<string, Schema | null>

const RESPONSE_SHAPES: Record<string, Shape> = {
  customer: {
    id: identity("customer"),
    created: volatile("timestamp"),
    invoice_prefix: volatile("opaque"),
    // Only present when expanded; the mock never expands.
    cash_balance: null,
    sources: null,
    subscriptions: null,
    tax: null,
    tax_ids: null,
    // Not returned by the pinned API version.
    business_name: null,
    individual_name: null,
    invoice_credit_balance: null,
    default_source: nullableIdOnly(),
    discount: { type: "null" },
    test_clock: nullableIdOnly(),
  },
  deleted_customer: { id: identity("customer") },
  product: {
    id: identity("product"),
    // Returned by the pinned API version although absent from the published schema.
    attributes: { type: "array", items: { type: "string" } },
    tax_details: { type: "null" },
    type: { type: "string", enum: ["good", "service"] },
    created: volatile("timestamp"),
    updated: volatile("timestamp"),
    default_price: nullableIdOnly(identity("price")),
    tax_code: nullableIdOnly(),
  },
  deleted_product: { id: identity("product") },
  price: {
    id: identity("price"),
    created: volatile("timestamp"),
    product: idOnly(identity("product")),
    // Only present when expanded or when the pricing model uses them.
    currency_options: null,
    tiers: null,
  },
  invoice_setting_customer_setting: { default_payment_method: nullableIdOnly() },
  recurring: { trial_period_days: { type: ["integer", "null"] } },
  api_errors: {
    request_log_url: volatile("url"),
    payment_intent: null,
    payment_method: null,
    setup_intent: null,
    source: null,
  },
}

/** Request-body property edits keyed by operationId. */
const IMAGES: Schema = { type: "array", maxItems: 8, items: { type: "string", maxLength: 2048 } }
const MARKETING_FEATURES: Schema = {
  type: "array",
  maxItems: 15,
  items: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", maxLength: 5000 } },
  },
}
/** Stripe lets update calls clear a field by sending `""`; the spec models that as a union. */
const unsettable = (schema: Schema): Schema => ({
  anyOf: [schema, { type: "string", enum: [""] }],
})

const BODY_SHAPES: Record<string, Shape> = {
  PostCustomers: {
    "preferred_locales[]": LOCALE_ITEM,
    business_name: unsupported("not returned by the pinned API version"),
    cash_balance: unsupported("cash balance settings are not modelled"),
    expand: unsupported("the mock never expands"),
    individual_name: unsupported("not returned by the pinned API version"),
    invoice_prefix: unsupported("invoice prefix allocation is not modelled"),
    next_invoice_sequence: unsupported("invoicing is not modelled"),
    payment_method: unsupported("payment methods are not modelled"),
    source: unsupported("payment sources are not modelled"),
    tax: unsupported("tax location validation is not modelled"),
    tax_id_data: unsupported("tax ids are not modelled"),
    test_clock: unsupported("test clocks are not modelled"),
    "invoice_settings.default_payment_method": unsupported("payment methods are not modelled"),
    "invoice_settings.rendering_options": unsupported(
      "invoice rendering templates are not modelled",
    ),
  },
  PostCustomersCustomer: {
    "preferred_locales[]": LOCALE_ITEM,
    bank_account: unsupported("payment sources are not modelled"),
    card: unsupported("payment sources are not modelled"),
    business_name: unsupported("not returned by the pinned API version"),
    cash_balance: unsupported("cash balance settings are not modelled"),
    default_alipay_account: unsupported("payment sources are not modelled"),
    default_bank_account: unsupported("payment sources are not modelled"),
    default_card: unsupported("payment sources are not modelled"),
    default_source: unsupported("payment sources are not modelled"),
    expand: unsupported("the mock never expands"),
    individual_name: unsupported("not returned by the pinned API version"),
    invoice_prefix: unsupported("invoice prefix allocation is not modelled"),
    next_invoice_sequence: unsupported("invoicing is not modelled"),
    source: unsupported("payment sources are not modelled"),
    tax: unsupported("tax location validation is not modelled"),
    "invoice_settings.default_payment_method": unsupported("payment methods are not modelled"),
    "invoice_settings.rendering_options": unsupported(
      "invoice rendering templates are not modelled",
    ),
  },
  PostProducts: {
    images: IMAGES,
    marketing_features: MARKETING_FEATURES,
    default_price_data: unsupported("inline price creation is not modelled"),
    expand: unsupported("the mock never expands"),
    id: unsupported("caller-chosen ids are not modelled"),
    tax_code: unsupported("tax codes are not modelled"),
  },
  PostProductsId: {
    images: unsettable(IMAGES),
    marketing_features: unsettable(MARKETING_FEATURES),
    default_price: unsupported("default price assignment is not modelled"),
    expand: unsupported("the mock never expands"),
    tax_code: unsupported("tax codes are not modelled"),
  },
  PostPrices: {
    currency: CURRENCY,
    "recurring.interval_count": { type: "integer", minimum: 1 },
    billing_scheme: unsupported("tiered billing is not modelled"),
    currency_options: unsupported("multi-currency prices are not modelled"),
    custom_unit_amount: unsupported("customer-chosen amounts are not modelled"),
    expand: unsupported("the mock never expands"),
    product: ref("product", MISSING.product),
    product_data: unsupported("inline product creation is not modelled"),
    tiers: unsupported("tiered billing is not modelled"),
    tiers_mode: unsupported("tiered billing is not modelled"),
    transfer_lookup_key: unsupported("lookup key transfer is not modelled"),
    transform_quantity: unsupported("quantity transforms are not modelled"),
    "recurring.meter": unsupported("billing meters are not modelled"),
  },
  PostPricesPrice: {
    currency_options: unsupported("multi-currency prices are not modelled"),
    expand: unsupported("the mock never expands"),
    transfer_lookup_key: unsupported("lookup key transfer is not modelled"),
  },
}

/** Query-parameter edits keyed by operationId; `null` deletes the parameter. */
const QUERY_SHAPES: Record<string, Shape> = {
  GetCustomers: {
    "created.gte": scope("walk-start-unix"),
    ending_before: ref("customer", MISSING.customer),
    starting_after: ref("customer", MISSING.customer),
    expand: unsupported("the mock never expands"),
    test_clock: unsupported("test clocks are not modelled"),
  },
  GetCustomersCustomer: { expand: unsupported("the mock never expands") },
  GetProducts: {
    "created.gte": scope("walk-start-unix"),
    ending_before: ref("product", MISSING.product),
    starting_after: ref("product", MISSING.product),
    "ids[]": ref("product", MISSING.product),
    expand: unsupported("the mock never expands"),
  },
  GetProductsId: { expand: unsupported("the mock never expands") },
  GetPrices: {
    currency: CURRENCY,
    lookup_keys: { type: "array", maxItems: 10, items: { type: "string", maxLength: 5000 } },
    "created.gte": scope("walk-start-unix"),
    ending_before: ref("price", MISSING.price),
    starting_after: ref("price", MISSING.price),
    product: ref("product", MISSING.product),
    expand: unsupported("the mock never expands"),
    "recurring.meter": unsupported("billing meters are not modelled"),
  },
  GetPricesPrice: { expand: unsupported("the mock never expands") },
}

const PATH_REFS: Record<string, Json> = {
  customer: ref("customer", MISSING.customer),
  id: ref("product", MISSING.product),
  price: ref("price", MISSING.price),
}

const included = (operationId: string): { safe: boolean } | undefined =>
  OPERATIONS[operationId] ?? (SURFACE[operationId] ? { safe: false } : undefined)

const OPERATIONS: Record<string, { safe: boolean }> = {
  PostCustomers: { safe: true },
  GetCustomers: { safe: true },
  GetCustomersCustomer: { safe: true },
  PostCustomersCustomer: { safe: true },
  DeleteCustomersCustomer: { safe: true },
  PostProducts: { safe: true },
  GetProducts: { safe: true },
  GetProductsId: { safe: true },
  PostProductsId: { safe: true },
  DeleteProductsId: { safe: true },
  PostPrices: { safe: true },
  GetPrices: { safe: true },
  GetPricesPrice: { safe: true },
  PostPricesPrice: { safe: true },
}

const resourceRef = (type: string) => ref(type, MISSING_ID[type] ?? `${type}_mockingbird_missing`)

const tuneSurfaceQuery = (operationId: string, name: string, schema: Schema) => {
  const surface = SURFACE[operationId]
  if (!surface) return
  if (name === "expand" || name === "page")
    Object.assign(schema, unsupported("not part of the random walk"))
  if ((name === "ending_before" || name === "starting_after") && surface.cursor)
    Object.assign(schema, resourceRef(surface.cursor))
  const linked = surface.refs?.[name]
  if (linked) Object.assign(schema, resourceRef(linked))
  if (name !== "created" || !Array.isArray(schema.anyOf)) return
  for (const branch of schema.anyOf) {
    if (!isObject(branch) || !isObject(branch.properties) || !isObject(branch.properties.gte))
      continue
    Object.assign(branch.properties.gte as Schema, scope("walk-start-unix"))
  }
}

const WALK_SKIP = [
  "expand",
  "on_behalf_of",
  "transfer_data",
  "application_fee_amount",
  "radar_options",
  "payment_method_options",
  "mandate",
  "mandate_data",
  "payment_method_data",
  "shipping",
  "price_data",
  "amount_details",
  "payment_details",
  "hooks",
  "subscription_data",
  "invoice_creation",
  "shipping_options",
  "custom_fields",
  "custom_text",
  "consent_collection",
  "phone_number_collection",
  "tax_id_collection",
  "after_expiration",
  "branding_settings",
  "optional_items",
  "name_collection",
  "saved_payment_method_options",
  "permissions",
  "adaptive_pricing",
  "discounts",
  "automatic_tax",
  "invoice_settings",
  "payment_settings",
  "trial_settings",
  "billing_mode",
  "billing_schedules",
]

const stubUnsupported = (reason: string): Schema => ({
  type: "object",
  additionalProperties: true,
  ...unsupported(reason),
})

const isHeavy = (property: Schema) =>
  property.$ref !== undefined ||
  property.properties !== undefined ||
  property.anyOf !== undefined ||
  property.oneOf !== undefined ||
  property.items !== undefined

const PM_PARAM_KEEP = new Set([
  "type",
  "card",
  "billing_details",
  "metadata",
  "customer",
  "allow_redisplay",
  "expand",
  "payment_method",
])

const tuneSurfaceBody = (operationId: string, schema: Schema) => {
  const surface = SURFACE[operationId]
  if (!surface || !isObject(schema.properties)) return
  const properties = schema.properties
  if (isObject(properties.card) && (isObject(properties.affirm) || isObject(properties.klarna))) {
    for (const name of Object.keys(properties)) {
      if (PM_PARAM_KEEP.has(name) || !isObject(properties[name])) continue
      properties[name] = stubUnsupported("accepted by the mock, omitted from random walks")
    }
  }
  for (const name of WALK_SKIP) {
    const property = properties[name]
    if (!isObject(property)) continue
    properties[name] = isHeavy(property)
      ? stubUnsupported("not part of the random walk")
      : { ...property, ...unsupported("not part of the random walk") }
  }
  for (const [name, type] of Object.entries(surface.refs ?? {})) {
    if (isObject(properties[name])) Object.assign(properties[name] as Schema, resourceRef(type))
  }
  for (const [path, type] of Object.entries(surface.arrayRefs ?? {})) {
    const [arrayName, field] = path.split(".")
    const array = properties[arrayName ?? ""]
    if (!isObject(array) || !isObject(array.items)) continue
    const items = array.items
    if (!isObject(items.properties)) continue
    const target = items.properties[field ?? ""]
    if (isObject(target)) Object.assign(target, resourceRef(type))
  }
}

const TIMESTAMP_FIELDS = new Set([
  "created",
  "updated",
  "canceled_at",
  "expires_at",
  "expires",
  "arrival_date",
  "available_on",
  "billing_cycle_anchor",
  "start_date",
  "period_start",
  "period_end",
  "current_period_start",
  "current_period_end",
  "trial_start",
  "trial_end",
  "due_date",
  "date",
])

const annotateSchemas = (schemas: Record<string, Json>) => {
  for (const [name, schema] of Object.entries(schemas)) {
    if (!isObject(schema.properties)) continue
    const properties = schema.properties as Record<string, Schema>
    const identities = IDENTITIES[name]
    if (identities) {
      for (const [field, type] of Object.entries(identities)) {
        const property = properties[field]
        if (!isObject(property)) continue
        const types = Array.isArray(property.type)
          ? property.type
          : property.type
            ? [property.type]
            : []
        const stringy =
          types.length === 0 ||
          types.includes("string") ||
          property.anyOf !== undefined ||
          property.oneOf !== undefined
        if (field === "id" || stringy) Object.assign(property, identity(type))
      }
    }
    if (name === "account" && isObject(properties.id))
      Object.assign(properties.id, volatile("account"))
    for (const [field, property] of Object.entries(properties)) {
      if (
        !isObject(property) ||
        property["x-mockingbird-volatile"] ||
        property["x-mockingbird-resource"]
      )
        continue
      const types = Array.isArray(property.type)
        ? property.type
        : property.type
          ? [property.type]
          : []
      if (TIMESTAMP_FIELDS.has(field) && (types.length === 0 || types.includes("integer")))
        Object.assign(property, volatile("timestamp"))
      if (
        (field === "client_secret" || field === "secret") &&
        (types.length === 0 || types.includes("string") || types.includes("null"))
      )
        Object.assign(property, volatile("token"))
    }
  }
}

const parityHeaders = () => ({
  "content-type": {
    schema: { type: "string", enum: ["application/json"] },
    "x-mockingbird-parity-header": true,
  },
})

const addClientSurfaces = (paths: Record<string, Json>) => {
  const flagged = { supported: true, parity: { enabled: true, safe: false } }
  const error = { $ref: "#/components/schemas/error" }
  const respond = (schema: Json) => ({
    "200": { content: { "application/json": { schema } }, headers: parityHeaders() },
    default: { content: { "application/json": { schema: error } }, headers: parityHeaders() },
  })
  paths["/v1/elements/sessions"] = {
    get: {
      operationId: "GetElementsSessions",
      parameters: [
        {
          in: "query",
          name: "client_secret",
          required: false,
          schema: { type: "string", maxLength: 500 },
          style: "form",
        },
        {
          in: "query",
          name: "type",
          required: false,
          schema: { type: "string", enum: ["payment_intent", "setup_intent", "deferred_intent"] },
          style: "form",
        },
        {
          in: "query",
          name: "locale",
          required: false,
          schema: { type: "string", maxLength: 35 },
          style: "form",
        },
      ],
      responses: respond({
        type: "object",
        additionalProperties: true,
        required: ["object", "livemode", "mode"],
        properties: {
          object: { type: "string", enum: ["elements_session"] },
          livemode: { type: "boolean" },
          mode: { type: "string" },
          session_id: { type: "string", ...volatile("token") },
        },
      }),
      "x-mockingbird": flagged,
    },
    post: {
      operationId: "PostElementsSessions",
      requestBody: {
        required: false,
        content: {
          "application/x-www-form-urlencoded": {
            schema: { type: "object", additionalProperties: true, properties: {} },
          },
        },
      },
      responses: respond({
        type: "object",
        additionalProperties: true,
        required: ["object", "livemode", "mode"],
        properties: {
          object: { type: "string", enum: ["elements_session"] },
          livemode: { type: "boolean" },
          mode: { type: "string" },
        },
      }),
      "x-mockingbird": flagged,
    },
  }
  paths["/v1/confirmation_tokens"] = {
    post: {
      operationId: "PostConfirmationTokens",
      parameters: [],
      requestBody: {
        required: false,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              additionalProperties: true,
              properties: {
                payment_method: {
                  type: "string",
                  maxLength: 5000,
                  ...resourceRef("payment_method"),
                },
                return_url: { type: "string", maxLength: 2048 },
                setup_future_usage: { type: "string", enum: ["off_session", "on_session"] },
              },
            },
          },
        },
      },
      responses: respond({ $ref: "#/components/schemas/confirmation_token" }),
      "x-mockingbird": flagged,
    },
  }
}

// --- transforms --------------------------------------------------------------------------------

/** Strip prose and Stripe-only extensions; normalise `nullable` to a 3.1 type union. */
const clean = (value: unknown, propertyMap = false): unknown => {
  if (Array.isArray(value)) return value.map((item) => clean(item))
  if (!isObject(value)) return value
  const out: Json = {}
  for (const [key, inner] of Object.entries(value)) {
    if (propertyMap) {
      out[key] = clean(inner)
      continue
    }
    if (
      key === "description" ||
      key === "x-expandableFields" ||
      key === "x-expansionResources" ||
      key === "x-resourceId" ||
      key === "x-stripeResource" ||
      key === "x-stripeOperations" ||
      key === "x-stripeMostCommon" ||
      key === "x-stripeBypassValidation" ||
      key === "x-stripeParam"
    )
      continue
    out[key] = clean(inner, key === "properties")
  }
  if (out.nullable === true) {
    delete out.nullable
    if (typeof out.type === "string") out.type = [out.type, "null"]
    else if (Array.isArray(out.anyOf)) out.anyOf = [...(out.anyOf as unknown[]), { type: "null" }]
    else if (Array.isArray(out.oneOf)) out.oneOf = [...(out.oneOf as unknown[]), { type: "null" }]
    else if (out.$ref) {
      out.anyOf = [{ $ref: out.$ref }, { type: "null" }]
      delete out.$ref
    }
  }
  return out
}

/** Locate a (possibly nested) property inside a schema, descending into anyOf object branches. */
const propertyContainer = (schema: Schema, path: string[]): Schema | undefined => {
  let current: Schema | undefined = schema
  for (const segment of path) {
    if (!current) return undefined
    const properties = isObject(current.properties) ? current.properties : undefined
    let next: Schema | undefined =
      properties && isObject(properties[segment]) ? (properties[segment] as Schema) : undefined
    if (!next && Array.isArray(current.anyOf)) {
      for (const branch of current.anyOf) {
        if (isObject(branch) && isObject(branch.properties) && isObject(branch.properties[segment]))
          next = branch.properties[segment] as Schema
      }
    }
    if (!next) return undefined
    current = next
  }
  return current
}

const parentAndKey = (path: string): [string[], string] => {
  const segments = path.split(".")
  const key = segments.pop() ?? path
  return [segments, key]
}

const applyShape = (schema: Schema, shape: Shape, label: string) => {
  for (const [path, edit] of Object.entries(shape)) {
    if (path.endsWith("[]")) {
      const [arrayParent, arrayKey] = parentAndKey(path.slice(0, -2))
      const target = propertyContainer(schema, [...arrayParent, arrayKey])
      if (!target || !isObject(target.items))
        throw new Error(`${label}: array property ${path} not found`)
      if (edit === null) throw new Error(`${label}: cannot delete array items ${path}`)
      target.items = { ...target.items, ...edit }
      continue
    }
    const [parentPath, key] = parentAndKey(path)
    const parent = parentPath.length === 0 ? schema : propertyContainer(schema, parentPath)
    const containers: Schema[] = []
    if (parent) {
      if (isObject(parent.properties)) containers.push(parent.properties)
      if (Array.isArray(parent.anyOf))
        for (const branch of parent.anyOf)
          if (isObject(branch) && isObject(branch.properties)) containers.push(branch.properties)
    }
    let holder = containers.find((c) => isObject(c[key]))
    if (
      !holder &&
      edit !== null &&
      parent &&
      isObject(parent.properties) &&
      Object.keys(edit).some((k) => !k.startsWith("x-mockingbird"))
    ) {
      holder = parent.properties
      holder[key] = {}
      if (Array.isArray(parent.required))
        parent.required = [...(parent.required as string[]), key].sort()
    }
    if (!holder) throw new Error(`${label}: property ${path} not found`)
    if (edit === null) {
      delete holder[key]
      if (Array.isArray(parent?.required))
        parent.required = (parent.required as string[]).filter((r) => r !== key)
      continue
    }
    const existing = holder[key] as Schema
    const replacesSchema = Object.keys(edit).some((k) => !k.startsWith("x-mockingbird"))
    holder[key] = replacesSchema ? { ...edit } : { ...existing, ...edit }
  }
}

const collectRefs = (value: unknown, out: Set<string>) => {
  if (Array.isArray(value)) for (const v of value) collectRefs(v, out)
  else if (isObject(value)) {
    if (typeof value.$ref === "string") {
      const name = value.$ref.replace("#/components/schemas/", "")
      out.add(name)
    }
    for (const v of Object.values(value)) collectRefs(v, out)
  }
}

const main = async () => {
  const upstream = await fetchUpstream()
  const info = upstream.info as Json
  const upstreamPaths = upstream.paths as Record<string, Json>
  const upstreamSchemas = (upstream.components as Json).schemas as Record<string, Json>

  const paths: Record<string, Json> = {}
  for (const [path, item] of Object.entries(upstreamPaths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!isObject(operation) || typeof operation.operationId !== "string") continue
      const config = included(operation.operationId)
      if (!config) continue
      const cleaned = clean(operation) as Json
      const pathItem = paths[path] ?? {}
      paths[path] = pathItem

      // Path params → resource refs; query params → shapes.
      const parameters = Array.isArray(cleaned.parameters) ? (cleaned.parameters as Json[]) : []
      const queryShape = QUERY_SHAPES[operation.operationId] ?? {}
      const kept: Json[] = []
      for (const parameter of parameters) {
        const name = String(parameter.name)
        if (parameter.in === "path") {
          const surfaceType = SURFACE[operation.operationId]?.path?.[name]
          const pathRef = surfaceType
            ? ref(surfaceType, MISSING_ID[surfaceType] ?? `${surfaceType}_mockingbird_missing`)
            : PATH_REFS[name]
          if (!pathRef)
            throw new Error(
              `${operation.operationId}: no resource ref for path parameter {${name}}`,
            )
          kept.push({ ...parameter, schema: { ...(parameter.schema as Json), ...pathRef } })
          continue
        }
        const top = queryShape[name]
        if (top === null) continue
        const schema = { ...(parameter.schema as Json) }
        if (top) Object.assign(schema, top)
        for (const [shapePath, edit] of Object.entries(queryShape)) {
          if (!shapePath.startsWith(`${name}.`) && shapePath !== `${name}[]`) continue
          if (shapePath === `${name}[]`) {
            if (!isObject(schema.items))
              throw new Error(`${operation.operationId}: ${name} is not an array`)
            schema.items = { ...schema.items, ...edit }
            continue
          }
          const nested = shapePath.slice(name.length + 1)
          const [parentPath, key] = parentAndKey(nested)
          const container = parentPath.length === 0 ? schema : propertyContainer(schema, parentPath)
          const holders: Schema[] = []
          if (container && isObject(container.properties)) holders.push(container.properties)
          if (container && Array.isArray(container.anyOf))
            for (const b of container.anyOf)
              if (isObject(b) && isObject(b.properties)) holders.push(b.properties)
          const holder = holders.find((h) => isObject(h[key]))
          if (!holder) throw new Error(`${operation.operationId}: query ${shapePath} not found`)
          if (edit === null) delete holder[key]
          else holder[key] = { ...(holder[key] as Json), ...edit }
        }
        tuneSurfaceQuery(operation.operationId, name, schema)
        kept.push({ ...parameter, schema })
      }
      for (const name of Object.keys(queryShape)) {
        if (
          !parameters.some(
            (p) =>
              p.name === name ||
              name.startsWith(`${String(p.name)}.`) ||
              name === `${String(p.name)}[]`,
          )
        )
          throw new Error(`${operation.operationId}: query parameter ${name} not found`)
      }
      cleaned.parameters = kept

      const bodyShape = BODY_SHAPES[operation.operationId]
      const requestBody = cleaned.requestBody
      if (isObject(requestBody) && isObject(requestBody.content)) {
        const form = (requestBody.content as Record<string, Json>)[
          "application/x-www-form-urlencoded"
        ]
        if (bodyShape) {
          if (!form) throw new Error(`${operation.operationId}: no form body`)
          applyShape(form.schema as Schema, bodyShape, operation.operationId)
        }
        if (form && isObject(form.schema))
          tuneSurfaceBody(operation.operationId, form.schema as Schema)
      }

      // Parity headers: content type is part of the contract.
      for (const response of Object.values(cleaned.responses as Record<string, Json>)) {
        response.headers = {
          "content-type": {
            schema: { type: "string", enum: ["application/json"] },
            "x-mockingbird-parity-header": true,
          },
        }
      }

      cleaned["x-mockingbird"] = { supported: true, parity: { enabled: true, safe: config.safe } }
      pathItem[method] = cleaned
    }
  }
  const missingOps = [...Object.keys(OPERATIONS), ...Object.keys(SURFACE)].filter(
    (id) =>
      !Object.values(paths).some((item) =>
        Object.values(item).some((op) => isObject(op) && op.operationId === id),
      ),
  )
  if (missingOps.length > 0)
    throw new Error(`operations not found upstream: ${missingOps.join(", ")}`)

  // Transitive component closure with shaping applied before following refs.
  const schemas: Record<string, Json> = {}
  const queue = new Set<string>()
  collectRefs(paths, queue)
  for (const name of queue) {
    if (schemas[name]) continue
    const source = upstreamSchemas[name]
    if (!source) throw new Error(`component schema ${name} not found upstream`)
    const shaped = clean(source) as Json
    const shape = RESPONSE_SHAPES[name]
    if (shape) applyShape(shaped, shape, name)
    schemas[name] = shaped
    collectRefs(shaped, queue)
  }
  for (const name of Object.keys(RESPONSE_SHAPES))
    if (!schemas[name]) throw new Error(`shape for unused component schema ${name}`)

  annotateSchemas(schemas)
  // Customer, product and price stay field-exact. Everything else is loosened so the
  // parity walker does not traverse Stripe's combinatorial $ref graph.
  const precise = new Set([
    "address",
    "api_errors",
    "custom_unit_amount",
    "customer",
    "deleted_customer",
    "deleted_product",
    "error",
    "invoice_setting_custom_field",
    "invoice_setting_customer_rendering_options",
    "invoice_setting_customer_setting",
    "package_dimensions",
    "price",
    "product",
    "product_marketing_feature",
    "recurring",
    "shipping",
    "transform_quantity",
  ])
  for (const [name, schema] of Object.entries(schemas)) {
    if (precise.has(name) || !isObject(schema) || !isObject(schema.properties)) continue
    const source = schema.properties as Record<string, Schema>
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : []
    const properties: Record<string, Schema> = {}
    for (const key of new Set([...required, "id", "object", "created", "livemode"])) {
      const property = source[key]
      if (!isObject(property)) continue
      const extensions: Json = {}
      for (const [ext, value] of Object.entries(property)) {
        if (ext.startsWith("x-mockingbird")) extensions[ext] = value
      }
      if (Array.isArray(property.enum))
        properties[key] = { type: property.type ?? "string", enum: property.enum, ...extensions }
      else if (property.type !== undefined) properties[key] = { type: property.type, ...extensions }
      else properties[key] = { ...extensions }
    }
    schemas[name] = {
      type: "object",
      additionalProperties: true,
      ...(required.length > 0 ? { required } : {}),
      properties,
      ...(typeof schema.title === "string" ? { title: schema.title } : {}),
    }
  }
  const used = new Set<string>()
  const pending = new Set<string>()
  collectRefs(paths, pending)
  for (const name of pending) {
    if (used.has(name)) continue
    const schema = schemas[name]
    if (!schema) continue
    used.add(name)
    collectRefs(schema, pending)
  }
  for (const name of Object.keys(schemas)) if (!used.has(name)) delete schemas[name]
  addClientSurfaces(paths)

  const document = {
    openapi: "3.1.0",
    info: {
      title: "Stripe API (Mockingbird subset)",
      version: String(info.version),
      "x-mockingbird-upstream": { ...UPSTREAM, url: `https://github.com/${UPSTREAM.repository}` },
    },
    servers: [{ url: "https://api.stripe.com/" }],
    security: [{ bearerAuth: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
    },
  }
  const yaml = `# Generated by scripts/vendor.ts from ${UPSTREAM.repository}@${UPSTREAM.commit} (${UPSTREAM.file}). Do not edit by hand.\n${stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })}`
  await writeFile(outputPath, yaml)
  console.log(
    `wrote ${outputPath} (${Object.keys(paths).length} paths, ${Object.keys(schemas).length} schemas, api version ${String(info.version)})`,
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
