import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  basicAuth,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { type Food, type NutrientCode, RECIPE_URI, type RecipeSeed } from "./corpus.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  analysis,
  buildRecipe,
  MEASURE_GRAM,
  MEASURE_SERVING,
  matchesFilters,
  type Portion,
  parseLine,
  parseRange,
  perServing,
  publicFood,
  type Recipe,
  type RecipeFilters,
  relatedFoods,
  shuffle,
} from "./logic.js"
import { EdamamState, type Settings } from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { Food, Measure, NutrientCode, RecipeIngredient, RecipeSeed } from "./corpus.js"
export {
  DEFAULT_FOODS,
  DEFAULT_RECIPES,
  MEASURE_URI,
  NUTRIENTS,
  RECIPE_URI,
} from "./corpus.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { buildRecipe, parseLine, perServing } from "./logic.js"
export type { Settings, VisionOverride } from "./state.js"

export const EDAMAM_NAMESPACE = "edamam"
export const ACCOUNT_USER_HEADER = "edamam-account-user"
const PAGE_SIZE = 20

export type EdamamAPIOptions = APIOptions & {
  foods?: readonly Food[]
  recipes?: readonly RecipeSeed[]
  settings?: Partial<Settings>
}

/** Food Database and Nutrition Analysis errors: `{status: "error", error, message}`. */
export const foodError = (status: number, error: string, message: string) =>
  jsonRes(status, { status: "error", error, message })

/** Recipe Search, Meal Planner and Shopping List errors: `[{errorCode, message, params}]`. */
export const recipeErrors = (
  status: number,
  errorCode: string,
  message: string,
  params: string[] = [],
) => jsonRes(status, [{ errorCode, message, params }])

/** The application id a request carries (`app_id` query, else the Basic username). */
export const appIdCredential = (request: Request): string | undefined =>
  new URL(request.url).searchParams.get("app_id") ?? basicAuth(request)?.username ?? undefined

const RECIPE_FAMILY = new Set([
  "RecipeSearch",
  "RecipesByUri",
  "RecipeById",
  "MealPlanSelect",
  "ShoppingList",
])

const many = (url: URL, key: string) => url.searchParams.getAll(key).filter((v) => v.length > 0)

const base64url = (value: string) =>
  toBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

type PlanSection = {
  accept?: { all?: { health?: string[]; meal?: string[]; dish?: string[] }[] }
  fit?: Partial<Record<NutrientCode, { min?: number; max?: number; mark?: number }>>
  exclude?: string[]
  sections?: Record<string, PlanSection>
}

/**
 * Stateful mock of the Edamam APIs our apps call, answering from a per-namespace food and
 * recipe corpus (the built-in one by default; admin routes add rows).
 */
