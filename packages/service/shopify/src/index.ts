import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  jsonRes,
  type OperationContext,
  type Service,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { execute, type GraphQLError, type OperationDefinitionNode, parse, validate } from "graphql"
import type { Hono } from "hono"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import { type GraphContext, ShopifyGraph, type ShopifyTopic } from "./graph.js"
import { shopifySchema } from "./schema.js"
import { type Settings, ShopifyState } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { ShopifyTopic } from "./graph.js"
export { gid, parseGid, restFulfillment, restOrder, restTopic } from "./graph.js"
export { SHOPIFY_SDL, shopifySchema } from "./schema.js"
export type {
  Address,
  DraftOrderRecord,
  FulfillmentRecord,
  LineItemRecord,
  MetafieldRecord,
  MutationFailure,
  OrderRecord,
  ProductRecord,
  Settings,
  TrackingInfo,
  VariantRecord,
  WebhookSubscriptionRecord,
} from "./state.js"
export { DEFAULT_SETTINGS, ShopifyState } from "./state.js"

export const SHOPIFY_NAMESPACE = "shopify"

/** The header every Admin API request authenticates with. */
export const ACCESS_TOKEN_HEADER = "x-shopify-access-token"

/** The access token a request carries, or `undefined`. */
export const accessTokenOf = (request: Request): string | undefined =>
  request.headers.get(ACCESS_TOKEN_HEADER)?.trim() || undefined

/** The bucket every response reports in `extensions.cost.throttleStatus`. */
export const THROTTLE_STATUS = { maximumAvailable: 2000, restoreRate: 100 } as const

export type ShopifyAPIOptions = APIOptions & {
  settings?: Partial<Settings>
  /** Called for every webhook the store would send; the runtime delivers it. */
  onWebhook?: (topic: ShopifyTopic, body: Record<string, unknown>) => void
  /** Called after webhook subscriptions change. */
  onSubscriptionsChanged?: () => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** ISO-8601 to the second, as Admin GraphQL renders `DateTime`. */
export const shopifyTimestamp = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 19)}Z`

const INVALID_TOKEN = "[API] Invalid API key or access token (unrecognized login or wrong password)"

/**
 * Stateful emulator of the Shopify Admin GraphQL API.
 *
 * `POST /admin/api/{version}/graphql.json` executes any document valid against the subset
 * schema (`SHOPIFY_SDL`) with the reference `graphql` implementation, so selection sets,
 * aliases, fragments, variables and validation errors behave as on Shopify. Mutations report
 * problems in `userErrors`; every response carries `extensions.cost`.
 */
export class ShopifyAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: ShopifyState
  private readonly service: Service
  private readonly now: () => number
  private readonly onWebhook: ShopifyAPIOptions["onWebhook"]
  private readonly onSubscriptionsChanged: ShopifyAPIOptions["onSubscriptionsChanged"]

  constructor(options: ShopifyAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? SHOPIFY_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.onWebhook = options.onWebhook
    this.onSubscriptionsChanged = options.onSubscriptionsChanged
    this.state = new ShopifyState(sqlite, namespace, options.settings)
    this.service = createService({
      document,
      handlers: defineOperations<SupportedOperationId>({
        AdminGraphql: (context) => this.graphql(context),
      }),
      sqlite,
      namespace,
      now: this.now,
      notFound: () => jsonRes(404, { errors: "Not Found" }),
      onError: (error) => {
        throw error
      },
      before: (context) => {
        const token = accessTokenOf(context.request)
        const allowed = this.state.current().accessTokens
        if (!token || (allowed.length > 0 && !allowed.includes(token))) {
          return jsonRes(401, { errors: INVALID_TOKEN })
        }
        return undefined
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  timestamp(): string {
    return shopifyTimestamp(this.now())
  }

  /** Announce a webhook topic (mutations and admin controls call this). */
  emit(topic: ShopifyTopic, body: Record<string, unknown>): void {
    this.onWebhook?.(topic, body)
  }

  private cost(requested: number, actual: number | null, available: number) {
    return {
      cost: {
        requestedQueryCost: requested,
        actualQueryCost: actual,
        throttleStatus: { ...THROTTLE_STATUS, currentlyAvailable: available },
      },
    }
  }

  private throttled(requested: number): Response {
    return jsonRes(200, {
      errors: [
        {
          message: "Throttled",
          extensions: {
            code: "THROTTLED",
            documentation: "https://shopify.dev/api/usage/rate-limits",
          },
        },
      ],
      extensions: this.cost(requested, null, 0),
    })
  }

  private async graphql(context: OperationContext): Promise<Response> {
    const raw = context.body.kind === "json" ? context.body.value : undefined
    if (!isRecord(raw) || typeof raw.query !== "string" || raw.query.trim() === "") {
      return jsonRes(400, { errors: { query: "Required parameter missing or invalid" } })
    }
    const variables = isRecord(raw.variables) ? raw.variables : {}
    const operationName = typeof raw.operationName === "string" ? raw.operationName : undefined
    let ast: ReturnType<typeof parse>
    try {
      ast = parse(raw.query)
    } catch (error) {
      return jsonRes(200, { errors: [(error as GraphQLError).toJSON()] })
    }
    const schema = shopifySchema()
    const invalid = validate(schema, ast)
    if (invalid.length > 0) return jsonRes(200, { errors: invalid.map((e) => e.toJSON()) })
    const operation = ast.definitions.find(
      (d): d is OperationDefinitionNode =>
        d.kind === "OperationDefinition" && (!operationName || d.name?.value === operationName),
    )
    const isMutation = operation?.operation === "mutation"
    // Best guess at Shopify's calculated cost: 10 per mutation field, 1 per query field.
    const rootFields = operation?.selectionSet.selections.length ?? 1
    const requested = rootFields * (isMutation ? 10 : 1)
    if (faultEffect(context.request, "throttled") !== undefined) return this.throttled(requested)
    const graphContext: GraphContext = {
      state: this.state,
      timestamp: () => this.timestamp(),
      apiVersion: context.params.version ?? "unstable",
      emit: (topic, body) => this.emit(topic, body),
      subscriptionsChanged: () => this.onSubscriptionsChanged?.(),
      touched: {},
    }
    if (isMutation) {
      const failure = this.state.takeMutationFailure()
      if (failure?.kind === "throttled") return this.throttled(requested)
      if (failure?.kind === "userErrors") {
        graphContext.injectedUserError = {
          message: failure.message,
          field: failure.field,
          code: failure.code,
        }
      }
    }
    const graph = new ShopifyGraph(graphContext)
    const result = await execute({
      schema,
      document: ast,
      rootValue: { ...graph.root(), ...graph.mutations() },
      variableValues: variables,
      ...(operationName !== undefined ? { operationName } : {}),
    })
    const body: Record<string, unknown> = {}
    if (result.errors && result.errors.length > 0)
      body.errors = result.errors.map((e) => e.toJSON())
    body.data = result.data ?? null
    body.extensions = this.cost(requested, requested, THROTTLE_STATUS.maximumAvailable - requested)
    const ids: Record<string, string> = { ...graphContext.touched }
    if (operation) {
      ids.operation = `${operation.operation}${operation.name ? ` ${operation.name.value}` : ""}`
    }
    return annotateResponse(jsonRes(200, body), { ids })
  }
}

export type { ShopifyRuntime, ShopifyRuntimeOptions } from "./runtime.js"
export { createRuntime, SHOPIFY_PRESETS, signWebhook } from "./runtime.js"
