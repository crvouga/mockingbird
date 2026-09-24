import {
  type AdminRoutes,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type FaultRule,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Food, RecipeSeed } from "./corpus.js"
import { document } from "./generated/openapi.js"
import { appIdCredential, EDAMAM_NAMESPACE, EdamamAPI } from "./index.js"
import type { Settings } from "./state.js"

const FOOD_PREFIXES = ["/api/food-database", "/api/nutrition-data", "/api/nutrition-details"]
const RECIPE_PREFIXES = ["/api/recipes", "/api/meal-planner", "/api/shopping-list"]

/** One rule per API family, each with that family's error shape. */
const everywhere = (status: number, error: string, message: string): Omit<FaultRule, "id">[] => [
  ...FOOD_PREFIXES.map((pathPrefix) => ({
    pathPrefix,
    status,
    body: { status: "error", error, message },
  })),
  ...RECIPE_PREFIXES.map((pathPrefix) => ({
    pathPrefix,
    status,
    body: [{ errorCode: error, message, params: [] }],
  })),
]

/**
 * Every Edamam failure our adapters branch on, switched on with
 * `POST /__admin/faults {"preset": "<name>"}` (add `count` to limit it).
 */
export const EDAMAM_PRESETS: Record<string, FaultPreset> = {
  rate_limited: {
    description:
      "Every API answers 429 Usage limits are exceeded (the meal adapter flags rateLimited)",
    rules: everywhere(429, "usage_limits", "Usage limits are exceeded"),
  },
  payment_required: {
    description:
      "Every API answers 402 (plan quota exhausted; the Python chat client treats it as a rate limit)",
    rules: everywhere(402, "payment_required", "Payment required: plan limits reached"),
  },
  unauthorized: {
    description: "Every API answers 401 (keys revoked)",
    rules: everywhere(401, "unauthorized", "Unauthorized app_id"),
  },
  server_error: {
    description: "Every API answers 500",
    rules: everywhere(500, "internal_error", "Internal server error"),
  },
  parser_schema_drift: {
    description: "The food parser answers `parsed` as a string (our zod schema rejects it)",
    rules: [{ operationId: "FoodParser", effect: "parser_schema_drift" }],
  },
  recipe_quality: {
    description: "nutrition-details answers 555 Recipe with insufficient quality",
    rules: [{ operationId: "NutritionDetails", effect: "recipe_quality" }],
  },
  vision_not_found: {
    description: "nutrients-from-image recognises nothing (an empty object)",
    rules: [{ operationId: "FoodFromImage", effect: "vision_not_found" }],
  },
  meal_plan_incomplete: {
    description: "The meal planner leaves each day's last section unassigned (status INCOMPLETE)",
    rules: [{ operationId: "MealPlanSelect", effect: "meal_plan_incomplete" }],
  },
  meal_plan_timeout: {
    description: "The meal planner answers status TIME_OUT with no selection",
    rules: [{ operationId: "MealPlanSelect", effect: "meal_plan_timeout" }],
  },
  slow: {
    description: "Every call answers after 12 s (past our 10 s parser and recipe timeouts)",
    rules: [...FOOD_PREFIXES, ...RECIPE_PREFIXES].map((pathPrefix) => ({
      pathPrefix,
      latencyMs: 12_000,
    })),
  },
  connection_drop: {
    description: "The connection drops before any answer (fetch rejects)",
    rules: [...FOOD_PREFIXES, ...RECIPE_PREFIXES].map((pathPrefix) => ({ pathPrefix, drop: true })),
  },
}

export type EdamamRuntimeOptions = {
  sqlite?: SqliteClient
  clock?: Clock
  seed?: number | string
  adminKey?: string
  onLog?: (entry: RequestLog) => void
  foods?: readonly Food[]
  recipes?: readonly RecipeSeed[]
  settings?: Partial<Settings>
}

