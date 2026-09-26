import { describe, expect, test } from "bun:test"
import { createRuntime, EDAMAM_PRESETS, MEASURE_URI, RECIPE_URI } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  EdamamAPIError,
  type Fetch,
  mealPlanningAdapter,
  nutritionAdapter,
  PythonEdamamClient,
} from "./test/consumer.js"

const API = "https://api.edamam.mock"
const FOOD_ENV = { EDAMAM_FOOD_APP_ID: "food-app", EDAMAM_FOOD_APP_KEY: "food-key" }
const MEAL_ENV = { EDAMAM_MEAL_APP_ID: "meal-app", EDAMAM_MEAL_APP_KEY: "meal-key" }
const USER = 4242

const noConstraints = {
  healthFilters: [],
  cautionExclusions: [],
  excludedIngredients: [],
  excludedRecipeUris: [],
  nutrientBands: {},
}
const criteria = (extra: Record<string, unknown> = {}) => ({
  healthFilters: [],
  cautionExclusions: [],
  dietFilters: [],
  excludedIngredients: [],
  ...extra,
})

const harness = () => {
  const runtime = createRuntime()
  const requests: Request[] = []
  const fetchImpl: Fetch = (input, init) => {
    const request = new Request(input, init)
    requests.push(request.clone())
    return runtime.fetch(request)
  }
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const nutrition = nutritionAdapter(API, fetchImpl, FOOD_ENV)
  const meals = mealPlanningAdapter(API, fetchImpl, MEAL_ENV)
  const python = new PythonEdamamClient(API, fetchImpl, {
    foodAppId: "food-app",
    foodAppKey: "food-key",
    nutritionAppId: "nutrition-app",
    nutritionAppKey: "nutrition-key",
  })
  return { runtime, requests, fetchImpl, admin, nutrition, meals, python }
}

describe("S25 Edamam acceptance: the backend's nutrition adapter", () => {
  test("without keys every lookup is unavailable and nothing is sent", async () => {
    const { requests, fetchImpl } = harness()
    const { adapter, logger } = nutritionAdapter(API, fetchImpl, {})
    expect(await adapter.searchFoodsByDescription("banana", 5)).toEqual({ status: "unavailable" })
    expect(await adapter.lookupFoodsByBarcode("850000000012")).toEqual({ status: "unavailable" })
    expect(requests).toHaveLength(0)
    expect(logger.events).toEqual([
      { level: "warn", event: "nutrition.edamam_credentials_missing" },
    ])
  })

  test("food search: the parser (categoryLabel=food, nutrition-type=logging) yields ranked foods with serving options", async () => {
    const { nutrition, requests } = harness()
    const result = await nutrition.adapter.searchFoodsByDescription("banana", 5)
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`)
    const banana = result.items[0]
    expect(banana).toMatchObject({
      name: "Banana",
      externalFoodId: "food_banana",
      confidence: "medium",
    })
    expect(banana?.servingOptions?.length).toBeGreaterThan(1)
    const url = new URL(requests[0]?.url as string)
    expect(url.pathname).toBe("/api/food-database/v2/parser")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      app_id: "food-app",
      app_key: "food-key",
      ingr: "banana",
      "nutrition-type": "logging",
      categoryLabel: "food",
    })
    // Meals are filtered out of food search (categoryLabel=food, and our meal filter).
    const salad = await nutrition.adapter.searchFoodsByDescription("chicken salad", 5)
    expect(salad.status === "ok" && salad.items.map((i) => i.name)).not.toContain("Chicken Salad")
    expect(await nutrition.adapter.searchFoodsByDescription("xyzzy", 5)).toEqual({
      status: "not_found",
    })
  })

  test("description analysis: '2 large eggs' → 2 × 50 g of egg at 143 kcal/100 g", async () => {
    const { nutrition } = harness()
    const result = await nutrition.adapter.analyzeFoodsByDescription("2 large eggs", 4, {
      rankingEnabled: false,
    })
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`)
    expect(result.items[0]).toMatchObject({
      name: "Egg",
      quantity: 2,
      servingWeightGrams: 50,
      calories: 143,
      proteinGrams: 13,
    })
    const meal = await nutrition.adapter.analyzeFoodsByDescription("chicken salad", 4, {
      rankingEnabled: true,
    })
    expect(meal.status === "ok" && meal.items[0]).toMatchObject({
      name: "Chicken Salad",
      classificationIngredients: "chicken; mayonnaise; celery; onion",
    })
  })

  test("barcodes: a product, a product without nutrition data, and an unknown UPC", async () => {
    const { nutrition } = harness()
    const bar = await nutrition.adapter.lookupFoodsByBarcode("850000000012")
    expect(bar.status === "ok" && bar.items[0]).toMatchObject({
      name: "Protein Bar",
      brand: "Mockingbird Foods",
      barcode: "850000000012",
      confidence: "high",
      calories: 210,
    })
    expect(await nutrition.adapter.lookupFoodsByBarcode("850000000029")).toEqual({
      status: "no_nutrition_data",
      productLabel: "Mystery Snack",
    })
    // Edamam answers an unknown UPC with 404; our adapter folds every non-2xx into unavailable.
    expect(await nutrition.adapter.lookupFoodsByBarcode("000000000000")).toEqual({
      status: "unavailable",
    })
  })

  test("photo analysis: nutrients-from-image?beta=true, pinned or deterministic, and 'nothing recognised'", async () => {
    const { nutrition, admin, runtime } = harness()
    await admin("/vision", { foodId: "food_salmon", measure: "Fillet" }, "PUT")
    const photo = await nutrition.adapter.analyzeFoodPhoto({
      imageBase64: "/9j/4AAQ",
      imageMimeType: "image/jpeg",
    })
    expect(photo.status === "ok" && photo.items[0]).toMatchObject({
      name: "Salmon",
      servingWeightGrams: 198,
      calories: 412,
    })
    runtime.applyPreset("vision_not_found", "default", { count: 1 })
    expect(
      await nutrition.adapter.analyzeFoodPhoto({
        imageBase64: "/9j/4AAQ",
        imageMimeType: "image/jpeg",
      }),
    ).toEqual({
      status: "not_found",
    })
    const journal = await (await runtime.fetch(new Request(`${API}/__admin/requests`))).json()
    expect(JSON.stringify(journal)).not.toContain("/9j/4AAQ")
  })

  test("failures: rate limit, schema drift, a dropped connection are all unavailable with the reason logged", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["rate_limited", { reason: "http_error", httpStatus: 429 }],
      ["parser_schema_drift", { reason: "schema_validation_failed" }],
      ["connection_drop", { reason: "request_failed" }],
    ]
    for (const [preset, logged] of cases) {
      const { runtime, nutrition } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      expect(await nutrition.adapter.searchFoodsByDescription("banana", 5)).toEqual({
        status: "unavailable",
      })
      expect(nutrition.logger.events.at(-1)).toMatchObject({
        event: "nutrition.edamam_unavailable",
        ...logged,
      })
    }
  })
})

