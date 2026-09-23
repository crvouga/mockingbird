import { createHash } from "node:crypto"
import type { z } from "zod"
import {
  appendRepeatedQuery,
  buildMealPlanRequest,
  buildRecipeSearchQuery,
  buildShoppingListEntries,
  EDAMAM_PUBLIC_RECIPE_TYPE,
  hasValidPlanConstraints,
  hasValidShoppingListInput,
  mapPlanSections,
  mapRecipe,
} from "./edamam-meal-planning.helpers.js"
import {
  edamamMealPlanResponseSchema,
  edamamRecipeSearchResponseSchema,
  edamamShoppingListResponseSchema,
} from "./edamam-meal-planning.schemas.js"
import type {
  BuildShoppingListInput,
  IGroceryFulfillmentPort,
  IMealPlanGeneratorPort,
  IRecipeSearchPort,
  MealPlanConstraints,
  MealPlanUnassignedSlot,
  RecipeSearchCriteria,
} from "./meal-planning.ports.js"
import { type ConfigService, type Fetch, type LoggerService, logStructured } from "./seams.js"

export const EDAMAM_MEAL_PLANNER_SELECT_ENDPOINT = "/api/meal-planner/v1/{app_id}/select"
export const EDAMAM_RECIPE_SEARCH_ENDPOINT = "/api/recipes/v2"
export const EDAMAM_RECIPE_BY_URI_ENDPOINT = "/api/recipes/v2/by-uri"
export const EDAMAM_SHOPPING_LIST_ENDPOINT = "/api/shopping-list/v2"
export const EDAMAM_ACCOUNT_USER_HEADER = "Edamam-Account-User"
export const EDAMAM_RECIPE_TIMEOUT_MS = 10_000
export const EDAMAM_MEAL_PLAN_TIMEOUT_MS = 30_000
export const EDAMAM_SHOPPING_LIST_TIMEOUT_MS = 15_000
export const EDAMAM_ACCOUNT_USER_MAX_LENGTH = 30
export const EDAMAM_SERVING_MEASURE_URI =
  "http://www.edamam.com/ontologies/edamam.owl#Measure_serving"

const EDAMAM_ERROR_DETAIL_MAX_LENGTH = 500

type EdamamCredentials = {
  appId: string
  appKey: string
}

type EdamamAuthMode = "query" | "query_and_basic"

type EdamamHttpResult =
  | { status: "ok"; response: Response }
  | { status: "error"; httpStatus?: number; rateLimited?: boolean }

export function hashEdamamAccountUser(userId: string | number) {
  return createHash("sha256")
    .update(String(userId))
    .digest("hex")
    .slice(0, EDAMAM_ACCOUNT_USER_MAX_LENGTH)
}