export class EdamamAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: EdamamState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: EdamamAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? EDAMAM_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new EdamamState(sqlite, namespace, {
      foods: options.foods ?? [],
      recipes: options.recipes ?? [],
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      FoodParser: (context) => this.parser(context),
      FoodNutrients: (context) => this.nutrients(context),
      FoodFromImage: (context) => this.vision(context),
      NutritionData: (context) => this.nutritionData(context),
      NutritionDetails: (context) => this.nutritionDetails(context),
      RecipeSearch: (context) => this.recipeSearch(context),
      RecipesByUri: (context) => this.recipesByUri(context),
      RecipeById: (context) => {
        const seed = this.state.recipes.get(context.params.id ?? "")
        if (!seed) return recipeErrors(404, "not_found", `Recipe ${context.params.id} not found`)
        return jsonRes(200, this.hit(this.recipe(seed), context.url.origin))
      },
      MealPlanSelect: (context) => this.mealPlan(context),
      ShoppingList: (context) => this.shoppingList(context),
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => foodError(404, "not_found", "Not Found"),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => this.authenticate(context),
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

  private authenticate(context: OperationContext): Response | undefined {
    const recipeFamily = RECIPE_FAMILY.has(context.operation.operationId)
    const fail = (message: string) =>
      recipeFamily
        ? recipeErrors(401, "unauthorized", message)
        : foodError(401, "unauthorized", message)
    const basic = basicAuth(context.request)
    const appId = context.url.searchParams.get("app_id") ?? basic?.username
    const appKey = context.url.searchParams.get("app_key") ?? basic?.password
    if (!appId || !appKey) return fail("Missing app_id or app_key")
    const apps = this.state.current().apps
    if (apps.length > 0 && !apps.some((a) => a.appId === appId && a.appKey === appKey)) {
      return fail(`Unauthorized app_id = ${appId}. This app_id is not configured for this API.`)
    }
    if (
      recipeFamily &&
      this.state.current().requireAccountUser &&
      !context.request.headers.get(ACCOUNT_USER_HEADER)
    ) {
      return fail("Edamam-Account-User header is required for this application")
    }
    return undefined
  }

  private foods(): Food[] {
    return this.state.allFoods()
  }

  private recipe(seed: RecipeSeed): Recipe {
    return buildRecipe(seed, this.foods())
  }

  private hit(recipe: Recipe, origin: string) {
    const id = recipe.uri.slice(RECIPE_URI.length)
    return {
      recipe,
      _links: { self: { title: "Self", href: `${origin}/api/recipes/v2/${id}?type=public` } },
    }
  }

  private jsonBody(
    context: OperationContext,
    recipeFamily = false,
    invalidStatus = recipeFamily ? 400 : 422,
  ): Record<string, unknown> {
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      const message = `Invalid request body: ${issues.map((i) => `${i.path || "body"} ${i.message}`).join("; ")}`
      throw new HttpError(
        invalidStatus,
        recipeFamily
          ? [{ errorCode: "illegal_param", message, params: issues.map((i) => i.path) }]
          : { status: "error", error: "bad_request", message },
      )
    }
    return context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
  }

  private foodFilter(url: URL): ((food: Food) => boolean) | Response {
    const categoryLabel = url.searchParams.get("categoryLabel")
    const category = url.searchParams.get("category")
    const health = many(url, "health").map((h) => h.toUpperCase().replace(/-/g, "_"))
    const caloriesParam = url.searchParams.get("calories")
    const calories = caloriesParam ? parseRange(caloriesParam) : undefined
    if (caloriesParam && !calories) {
      return foodError(400, "bad_request", `Illegal value for calories: ${caloriesParam}`)
    }
    const categories: Record<string, Food["category"]> = {
      "generic-foods": "Generic foods",
      "packaged-foods": "Packaged foods",
      "generic-meals": "Generic meals",
    }
    return (food) =>
      (!categoryLabel || food.categoryLabel === categoryLabel) &&
      (!category || food.category === categories[category]) &&
      health.every((h) => food.healthLabels.includes(h)) &&
      (!calories ||
        (food.nutrients.ENERC_KCAL !== undefined &&
          food.nutrients.ENERC_KCAL >= calories.min &&
          food.nutrients.ENERC_KCAL <= calories.max))
  }

  private parser(context: OperationContext): Response {
    const url = context.url
    const ingr = url.searchParams.get("ingr")
    const upc = url.searchParams.get("upc")
    const filter = this.foodFilter(url)
    if (filter instanceof Response) return filter
    const foods = this.foods().filter(filter)
    if (upc) {
      const food = this.foods().find((f) => f.upc === upc)
      if (!food) return foodError(404, "not_found", `No food found for UPC ${upc}`)
      return annotateResponse(
        jsonRes(200, {
          text: upc,
          parsed: [],
          hints: [{ food: publicFood(food), measures: food.measures }],
        }),
        { ids: { foodId: food.foodId } },
      )
    }
    if (!ingr) return foodError(400, "bad_request", "Missing required parameter: ingr or upc")
    if (faultEffect(context.request, "parser_schema_drift") !== undefined) {
      return jsonRes(200, { text: ingr, parsed: "unavailable", hints: [] })
    }
    const parsedLine = parseLine(ingr, foods)
    const hints = relatedFoods(ingr, foods)
    const ordered = parsedLine
      ? [parsedLine.food, ...hints.filter((f) => f !== parsedLine.food)]
      : hints
    return jsonRes(200, {
      text: ingr,
      parsed: parsedLine
        ? [
            {
              food: publicFood(parsedLine.food),
              ...(parsedLine.quantity !== undefined ? { quantity: parsedLine.quantity } : {}),
              ...(parsedLine.measure ? { measure: parsedLine.measure } : {}),
            },
          ]
        : [],
      hints: ordered.map((food) => ({ food: publicFood(food), measures: food.measures })),
      _links: {},
    })
  }

  private nutrients(context: OperationContext): Response {
    const body = this.jsonBody(context)
    const lines = body.ingredients as { quantity: number; measureURI: string; foodId: string }[]
    const portions: Portion[] = []
    for (const line of lines) {
      const food = this.state.foods.get(line.foodId)
      const measure = food?.measures.find((m) => m.uri === line.measureURI)
      if (!food || !measure) {
        return foodError(
          422,
          "low_quality",
          `Unknown food ${line.foodId} or measure ${line.measureURI}`,
        )
      }
      portions.push({ food, quantity: line.quantity, measure })
    }
    return jsonRes(200, analysis(portions, { seed: JSON.stringify(lines) }))
  }

  private vision(context: OperationContext): Response {
    const body = this.jsonBody(context, false, 400)
    const image = String(body.image)
    if (!/^(data:image\/[a-z+]+;base64,|https?:\/\/)/.test(image)) {
      return foodError(400, "bad_request", "The image must be a data URL or an http(s) URL")
    }
    const override = this.state.current().vision
    if (
      faultEffect(context.request, "vision_not_found") !== undefined ||
      (override && "notFound" in override)
    ) {
      return jsonRes(200, {})
    }
    const candidates = this.foods().filter(
      (f) => f.categoryLabel === "meal" || f.foodId === "food_salmon",
    )
    const pick =
      override && "foodId" in override
        ? this.state.foods.get(override.foodId)
        : candidates[Number.parseInt(opaqueToken(image, 4), 36) % Math.max(1, candidates.length)]
    if (!pick) return jsonRes(200, {})
    const measure =
      pick.measures.find(
        (m) => m.label === (override && "measure" in override ? override.measure : "Serving"),
      ) ?? pick.measures[0]
    const quantity = override && "quantity" in override && override.quantity ? override.quantity : 1
    const result = analysis(measure ? [{ food: pick, quantity, measure }] : [], { seed: image })
    return jsonRes(200, {
      parsed: { food: publicFood(pick), quantity, ...(measure ? { measure } : {}) },
      recipe: {
        label: pick.label,
        calories: result.calories,
        totalNutrients: result.totalNutrients,
      },
    })
  }

  private portionOf(text: string): Portion | undefined {
    const line = parseLine(text, this.foods())
    if (!line?.measure) {
      if (!line) return undefined
      const measure = line.food.measures.find((m) => m.label === "Serving") ?? line.food.measures[0]
      return measure ? { food: line.food, quantity: 1, measure, text } : undefined
    }
    return { food: line.food, quantity: line.quantity ?? 1, measure: line.measure, text }
  }

  private nutritionData(context: OperationContext): Response {
    const ingr = context.url.searchParams.get("ingr") ?? ""
    const portion = this.portionOf(ingr)
    if (!portion) return foodError(422, "low_quality", `Could not parse ingredient: ${ingr}`)
    return jsonRes(200, analysis([portion], { seed: ingr }))
  }

  private nutritionDetails(context: OperationContext): Response {
    const body = this.jsonBody(context)
    const lines = (body.ingr as string[]) ?? []
    if (lines.length === 0) return foodError(422, "low_quality", "No ingredients to analyse")
    if (faultEffect(context.request, "recipe_quality") !== undefined) {
      return foodError(555, "low_quality", "Recipe with insufficient quality to process correctly")
    }
    const portions = lines.map((line) => this.portionOf(line))
    if (portions.some((p) => p === undefined)) {
      return foodError(555, "low_quality", "Recipe with insufficient quality to process correctly")
    }
    return jsonRes(
      200,
      analysis(portions as Portion[], {
        seed: JSON.stringify(body),
        yield: typeof body.yield === "number" ? body.yield : 1,
      }),
    )
  }

  private recipeFilters(url: URL): RecipeFilters | Response {
    const range = (key: string) => {
      const value = url.searchParams.get(key)
      if (value === null) return undefined
      const parsed = parseRange(value)
      if (!parsed)
        throw new HttpError(400, [
          {
            errorCode: "illegal_param",
            message: `Illegal value for ${key}: ${value}`,
            params: [key],
          },
        ])
      return parsed
    }
    try {
      const nutrients: RecipeFilters["nutrients"] = {}
      for (const code of [
        "ENERC_KCAL",
        "PROCNT",
        "FAT",
        "CHOCDF",
        "FIBTG",
        "SUGAR",
      ] as NutrientCode[]) {
        const r = range(`nutrients[${code}]`)
        if (r) nutrients[code] = r
      }
      const calories = range("calories")
      const time = range("time")
      const q = url.searchParams.get("q")
      return {
        ...(q ? { q } : {}),
        health: many(url, "health"),
        diet: many(url, "diet"),
        mealType: many(url, "mealType"),
        dishType: many(url, "dishType"),
        cuisineType: many(url, "cuisineType"),
        excluded: many(url, "excluded"),
        ...(calories ? { calories } : {}),
        ...(time ? { time } : {}),
        nutrients,
      }
    } catch (error) {
      if (error instanceof HttpError) return error.toResponse()
      throw error
    }
  }

  private recipeSearch(context: OperationContext): Response {
    const url = context.url
    if (!url.searchParams.get("type")) {
      return recipeErrors(400, "illegal_param", "Parameter 'type' is required", ["type"])
    }
    const filters = this.recipeFilters(url)
    if (filters instanceof Response) return filters
    let matches = this.state
      .allRecipes()
      .map((seed) => ({ seed, recipe: this.recipe(seed) }))
      .filter(({ seed, recipe }) => matchesFilters(recipe, seed, filters))
      .map(({ recipe }) => recipe)
    if (url.searchParams.get("random") === "true") matches = shuffle(matches, url.search)
    const cont = url.searchParams.get("_cont")
    let offset = 0
    if (cont) {
      try {
        offset = Number(
          new TextDecoder().decode(fromBase64(cont.replace(/-/g, "+").replace(/_/g, "/"))),
        )
      } catch {
        offset = Number.NaN
      }
      if (!Number.isInteger(offset) || offset < 0) {
        return recipeErrors(400, "illegal_param", "Invalid _cont token", ["_cont"])
      }
    }
    const page = matches.slice(offset, offset + PAGE_SIZE)
    const next = new URL(`${url.origin}${url.pathname}`)
    for (const [key, value] of url.searchParams)
      if (key !== "_cont") next.searchParams.append(key, value)
    next.searchParams.set("_cont", base64url(String(offset + PAGE_SIZE)))
    return jsonRes(200, {
      from: page.length > 0 ? offset + 1 : 0,
      to: offset + page.length,
      count: matches.length,
      _links:
        offset + PAGE_SIZE < matches.length
          ? { next: { href: next.toString(), title: "Next page" } }
          : {},
      hits: page.map((recipe) => this.hit(recipe, url.origin)),
    })
  }

  private recipesByUri(context: OperationContext): Response {
    const url = context.url
    const uris = many(url, "uri")
    if (uris.length === 0 || uris.length > 20) {
      return recipeErrors(400, "illegal_param", "Between 1 and 20 uri parameters are required", [
        "uri",
      ])
    }
    const hits = uris
      .map((uri) =>
        this.state.recipes.get(uri.startsWith(RECIPE_URI) ? uri.slice(RECIPE_URI.length) : uri),
      )
      .filter((seed): seed is RecipeSeed => seed !== undefined)
      .map((seed) => this.hit(this.recipe(seed), url.origin))
    return jsonRes(200, {
      from: hits.length > 0 ? 1 : 0,
      to: hits.length,
      count: hits.length,
      _links: {},
      hits,
    })
  }

  /** Whether a recipe satisfies a plan section's `accept` predicates and per-serving `fit`. */
  private fits(
    recipe: Recipe,
    seed: RecipeSeed,
    section: PlanSection,
    inherited: PlanSection,
  ): boolean {
    const predicates = [...(inherited.accept?.all ?? []), ...(section.accept?.all ?? [])]
    for (const p of predicates) {
      if (
        p.health &&
        !p.health.every((h) => seed.healthLabels.includes(h.toUpperCase().replace(/-/g, "_")))
      )
        return false
      if (p.meal && !p.meal.some((meal) => recipe.mealType.includes(meal.toLowerCase())))
        return false
      if (p.dish && !p.dish.some((dish) => recipe.dishType.includes(dish.toLowerCase())))
        return false
    }
    if ([...(inherited.exclude ?? []), ...(section.exclude ?? [])].includes(recipe.uri))
      return false
    for (const [code, band] of Object.entries(section.fit ?? {})) {
      const value = perServing(recipe, code as NutrientCode)
      if (band?.min !== undefined && value < band.min) return false
      if (band?.max !== undefined && value > band.max) return false
    }
    return true
  }

  private mealPlan(context: OperationContext): Response {
    const url = context.url
    const appId = url.searchParams.get("app_id") ?? basicAuth(context.request)?.username
    if (context.params.app_id !== appId) {
      return recipeErrors(
        401,
        "unauthorized",
        "The app_id in the path does not match the credentials",
      )
    }
    const body = this.jsonBody(context, true)
    const size = Number(body.size)
    const plan = (body.plan ?? {}) as PlanSection
    const sections = plan.sections ?? {}
    if (Object.keys(sections).length === 0) {
      return recipeErrors(400, "illegal_param", "The plan must define at least one section", [
        "plan.sections",
      ])
    }
    if (faultEffect(context.request, "meal_plan_timeout") !== undefined) {
      return jsonRes(200, { status: "TIME_OUT", selection: [] })
    }
    const all = this.state.allRecipes().map((seed) => ({ seed, recipe: this.recipe(seed) }))
    let complete = true
    const selection = Array.from({ length: size }, (_, day) => {
      const used = new Set<string>()
      const out: Record<
        string,
        { assigned?: string; _links?: { self: { title: string; href: string } } }
      > = {}
      let dayTotals = 0
      for (const [name, section] of Object.entries(sections)) {
        const candidates = all.filter(
          ({ seed, recipe }) => !used.has(recipe.uri) && this.fits(recipe, seed, section, plan),
        )
        const chosen = candidates.length > 0 ? candidates[day % candidates.length] : undefined
        if (!chosen) {
          complete = false
          out[name] = {}
          continue
        }
        used.add(chosen.recipe.uri)
        dayTotals += perServing(chosen.recipe, "ENERC_KCAL")
        const id = chosen.recipe.uri.slice(RECIPE_URI.length)
        out[name] = {
          assigned: chosen.recipe.uri,
          _links: {
            self: {
              title: "Recipe details",
              href: `${url.origin}/api/recipes/v2/${id}?type=public`,
            },
          },
        }
      }
      const kcal = plan.fit?.ENERC_KCAL
      if (
        kcal &&
        ((kcal.min !== undefined && dayTotals < kcal.min) ||
          (kcal.max !== undefined && dayTotals > kcal.max))
      ) {
        complete = false
      }
      return { sections: out }
    })
    if (faultEffect(context.request, "meal_plan_incomplete") !== undefined) {
      complete = false
      for (const day of selection) {
        const last = Object.keys(day.sections).at(-1)
        if (last) day.sections[last] = {}
      }
    }
    return jsonRes(200, { status: complete ? "OK" : "INCOMPLETE", selection })
  }

  private shoppingList(context: OperationContext): Response {
    const url = context.url
    const body = this.jsonBody(context, true)
    const entries = body.entries as { quantity: number; measure?: string; item: string }[]
    const totals = new Map<string, { food: string; grams: number }>()
    for (const entry of entries) {
      const id = entry.item.startsWith(RECIPE_URI)
        ? entry.item.slice(RECIPE_URI.length)
        : entry.item
      const seed = this.state.recipes.get(id)
      if (!seed)
        return recipeErrors(400, "not_found", `Unknown recipe ${entry.item}`, ["entries.item"])
      const recipe = this.recipe(seed)
      const factor =
        entry.measure === MEASURE_SERVING
          ? entry.quantity / Math.max(1, recipe.yield)
          : entry.quantity
      for (const ingredient of recipe.ingredients) {
        const current = totals.get(ingredient.foodId) ?? { food: ingredient.food, grams: 0 }
        current.grams += ingredient.weight * factor
        totals.set(ingredient.foodId, current)
      }
    }
    const cart =
      url.searchParams.get("shopping-cart") === "true" && url.searchParams.get("beta") === "true"
    return jsonRes(200, {
      entries: [...totals.entries()].map(([foodId, { food, grams }]) => ({
        foodId,
        food,
        quantities: [
          { quantity: Math.round(grams * 10) / 10, measure: MEASURE_GRAM, qualifiers: [] },
        ],
      })),
      _links: cart
        ? {
            "shopping-cart": {
              title: "Shopping cart",
              href: `${url.origin}/shopping-cart/${opaqueToken(JSON.stringify(entries), 16)}`,
            },
          }
        : {},
    })
  }

  addFood(food: Food): Food {
    this.state.foods.insert(food.foodId, food)
    return food
  }

  addRecipe(seed: RecipeSeed): Recipe {
    this.state.recipes.insert(seed.id, seed)
    return this.recipe(seed)
  }

  recipes(): Recipe[] {
    return this.state.allRecipes().map((seed) => this.recipe(seed))
  }
}

export type { EdamamRuntime, EdamamRuntimeOptions } from "./runtime.js"
export { createRuntime, EDAMAM_PRESETS } from "./runtime.js"