export type EdamamRuntime = ServiceRuntime<EdamamAPI>

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const adminError = (status: number, message: string) =>
  json(status, { error: { type: "mockingbird_admin", message } })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const adminRoutes = (runtime: ServiceRuntime<EdamamAPI>): AdminRoutes => ({
  "GET /foods": ({ namespace }) =>
    json(200, { foods: runtime.instance(namespace).state.allFoods() }),
  "POST /foods": ({ body, namespace }) => {
    if (
      !isRecord(body) ||
      typeof body.foodId !== "string" ||
      typeof body.label !== "string" ||
      !Array.isArray(body.measures)
    ) {
      return adminError(
        400,
        "expected a food {foodId, label, nutrients, measures: [{uri, label, weight}], …}",
      )
    }
    const defaults = {
      knownAs: body.label.toLowerCase(),
      nutrients: {},
      category: "Generic foods",
      categoryLabel: "food",
      image: "",
      healthLabels: [],
    }
    const food = { ...defaults, ...body } as unknown as Food
    return json(201, runtime.instance(namespace).addFood(food))
  },
  "GET /recipes": ({ namespace }) => json(200, { recipes: runtime.instance(namespace).recipes() }),
  "POST /recipes": ({ body, namespace }) => {
    if (
      !isRecord(body) ||
      typeof body.id !== "string" ||
      typeof body.label !== "string" ||
      !Array.isArray(body.ingredients)
    ) {
      return adminError(
        400,
        "expected a recipe seed {id, label, yield, ingredients: [{foodId, quantity, measure, text}], …}",
      )
    }
    const defaults = {
      yield: 1,
      totalTime: 0,
      mealType: [],
      dishType: [],
      cuisineType: [],
      dietLabels: [],
      healthLabels: [],
      cautions: [],
    }
    const seed = { ...defaults, ...body } as unknown as RecipeSeed
    return json(201, runtime.instance(namespace).addRecipe(seed))
  },
  "PUT /vision": ({ body, namespace }) => {
    if (body === null) return json(200, runtime.instance(namespace).state.update({ vision: null }))
    if (!isRecord(body) || (typeof body.foodId !== "string" && body.notFound !== true)) {
      return adminError(
        400,
        'expected {"foodId", "quantity"?, "measure"?}, {"notFound": true} or null',
      )
    }
    const vision =
      body.notFound === true
        ? ({ notFound: true } as const)
        : {
            foodId: String(body.foodId),
            ...(typeof body.quantity === "number" ? { quantity: body.quantity } : {}),
            ...(typeof body.measure === "string" ? { measure: body.measure } : {}),
          }
    return json(200, runtime.instance(namespace).state.update({ vision }))
  },
  "GET /settings": ({ namespace }) => json(200, runtime.instance(namespace).state.current()),
  "PUT /settings": ({ body, namespace }) => {
    if (!isRecord(body)) return adminError(400, "expected a JSON object")
    const patch: Partial<Settings> = {}
    if (body.apps !== undefined) {
      if (!Array.isArray(body.apps)) return adminError(400, "apps: [{appId, appKey}]")
      patch.apps = body.apps
        .filter(isRecord)
        .map((a) => ({ appId: String(a.appId), appKey: String(a.appKey) }))
    }
    if (body.requireAccountUser !== undefined) {
      if (typeof body.requireAccountUser !== "boolean")
        return adminError(400, "requireAccountUser: boolean")
      patch.requireAccountUser = body.requireAccountUser
    }
    return json(200, runtime.instance(namespace).state.update(patch))
  },
})

/**
 * The Edamam mock with Mockingbird's full service contract: `/health`, `/__admin/*`,
 * namespaces by header, by `/ns/<name>` path prefix, or by application id
 * (`PUT /__admin/credentials {"credentials": {"<app_id>": "<namespace>"}}`), clock control,
 * fault presets and a request journal.
 */
export const createRuntime = (options: EdamamRuntimeOptions = {}): EdamamRuntime =>
  createServiceRuntime<EdamamAPI>({
    name: EDAMAM_NAMESPACE,
    document,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminKey !== undefined ? { adminKey: options.adminKey } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    credential: appIdCredential,
    presets: EDAMAM_PRESETS,
    create: ({ sqlite, namespace, clock }) =>
      new EdamamAPI({
        sqlite,
        namespace,
        now: clock.now,
        ...(options.foods ? { foods: options.foods } : {}),
        ...(options.recipes ? { recipes: options.recipes } : {}),
        ...(options.settings ? { settings: options.settings } : {}),
      }),
    admin: adminRoutes,
  })