export class EdamamMealPlanningAdapter
  implements IRecipeSearchPort, IMealPlanGeneratorPort, IGroceryFulfillmentPort
{
  private readonly appId?: string
  private readonly appKey?: string
  private readonly sendAccountUser: boolean
  private hasWarnedMissingCredentials = false

  // Seam: the app hardcodes EDAMAM_MEAL_BASE_URL and the global fetch.
  constructor(
    private readonly logger: LoggerService,
    config: ConfigService,
    private readonly EDAMAM_MEAL_BASE_URL: string,
    private readonly fetch: Fetch,
  ) {
    this.appId = config.get<string>("EDAMAM_MEAL_APP_ID")?.trim() || undefined
    this.appKey = config.get<string>("EDAMAM_MEAL_APP_KEY")?.trim() || undefined
    this.sendAccountUser = config.get<boolean>("EDAMAM_MEAL_SEND_ACCOUNT_USER") !== false
  }

  async searchRecipes(userId: number, criteria: RecipeSearchCriteria) {
    const credentials = this.getCredentials()
    if (!credentials) return { status: "unavailable" } as const

    try {
      if (criteria.cautionExclusions.length > 0) {
        this.logUnsupportedConstraints("recipe_search", ["cautionExclusions"])
        return { status: "invalid_constraints" } as const
      }
      const endpoint = criteria.nextPageToken ?? EDAMAM_RECIPE_SEARCH_ENDPOINT
      if (criteria.nextPageToken) this.validateNextPageToken(criteria.nextPageToken)
      const query = criteria.nextPageToken ? [] : buildRecipeSearchQuery(criteria)
      const result = await this.request({
        credentials,
        endpoint,
        endpointName: "recipe_search",
        query,
        timeoutMs: EDAMAM_RECIPE_TIMEOUT_MS,
        userId,
      })
      if (result.status === "error") return this.toUnavailableResult(result)

      const payload = await this.parseResponse(
        result.response,
        edamamRecipeSearchResponseSchema,
        "recipe_search",
      )
      if (!payload) return { status: "unavailable" } as const

      const nextPageToken = this.toNextPageToken(payload._links?.next?.href)
      return {
        status: "ok",
        recipes: payload.hits.map(({ recipe }) => mapRecipe(recipe)),
        ...(nextPageToken ? { nextPageToken } : {}),
      } as const
    } catch (error: unknown) {
      this.logRequestError("recipe_search", error)
      return { status: "unavailable" } as const
    }
  }

  async getRecipesByUri(userId: number, uris: string[]) {
    const credentials = this.getCredentials()
    if (!credentials) return { status: "unavailable" } as const

    try {
      if (uris.length === 0) return { status: "not_found" } as const
      const query: Array<[string, string]> = [["type", EDAMAM_PUBLIC_RECIPE_TYPE]]
      appendRepeatedQuery(query, "uri", uris)
      const result = await this.request({
        credentials,
        endpoint: EDAMAM_RECIPE_BY_URI_ENDPOINT,
        endpointName: "recipe_by_uri",
        query,
        timeoutMs: EDAMAM_RECIPE_TIMEOUT_MS,
        userId,
      })
      if (result.status === "error") return this.toUnavailableResult(result)

      const payload = await this.parseResponse(
        result.response,
        edamamRecipeSearchResponseSchema,
        "recipe_by_uri",
      )
      if (!payload) return { status: "unavailable" } as const
      if (payload.hits.length === 0) return { status: "not_found" } as const

      const nextPageToken = this.toNextPageToken(payload._links?.next?.href)
      return {
        status: "ok",
        recipes: payload.hits.map(({ recipe }) => mapRecipe(recipe)),
        ...(nextPageToken ? { nextPageToken } : {}),
      } as const
    } catch (error: unknown) {
      this.logRequestError("recipe_by_uri", error)
      return { status: "unavailable" } as const
    }
  }

  async generatePlan(userId: number, constraints: MealPlanConstraints) {
    const credentials = this.getCredentials()
    if (!credentials) return { status: "unavailable" } as const
    if (!hasValidPlanConstraints(constraints)) {
      logStructured(this.logger, "warn", {
        event: "meal_planning.edamam_invalid_constraints",
        endpoint: "meal_plan_select",
        reason: "invalid_parameters",
      })
      return { status: "invalid_constraints" } as const
    }

    try {
      const endpoint = EDAMAM_MEAL_PLANNER_SELECT_ENDPOINT.replace("{app_id}", credentials.appId)
      const result = await this.request({
        credentials,
        endpoint,
        endpointName: "meal_plan_select",
        query: [["type", EDAMAM_PUBLIC_RECIPE_TYPE]],
        timeoutMs: EDAMAM_MEAL_PLAN_TIMEOUT_MS,
        userId,
        authMode: "query_and_basic",
        method: "POST",
        body: buildMealPlanRequest(constraints),
      })
      if (result.status === "error") {
        if (result.httpStatus === 400) return { status: "invalid_constraints" } as const
        return this.toUnavailableResult(result)
      }

      const payload = await this.parseResponse(
        result.response,
        edamamMealPlanResponseSchema,
        "meal_plan_select",
      )
      if (!payload) return { status: "unavailable" } as const

      const selection = payload.selection ?? []
      if (selection.length === 0) {
        logStructured(this.logger, "warn", {
          event: "meal_planning.edamam_no_selection",
          status: payload.status ?? "missing",
          requestedDayCount: constraints.dayCount,
        })
      }
      const days = []
      const unassignedSlots: MealPlanUnassignedSlot[] = []
      for (const [dayIndex, day] of selection.entries()) {
        const mapped = mapPlanSections(day.sections)
        if (!mapped) {
          logStructured(this.logger, "warn", {
            event: "meal_planning.edamam_unavailable",
            endpoint: "meal_plan_select",
            reason: "schema_validation_failed",
          })
          return { status: "unavailable" } as const
        }
        unassignedSlots.push(...mapped.unassignedSections.map((section) => ({ dayIndex, section })))
        days.push({ dayIndex, sections: mapped.sections })
      }
      const statusByEdamamStatus = {
        OK: "ok",
        INCOMPLETE: "incomplete",
        TIME_OUT: "timeout",
      } as const
      const mappedStatus = payload.status
        ? statusByEdamamStatus[payload.status]
        : selection.length > 0
          ? "ok"
          : "incomplete"

      return {
        status:
          mappedStatus === "ok" && (unassignedSlots.length > 0 || selection.length === 0)
            ? "incomplete"
            : mappedStatus,
        days,
        ...(unassignedSlots.length > 0 ? { unassignedSlots } : {}),
      }
    } catch (error: unknown) {
      this.logRequestError("meal_plan_select", error)
      return { status: "unavailable" } as const
    }
  }

  async buildShoppingList(userId: number, input: BuildShoppingListInput) {
    const credentials = this.getCredentials()
    if (!credentials) return { status: "unavailable" } as const
    if (!hasValidShoppingListInput(input)) {
      logStructured(this.logger, "warn", {
        event: "meal_planning.edamam_unavailable",
        endpoint: "shopping_list",
        reason: "invalid_parameters",
      })
      return { status: "unavailable" } as const
    }

    try {
      const query: Array<[string, string]> = input.cartLink
        ? [
            ["shopping-cart", "true"],
            ["beta", "true"],
          ]
        : []
      const entries = buildShoppingListEntries(input, EDAMAM_SERVING_MEASURE_URI)
      const result = await this.request({
        credentials,
        endpoint: EDAMAM_SHOPPING_LIST_ENDPOINT,
        endpointName: "shopping_list",
        query,
        timeoutMs: EDAMAM_SHOPPING_LIST_TIMEOUT_MS,
        userId,
        authMode: "query_and_basic",
        method: "POST",
        body: { entries },
      })
      if (result.status === "error") return this.toUnavailableResult(result)

      const payload = await this.parseResponse(
        result.response,
        edamamShoppingListResponseSchema,
        "shopping_list",
      )
      if (!payload) return { status: "unavailable" } as const

      const cartUrl = payload._links?.["shopping-cart"]?.href
      if (input.cartLink && !cartUrl) {
        logStructured(this.logger, "warn", {
          event: "meal_planning.edamam_cart_link_missing",
          endpoint: "shopping_list",
        })
      }

      return {
        status: "ok",
        entries: payload.entries.map((entry) => ({
          foodId: entry.foodId,
          food: entry.food,
          quantities: entry.quantities.map((quantity) => ({
            quantity: quantity.quantity,
            measure: quantity.measure,
            qualifiers: quantity.qualifiers ?? [],
          })),
        })),
        ...(cartUrl ? { cartUrl } : {}),
      } as const
    } catch (error: unknown) {
      this.logRequestError("shopping_list", error)
      return { status: "unavailable" } as const
    }
  }

  private getCredentials() {
    if (this.appId && this.appKey) return { appId: this.appId, appKey: this.appKey }
    this.warnMissingCredentialsOnce()
    return null
  }

  private async request(params: {
    credentials: EdamamCredentials
    endpoint: string
    endpointName: string
    query: Array<[string, string]>
    timeoutMs: number
    userId: number
    authMode?: EdamamAuthMode
    method?: "GET" | "POST"
    body?: unknown
  }): Promise<EdamamHttpResult> {
    try {
      if (!Number.isInteger(params.userId) || params.userId <= 0) {
        throw new Error("Invalid Edamam account user context")
      }
      const url = this.createAuthenticatedUrl(params.endpoint, params.credentials, params.query)
      const response = await this.fetch(url, {
        method: params.method ?? "GET",
        headers: {
          ...(this.sendAccountUser
            ? { [EDAMAM_ACCOUNT_USER_HEADER]: hashEdamamAccountUser(params.userId) }
            : {}),
          ...(params.authMode === "query_and_basic"
            ? { Authorization: this.createBasicAuthorization(params.credentials) }
            : {}),
          ...(params.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(params.body !== undefined ? { body: JSON.stringify(params.body) } : {}),
        signal: AbortSignal.timeout(params.timeoutMs),
      })
      if (!response.ok) {
        await this.logUnavailable(params.endpointName, { httpStatus: response.status }, response)
        return {
          status: "error",
          httpStatus: response.status,
          ...(response.status === 429 ? { rateLimited: true } : {}),
        }
      }
      return { status: "ok", response }
    } catch (error: unknown) {
      this.logRequestError(params.endpointName, error)
      return { status: "error" }
    }
  }

  private createAuthenticatedUrl(
    endpoint: string,
    credentials: EdamamCredentials,
    query: Array<[string, string]>,
  ) {
    const url = new URL(endpoint, this.EDAMAM_MEAL_BASE_URL)
    if (url.origin !== new URL(this.EDAMAM_MEAL_BASE_URL).origin)
      throw new Error("Invalid Edamam endpoint origin")
    for (const [key, value] of query) url.searchParams.append(key, value)
    url.searchParams.set("app_id", credentials.appId)
    url.searchParams.set("app_key", credentials.appKey)
    return url
  }

  private createBasicAuthorization(credentials: EdamamCredentials) {
    const encodedCredentials = btoa(`${credentials.appId}:${credentials.appKey}`)
    return `Basic ${encodedCredentials}`
  }

  private validateNextPageToken(nextPageToken: string) {
    const url = new URL(nextPageToken)
    if (
      url.origin !== new URL(this.EDAMAM_MEAL_BASE_URL).origin ||
      url.pathname !== EDAMAM_RECIPE_SEARCH_ENDPOINT
    ) {
      throw new Error("Invalid recipe pagination token")
    }
  }

  private toNextPageToken(href: string | undefined) {
    if (!href) return undefined
    try {
      const url = new URL(href)
      if (
        url.origin !== new URL(this.EDAMAM_MEAL_BASE_URL).origin ||
        url.pathname !== EDAMAM_RECIPE_SEARCH_ENDPOINT
      ) {
        return undefined
      }
      url.searchParams.delete("app_id")
      url.searchParams.delete("app_key")
      return url.toString()
    } catch {
      return undefined
    }
  }

  private async parseResponse<T>(response: Response, schema: z.ZodType<T>, endpoint: string) {
    try {
      const rawPayload: unknown = await response.json()
      const parsed = schema.safeParse(rawPayload)
      if (parsed.success) return parsed.data
      logStructured(this.logger, "warn", {
        event: "meal_planning.edamam_unavailable",
        endpoint,
        reason: "schema_validation_failed",
      })
      return null
    } catch (error: unknown) {
      this.logRequestError(endpoint, error)
      return null
    }
  }

  private toUnavailableResult(result: Extract<EdamamHttpResult, { status: "error" }>) {
    return {
      status: "unavailable",
      ...(result.rateLimited ? { rateLimited: true } : {}),
    } as const
  }

  private async logUnavailable(
    endpoint: string,
    fields: Record<string, unknown>,
    response: Response,
  ) {
    logStructured(this.logger, "warn", {
      event: "meal_planning.edamam_unavailable",
      endpoint,
      ...fields,
      detail: await this.getErrorDetail(response),
    })
  }

  private async getErrorDetail(response: Response) {
    try {
      const text = await response.text()
      return text.slice(0, EDAMAM_ERROR_DETAIL_MAX_LENGTH) || "<empty body>"
    } catch {
      return "<unreadable body>"
    }
  }

  private logRequestError(endpoint: string, error: unknown) {
    logStructured(this.logger, "warn", {
      event: "meal_planning.edamam_unavailable",
      endpoint,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    })
  }

  private logUnsupportedConstraints(endpoint: string, constraints: string[]) {
    logStructured(this.logger, "warn", {
      event: "meal_planning.edamam_unavailable",
      endpoint,
      reason: "unsupported_constraints",
      constraints,
    })
  }

  private warnMissingCredentialsOnce() {
    if (this.hasWarnedMissingCredentials) return
    this.hasWarnedMissingCredentials = true
    logStructured(this.logger, "warn", {
      event: "meal_planning.edamam_credentials_missing",
    })
  }
}
