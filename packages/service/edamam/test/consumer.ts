/**
 * Our Edamam consumers, pointed at a base URL:
 *
 * - `test/upstream/` holds copies of the backend's adapters (`edamam-nutrition.adapter.ts`
 *   with its search/serving-weight/plausibility helpers, and `edamam-meal-planning.adapter.ts`
 *   with its helpers and zod schemas), changed only at the seams (`seams.ts`): the Nest logger
 *   and ConfigService, the hardcoded `https://api.edamam.com`, and the global `fetch`.
 * - `MakorEdamamClient` below is a TypeScript port of the Makor chat service's Python client
 *   (`apps/makor-ecosystem/services/chat/app/tools/nutrition/client.py`): the same endpoints,
 *   params (httpx repeats list params), and status handling (429/402 rate limit, 422, 555,
 *   404, other non-200).
 */
import { EdamamMealPlanningAdapter } from "./upstream/edamam-meal-planning.adapter.js"
import { EdamamNutritionAdapter } from "./upstream/edamam-nutrition.adapter.js"
import { configOf, createLogger, type Fetch, type LoggerService } from "./upstream/seams.js"

export { hashEdamamAccountUser } from "./upstream/edamam-meal-planning.adapter.js"
export type { Fetch } from "./upstream/seams.js"

export const nutritionAdapter = (
  baseUrl: string,
  fetchImpl: Fetch,
  env: Record<string, unknown>,
): { adapter: EdamamNutritionAdapter; logger: LoggerService } => {
  const logger = createLogger()
  return { adapter: new EdamamNutritionAdapter(logger, configOf(env), baseUrl, fetchImpl), logger }
}

export const mealPlanningAdapter = (
  baseUrl: string,
  fetchImpl: Fetch,
  env: Record<string, unknown>,
): { adapter: EdamamMealPlanningAdapter; logger: LoggerService } => {
  const logger = createLogger()
  return {
    adapter: new EdamamMealPlanningAdapter(logger, configOf(env), baseUrl, fetchImpl),
    logger,
  }
}

export class EdamamAPIError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
    readonly isRateLimited = false,
  ) {
    super(message)
  }
}

const RATE_LIMIT_STATUS_CODES = new Set([429, 402])

/** Port of the Makor chat `EdamamClient`. */
export class MakorEdamamClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch,
    private readonly creds: {
      foodAppId?: string
      foodAppKey?: string
      nutritionAppId?: string
      nutritionAppKey?: string
    },
  ) {}

  private url(path: string, params: Record<string, string | string[] | undefined>) {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v)
    }
    return url.toString()
  }

  private async json(response: Response, endpoint: string) {
    const text = await response.text()
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch (error) {
      throw new EdamamAPIError(
        `Invalid JSON response from ${endpoint}: ${String(error)}`,
        response.status,
      )
    }
  }

  async foodSearch(
    query: string,
    options: {
      healthLabels?: string[]
      calorieRange?: string
      category?: string
      nutrientFilters?: Record<string, string>
    } = {},
  ) {
    if (!this.creds.foodAppId || !this.creds.foodAppKey) {
      throw new EdamamAPIError("Food Database API credentials not configured")
    }
    const params: Record<string, string | string[] | undefined> = {
      app_id: this.creds.foodAppId,
      app_key: this.creds.foodAppKey,
      ingr: query,
      "nutrition-type": "logging",
      health: options.healthLabels?.length ? options.healthLabels : undefined,
      calories: options.calorieRange,
      category: options.category,
    }
    for (const [code, value] of Object.entries(options.nutrientFilters ?? {})) {
      params[`nutrients[${code}]`] = value
    }
    const response = await this.fetchImpl(this.url("/api/food-database/v2/parser", params), {
      headers: { Accept: "application/json" },
    })
    if (RATE_LIMIT_STATUS_CODES.has(response.status)) {
      throw new EdamamAPIError("Food Database API rate limit reached", response.status, true)
    }
    if (response.status !== 200) {
      throw new EdamamAPIError(`Food Database API error: ${response.status}`, response.status)
    }
    return this.json(response, "food_search")
  }

  async analyzeIngredient(ingredient: string, nutritionType = "logging") {
    if (!this.creds.nutritionAppId || !this.creds.nutritionAppKey) {
      throw new EdamamAPIError("Nutrition Analysis API credentials not configured")
    }
    const response = await this.fetchImpl(
      this.url("/api/nutrition-data", {
        app_id: this.creds.nutritionAppId,
        app_key: this.creds.nutritionAppKey,
        ingr: ingredient,
        "nutrition-type": nutritionType,
      }),
      { headers: { Accept: "application/json" } },
    )
    if (RATE_LIMIT_STATUS_CODES.has(response.status)) {
      throw new EdamamAPIError("Nutrition Analysis API rate limit reached", response.status, true)
    }
    if (response.status === 422) {
      throw new EdamamAPIError(`Could not parse ingredient: ${ingredient}`, 422)
    }
    if (response.status !== 200) {
      throw new EdamamAPIError(`Nutrition Analysis API error: ${response.status}`, response.status)
    }
    return this.json(response, "analyze_ingredient")
  }

  async analyzeRecipe(ingredients: string[], title?: string, servings?: number) {
    if (!this.creds.nutritionAppId || !this.creds.nutritionAppKey) {
      throw new EdamamAPIError("Nutrition Analysis API credentials not configured")
    }
    const body: Record<string, unknown> = { ingr: ingredients }
    if (title) body.title = title
    if (servings) body.yield = servings
    const response = await this.fetchImpl(
      this.url("/api/nutrition-details", {
        app_id: this.creds.nutritionAppId,
        app_key: this.creds.nutritionAppKey,
      }),
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    )
    if (RATE_LIMIT_STATUS_CODES.has(response.status)) {
      throw new EdamamAPIError("Nutrition Analysis API rate limit reached", response.status, true)
    }
    if (response.status === 422) {
      throw new EdamamAPIError("Could not parse recipe ingredients", 422)
    }
    if (response.status === 555) {
      throw new EdamamAPIError(
        "Recipe quality too low for analysis - try providing more specific ingredients",
        555,
      )
    }
    if (response.status !== 200) {
      throw new EdamamAPIError(`Nutrition Analysis API error: ${response.status}`, response.status)
    }
    return this.json(response, "analyze_recipe")
  }

  async getFoodNutrients(foodId: string, measureUri: string, quantity = 1.0) {
    if (!this.creds.foodAppId || !this.creds.foodAppKey) {
      throw new EdamamAPIError("Food Database API credentials not configured")
    }
    const response = await this.fetchImpl(
      this.url("/api/food-database/v2/nutrients", {
        app_id: this.creds.foodAppId,
        app_key: this.creds.foodAppKey,
      }),
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ingredients: [{ quantity, measureURI: measureUri, foodId }] }),
      },
    )
    if (RATE_LIMIT_STATUS_CODES.has(response.status)) {
      throw new EdamamAPIError("Food Database API rate limit reached", response.status, true)
    }
    if (response.status === 422) {
      throw new EdamamAPIError(`Could not get nutrients for food_id: ${foodId}`, 422)
    }
    if (response.status === 404) throw new EdamamAPIError(`Food not found: ${foodId}`, 404)
    if (response.status !== 200) {
      throw new EdamamAPIError(
        `Food Database nutrients API error: ${response.status}`,
        response.status,
      )
    }
    return this.json(response, "get_food_nutrients")
  }
}