describe("S25 Edamam acceptance: the meal-planning adapter", () => {
  test("recipe search maps hits and sends Edamam-Account-User (the mock can require it)", async () => {
    const { meals, admin, requests } = harness()
    await admin("/settings", { requireAccountUser: true }, "PUT")
    const result = await meals.adapter.searchRecipes(
      USER,
      criteria({ query: "chicken", mealTypes: ["Dinner"] }),
    )
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`)
    expect(result.recipes.map((r) => r.label)).toEqual([
      "Chicken and Rice Bowl",
      "Chicken Salad Plate",
    ])
    const bowl = result.recipes[0]
    expect(bowl?.servings).toBe(2)
    // Per-serving nutrients: our mapper divides totals by the yield.
    expect(bowl?.nutrients.calories?.unit).toBe("kcal")
    expect(requests[0]?.headers.get("edamam-account-user")).toMatch(/^[a-f0-9]{30}$/)
    const filtered = await meals.adapter.searchRecipes(
      USER,
      criteria({ healthFilters: ["vegan"], calorieBand: { max: 400 } }),
    )
    expect(filtered.status === "ok" && filtered.recipes.map((r) => r.label)).toEqual([
      "Apple with Almonds",
    ])
    // Caution exclusions are refused client-side, before any request.
    expect(
      await meals.adapter.searchRecipes(USER, criteria({ cautionExclusions: ["Eggs"] })),
    ).toEqual({
      status: "invalid_constraints",
    })
  })

  test("pagination: _links.next becomes a nextPageToken without the app credentials", async () => {
    const { meals, admin } = harness()
    for (let i = 0; i < 25; i++) {
      await admin("/recipes", {
        id: `toast_${i}`,
        label: `Toast Variation ${i}`,
        yield: 1,
        mealType: ["breakfast"],
        ingredients: [
          { foodId: "food_bread", quantity: 2, measure: "Slice", text: "2 slices bread" },
        ],
      })
    }
    const first = await meals.adapter.searchRecipes(USER, criteria({ query: "toast" }))
    if (first.status !== "ok") throw new Error("expected ok")
    expect(first.recipes).toHaveLength(20)
    expect(first.nextPageToken).toBeDefined()
    expect(first.nextPageToken).not.toContain("app_key")
    const second = await meals.adapter.searchRecipes(
      USER,
      criteria({ nextPageToken: first.nextPageToken as string }),
    )
    expect(second.status === "ok" && second.recipes.length).toBe(6)
    expect(second.status === "ok" && second.nextPageToken).toBeUndefined()
  })

  test("recipes by URI, and an unknown URI", async () => {
    const { meals } = harness()
    const found = await meals.adapter.getRecipesByUri(USER, [
      `${RECIPE_URI}baked_salmon`,
      `${RECIPE_URI}overnight_oats`,
    ])
    expect(found.status === "ok" && found.recipes.map((r) => r.label)).toEqual([
      "Lemon Baked Salmon",
      "Banana Overnight Oats",
    ])
    expect(await meals.adapter.getRecipesByUri(USER, [`${RECIPE_URI}missing`])).toEqual({
      status: "not_found",
    })
  })

  test("meal plans: sections filled per day, an impossible section is incomplete, a timeout maps to timeout", async () => {
    const { meals, runtime, requests } = harness()
    const constraints = {
      ...noConstraints,
      dayCount: 3,
      sections: {
        breakfast: { ...noConstraints, mealTypes: ["breakfast"] },
        lunch: { ...noConstraints, mealTypes: ["lunch/dinner"] },
        dinner: { ...noConstraints, mealTypes: ["lunch/dinner"] },
      },
    }
    const plan = await meals.adapter.generatePlan(USER, constraints)
    expect(plan.status).toBe("ok")
    if (!("days" in plan)) throw new Error("expected days")
    expect(plan.days).toHaveLength(3)
    for (const day of plan.days) {
      expect(Object.keys(day.sections).sort()).toEqual(["breakfast", "dinner", "lunch"])
      expect(day.sections.lunch?.recipeUri).not.toBe(day.sections.dinner?.recipeUri)
    }
    const select = requests.find((r) => r.url.includes("/select"))
    expect(select?.headers.get("authorization")).toBe(`Basic ${btoa("meal-app:meal-key")}`)
    expect(new URL(select?.url as string).pathname).toBe("/api/meal-planner/v1/meal-app/select")

    const impossible = await meals.adapter.generatePlan(USER, {
      ...constraints,
      sections: {
        ...constraints.sections,
        dinner: { ...noConstraints, nutrientBands: { calories: { min: 5000 } } },
      },
    })
    expect(impossible.status).toBe("incomplete")
    expect(
      "unassignedSlots" in impossible && impossible.unassignedSlots?.map((s) => s.section),
    ).toEqual(["dinner", "dinner", "dinner"])
    runtime.applyPreset("meal_plan_timeout", "default", { count: 1 })
    expect((await meals.adapter.generatePlan(USER, constraints)).status).toBe("timeout")
    // Out-of-range day counts never reach Edamam; a plan Edamam rejects (400) is invalid too.
    expect(await meals.adapter.generatePlan(USER, { ...constraints, dayCount: 0 })).toEqual({
      status: "invalid_constraints",
    })
    expect(await meals.adapter.generatePlan(USER, { ...constraints, sections: {} })).toEqual({
      status: "invalid_constraints",
    })
  })

  test("shopping lists aggregate ingredients, scale by servings, and carry a cart link on request", async () => {
    const { meals } = harness()
    const list = await meals.adapter.buildShoppingList(USER, {
      recipes: [
        { recipeUri: `${RECIPE_URI}chicken_rice_bowl`, quantity: 1, scaleByServings: false },
        { recipeUri: `${RECIPE_URI}baked_salmon`, quantity: 1, scaleByServings: true },
      ],
      cartLink: true,
    })
    if (list.status !== "ok") throw new Error("expected ok")
    const spinach = list.entries.find((e) => e.foodId === "food_spinach")
    // 2 cups (60 g) from the bowl + half of the salmon's 2 cups (30 g).
    expect(spinach?.quantities[0]).toEqual({
      quantity: 90,
      measure: `${MEASURE_URI}gram`,
      qualifiers: [],
    })
    expect(list.cartUrl).toMatch(/\/shopping-cart\//)
  })

  test("a rate limit is unavailable with rateLimited: true", async () => {
    const { meals, runtime } = harness()
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    expect(await meals.adapter.searchRecipes(USER, criteria({ query: "salmon" }))).toEqual({
      status: "unavailable",
      rateLimited: true,
    })
  })
})

describe("S25 Edamam acceptance: the Python chat client", () => {
  test("food search, ingredient and recipe analysis, food nutrients", async () => {
    const { python, requests } = harness()
    const search = await python.foodSearch("greek yogurt", {
      healthLabels: ["vegetarian", "gluten-free"],
      category: "generic-foods",
    })
    expect((search.parsed as { food: { label: string } }[])[0]?.food.label).toBe("Greek Yogurt")
    expect(new URL(requests[0]?.url as string).searchParams.getAll("health")).toEqual([
      "vegetarian",
      "gluten-free",
    ])
    const rice = await python.analyzeIngredient("1 cup cooked rice")
    expect(rice.calories).toBe(205)
    await expect(python.analyzeIngredient("xyzzy")).rejects.toMatchObject({ statusCode: 422 })
    const recipe = await python.analyzeRecipe(["2 large eggs", "1 slice bread"], "Breakfast", 1)
    expect(recipe.calories).toBe(Math.round(143 + 247 * 0.32))
    await expect(python.analyzeRecipe(["2 large eggs", "xyzzy"])).rejects.toMatchObject({
      statusCode: 555,
    })
    const nutrients = await python.getFoodNutrients("food_banana", `${MEASURE_URI}unit`, 2)
    expect(nutrients.calories).toBe(210)
    await expect(python.getFoodNutrients("food_nope", `${MEASURE_URI}unit`)).rejects.toMatchObject({
      statusCode: 422,
    })
  })

  test("402 and 429 are rate limits for the Python client", async () => {
    for (const preset of ["payment_required", "rate_limited"]) {
      const { python, runtime } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      const error = await python.foodSearch("banana").catch((e: unknown) => e)
      expect(error).toBeInstanceOf(EdamamAPIError)
      expect((error as EdamamAPIError).isRateLimited).toBe(true)
    }
    const { python, runtime } = harness()
    runtime.applyPreset("recipe_quality", "default", { count: 1 })
    await expect(python.analyzeRecipe(["2 large eggs"])).rejects.toMatchObject({ statusCode: 555 })
  })
})

describe("contract", () => {
  test("namespaces by app_id, header and /ns/ prefix; restricted apps; presets registered", async () => {
    const { runtime, admin, fetchImpl } = harness()
    await admin("/credentials", { credentials: { "app-a": "a" } }, "PUT")
    await admin("/recipes?namespace=a", {
      id: "only_in_a",
      label: "Namespace Salmon",
      ingredients: [{ foodId: "food_salmon", quantity: 1, measure: "Fillet", text: "1 fillet" }],
    })
    const search = (env: Record<string, unknown>, base = API) =>
      mealPlanningAdapter(base, fetchImpl, env).adapter.getRecipesByUri(USER, [
        `${RECIPE_URI}only_in_a`,
      ])
    expect((await search({ EDAMAM_MEAL_APP_ID: "app-a", EDAMAM_MEAL_APP_KEY: "k" })).status).toBe(
      "ok",
    )
    expect((await search(MEAL_ENV)).status).toBe("not_found")
    // The meal adapter resolves endpoints with `new URL(endpoint, base)`, which drops a path
    // prefix: map its app_id instead. The nutrition adapter concatenates, so /ns/ works there.
    await admin("/vision?namespace=a", { foodId: "food_avocado" }, "PUT")
    const photo = await nutritionAdapter(
      `${API}/ns/a`,
      fetchImpl,
      FOOD_ENV,
    ).adapter.analyzeFoodPhoto({
      imageBase64: "AAAA",
      imageMimeType: "image/png",
    })
    expect(photo.status === "ok" && photo.items[0]?.name).toBe("Avocado")
    const viaHeader = await runtime.fetch(
      new Request(`${API}/api/recipes/v2/only_in_a?type=public&app_id=x&app_key=y`, {
        headers: { "x-mockingbird-namespace": "a" },
      }),
    )
    expect(viaHeader.status).toBe(200)
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/^edamam@.*; ns=a$/)
    await admin("/settings", { apps: [{ appId: "food-app", appKey: "food-key" }] }, "PUT")
    const wrong = await runtime.fetch(
      new Request(`${API}/api/food-database/v2/parser?ingr=egg&app_id=food-app&app_key=nope`),
    )
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({ status: "error", error: "unauthorized" })
    expect(Object.keys(EDAMAM_PRESETS)).toEqual(
      expect.arrayContaining([
        "rate_limited",
        "payment_required",
        "meal_plan_timeout",
        "recipe_quality",
      ]),
    )
  })
})

describe("served over HTTP", () => {
  test("the nutrition adapter and the meal planner work against the node server", async () => {
    const server = await createServer()
    try {
      const fetchImpl: Fetch = (input, init) => fetch(input, init)
      const food = await nutritionAdapter(
        server.url,
        fetchImpl,
        FOOD_ENV,
      ).adapter.analyzeFoodsByDescription("1 banana", 4, { rankingEnabled: true })
      expect(food.status === "ok" && food.items[0]?.name).toBe("Banana")
      const recipes = await mealPlanningAdapter(
        server.url,
        fetchImpl,
        MEAL_ENV,
      ).adapter.searchRecipes(USER, criteria({ query: "salmon" }))
      expect(recipes.status === "ok" && recipes.recipes[0]?.label).toBe("Lemon Baked Salmon")
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^edamam@/)
    } finally {
      await server.close()
    }
  })
})
