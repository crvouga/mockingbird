import { describe, expect, test } from "bun:test"
import { createRuntime, MEASURE_URI, RECIPE_URI } from "./src/index.js"
import { createServer } from "./src/server.js"

const API = "https://edamam.example"
const harness = () => {
  const runtime = createRuntime()
  const send = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    headers?: Record<string, string>,
  ) => {
    const url = new URL(path, API)
    if (!url.pathname.startsWith("/__admin/")) {
      if (!url.searchParams.has("app_id")) url.searchParams.set("app_id", "fixture")
      url.searchParams.set("app_key", "example")
    }
    return runtime.fetch(
      new Request(url, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  const admin = (path: string, body?: unknown, method?: string) =>
    send(`/__admin${path}`, body, method)
  return { runtime, send, admin }
}

describe("Edamam API", () => {
  test("the parser returns portions, UPC matches and empty text results", async () => {
    const { send } = harness()
    const parser = (query: string) => send(`/api/food-database/v2/parser?${query}`)
    expect(await (await parser("ingr=2+large+eggs")).json()).toMatchObject({
      parsed: [{ quantity: 2, food: { label: "Egg" }, measure: { weight: 50 } }],
    })
    expect(await (await parser("upc=850000000012")).json()).toMatchObject({
      hints: [{ food: { label: "Protein Bar" } }],
    })
    expect(await (await parser("upc=850000000029")).json()).toMatchObject({
      hints: [{ food: { label: "Mystery Snack" } }],
    })
    expect((await parser("upc=000000000000")).status).toBe(404)
    expect(await (await parser("ingr=xyzzy")).json()).toMatchObject({ parsed: [], hints: [] })
  })

  test("nutrition endpoints scale quantities and report unrecognized ingredients", async () => {
    const { send } = harness()
    expect(await (await send("/api/nutrition-data?ingr=1+cup+cooked+rice")).json()).toMatchObject({
      calories: 205,
    })
    expect((await send("/api/nutrition-data?ingr=xyzzy")).status).toBe(422)
    expect(
      await (
        await send("/api/nutrition-details", { ingr: ["2 large eggs", "1 slice bread"] })
      ).json(),
    ).toMatchObject({ calories: 222 })
    expect((await send("/api/nutrition-details", { ingr: ["2 large eggs", "xyzzy"] })).status).toBe(
      555,
    )
    const nutrients = (foodId: string) =>
      send("/api/food-database/v2/nutrients", {
        ingredients: [{ foodId, quantity: 2, measureURI: `${MEASURE_URI}unit` }],
      })
    expect(await (await nutrients("food_banana")).json()).toMatchObject({ calories: 210 })
    expect((await nutrients("missing")).status).toBe(422)
  })

  test("image recognition uses namespace overrides and redacts the submitted image", async () => {
    const { send, admin, runtime } = harness()
    await admin("/vision?namespace=demo", { foodId: "food_salmon", measure: "Fillet" }, "PUT")
    const photo = () =>
      send(
        "/__admin/ns/demo/api/food-database/nutrients-from-image?beta=true&app_id=fixture&app_key=example",
        { image: "data:image/jpeg;base64,/9j/4AAQ" },
      )
    expect(await (await photo()).json()).toMatchObject({
      recipe: { label: "Salmon", calories: 412 },
    })
    runtime.applyPreset("vision_not_found", "demo", { count: 1 })
    expect(await (await photo()).json()).toEqual({})
    expect(await (await admin("/requests?namespace=demo")).text()).not.toContain("/9j/4AAQ")
  })

  test("food parser faults expose payment, quota, malformed payload and transport failures", async () => {
    const { runtime, send } = harness()
    const parse = () => send("/api/food-database/v2/parser?ingr=banana")
    for (const [name, status] of [
      ["payment_required", 402],
      ["rate_limited", 429],
    ] as const) {
      runtime.applyPreset(name, "default", { count: 1 })
      expect((await parse()).status).toBe(status)
    }
    runtime.applyPreset("parser_schema_drift", "default", { count: 1 })
    expect(await (await parse()).json()).toMatchObject({ parsed: "unavailable" })
    runtime.applyPreset("connection_drop", "default", { count: 1 })
    await expect(parse()).rejects.toThrow()
  })

  test("recipe search can require an account user", async () => {
    const { send, admin } = harness()
    await admin("/settings", { requireAccountUser: true }, "PUT")
    const path = "/api/recipes/v2?type=public&q=salmon"
    expect((await send(path)).status).toBe(401)
    expect(
      (await send(path, undefined, "GET", { "Edamam-Account-User": "sample-user" })).status,
    ).toBe(200)
  })

  test("recipe search supports paging, filters and URI lookup", async () => {
    const { send, admin } = harness()
    for (let i = 0; i < 25; i++)
      await admin("/recipes", {
        id: `sample_${i}`,
        label: `Sample Toast ${i}`,
        yield: 1,
        ingredients: [{ foodId: "food_bread", quantity: 1, measure: "Slice", text: "1 slice" }],
      })
    const first = await (await send("/api/recipes/v2?type=public&q=toast")).json()
    expect(first.hits).toHaveLength(20)
    const second = await (await send(first._links.next.href)).json()
    expect(second.hits).toHaveLength(6)
    expect(second._links.next).toBeUndefined()
    const filtered = await (
      await send("/api/recipes/v2?type=public&health=vegan&calories=0-400")
    ).json()
    expect(filtered.hits).toContainEqual(
      expect.objectContaining({ recipe: expect.objectContaining({ label: "Apple with Almonds" }) }),
    )
    const byUri = (id: string) =>
      send(`/api/recipes/v2/by-uri?type=public&uri=${encodeURIComponent(RECIPE_URI + id)}`)
    expect(await (await byUri("baked_salmon")).json()).toMatchObject({
      hits: [{ recipe: { label: "Lemon Baked Salmon" } }],
    })
    expect(await (await byUri("missing")).json()).toMatchObject({ hits: [] })
  })

  test("meal plans report assigned sections, incomplete days and timeout", async () => {
    const { send, runtime } = harness()
    const plan = (sections: Record<string, unknown>) =>
      send(
        "/api/meal-planner/v1/fixture/select?type=public",
        { size: 3, plan: { sections } },
        "POST",
        { authorization: `Basic ${btoa("fixture:example")}` },
      )
    const complete = await (await plan({ Lunch: {}, Dinner: {} })).json()
    expect(complete.status).toBe("OK")
    expect(complete.selection).toHaveLength(3)
    for (const day of complete.selection) {
      expect(day.sections.Lunch.assigned).toBeString()
      expect(day.sections.Dinner.assigned).not.toBe(day.sections.Lunch.assigned)
    }
    expect(
      await (await plan({ Dinner: { fit: { ENERC_KCAL: { min: 5000 } } } })).json(),
    ).toMatchObject({ status: "INCOMPLETE" })
    runtime.applyPreset("meal_plan_timeout", "default", { count: 1 })
    expect(await (await plan({ Lunch: {} })).json()).toEqual({ status: "TIME_OUT", selection: [] })
    expect((await plan({})).status).toBe(400)
  })

  test("shopping list aggregates ingredients across recipes", async () => {
    const { send } = harness()
    const result = await (
      await send("/api/shopping-list/v2?shopping-cart=true&beta=true", {
        entries: [
          { item: `${RECIPE_URI}chicken_rice_bowl`, quantity: 1, measure: `${MEASURE_URI}serving` },
          { item: `${RECIPE_URI}baked_salmon`, quantity: 0.5, measure: `${MEASURE_URI}serving` },
        ],
      })
    ).json()
    expect(result.entries).toContainEqual(
      expect.objectContaining({
        foodId: "food_spinach",
        quantities: [{ quantity: 45, measure: `${MEASURE_URI}gram`, qualifiers: [] }],
      }),
    )
    expect(result._links["shopping-cart"].href).toContain("/shopping-cart/")
  })

  test("credentials and the namespace header route to isolated catalogs", async () => {
    const { send, admin } = harness()
    await admin("/credentials", { credentials: { "team-app": "team" } }, "PUT")
    await admin("/recipes?namespace=team", {
      id: "private_recipe",
      label: "Sample recipe",
      ingredients: [{ foodId: "food_bread", quantity: 1, measure: "Slice", text: "1 slice" }],
    })
    const path = "/api/recipes/v2/private_recipe?type=public"
    expect((await send(path)).status).toBe(404)
    expect((await send(`${path}&app_id=team-app`)).status).toBe(200)
    expect(
      (await send(path, undefined, "GET", { "x-mockingbird-namespace": "team" })).headers.get(
        "x-mockingbird",
      ),
    ).toMatch(/; ns=team$/)
    await admin("/settings", { apps: [{ appId: "fixture", appKey: "different" }] }, "PUT")
    expect((await send("/api/food-database/v2/parser?ingr=banana")).status).toBe(401)
  })

  test("serves food and recipe lookups over HTTP", async () => {
    const server = await createServer()
    try {
      for (const [path, label] of [
        ["food-database/v2/parser?ingr=banana", "Banana"],
        ["recipes/v2?type=public&q=salmon", "Lemon Baked Salmon"],
      ] as const) {
        const response = await fetch(`${server.url}/api/${path}&app_id=fixture&app_key=example`)
        expect(response.status).toBe(200)
        expect(response.headers.get("x-mockingbird")).toMatch(/^edamam@/)
        expect(await response.text()).toContain(label)
      }
    } finally {
      await server.close()
    }
  })
})
describe("Food Database parser nutrients[CODE] filter (best guess from the issue, not oracle-verified)", () => {
  type ParserBody = {
    parsed: { food: { label: string } }[]
    hints: { food: { label: string; nutrients: Record<string, number> } }[]
  }
  const parser = async (query: string) => {
    const { runtime } = harness()
    const response = await runtime.fetch(
      new Request(`${API}/api/food-database/v2/parser?app_id=fixture&app_key=fixture&${query}`),
    )
    return { response, body: (await response.json()) as ParserBody }
  }
  const labels = (body: ParserBody) => body.hints.map((hint) => hint.food.label)

  test("MIN+ keeps the foods at or above MIN per 100 g", async () => {
    expect(labels((await parser("ingr=chicken")).body)).toEqual(
      expect.arrayContaining(["Chicken Breast", "Chicken Salad"]),
    )
    const { response, body } = await parser("ingr=chicken&nutrients%5BPROCNT%5D=20%2B")
    expect(response.status).toBe(200)
    expect(labels(body)).toContain("Chicken Breast")
    expect(labels(body)).not.toContain("Chicken Salad")
    for (const hint of body.hints) expect(hint.food.nutrients.PROCNT).toBeGreaterThanOrEqual(20)
    // A raw "+" decodes to a space on the wire; it still means "or more".
    expect(labels((await parser("ingr=chicken&nutrients[PROCNT]=20+")).body)).toEqual(labels(body))
  })

  test("MAX keeps foods at or below it and MIN-MAX is inclusive", async () => {
    const low = (await parser("ingr=chicken&nutrients%5BPROCNT%5D=14")).body
    expect(labels(low)).toContain("Chicken Salad")
    expect(labels(low)).not.toContain("Chicken Breast")
    expect(labels((await parser("ingr=chicken&nutrients%5BPROCNT%5D=13.2")).body)).toContain(
      "Chicken Salad",
    )
    const band = (await parser("ingr=chicken&nutrients%5BPROCNT%5D=13.2-31")).body
    expect(labels(band)).toEqual(expect.arrayContaining(["Chicken Breast", "Chicken Salad"]))
    expect(labels((await parser("ingr=chicken&nutrients%5BPROCNT%5D=13.3-30.9")).body)).not.toEqual(
      expect.arrayContaining(["Chicken Breast"]),
    )
  })

  test("several nutrient codes, repeated codes, calories, health and category all must hold", async () => {
    const both = (await parser("ingr=chicken&nutrients[PROCNT]=10%2B&nutrients[FAT]=5")).body
    expect(labels(both)).toContain("Chicken Breast")
    expect(labels(both)).not.toContain("Chicken Salad")
    const repeated = (await parser("ingr=chicken&nutrients[PROCNT]=10%2B&nutrients[PROCNT]=13"))
      .body
    expect(labels(repeated)).toEqual([])
    const withCalories = (
      await parser("ingr=chicken&nutrients[PROCNT]=10%2B&calories=200-300&category=generic-meals")
    ).body
    expect(labels(withCalories)).toContain("Chicken Salad")
    expect(labels(withCalories)).not.toContain("Chicken Breast")
    const withHealth = (await parser("ingr=chicken&nutrients[PROCNT]=10%2B&health=vegan")).body
    expect(labels(withHealth)).toEqual([])
  })

  test("a filter nothing satisfies answers 200 with empty hints and parsed", async () => {
    for (const query of [
      "ingr=chicken&nutrients%5BPROCNT%5D=40%2B",
      "ingr=chicken&nutrients%5BPROCNT%5D=0-5",
      "ingr=chicken&nutrients%5BNA%5D=1%2B",
    ]) {
      const { response, body } = await parser(query)
      expect([query, response.status, body.hints, body.parsed]).toEqual([query, 200, [], []])
    }
  })

  test("a nutrient the corpus carries only on a seeded food matches that food", async () => {
    const { runtime, admin } = harness()
    await admin("/foods", {
      foodId: "food_salty",
      label: "Salty Chicken",
      nutrients: { PROCNT: 1, NA: 900 },
      measures: [{ uri: `${MEASURE_URI}gram`, label: "Gram", weight: 1 }],
    })
    const response = await runtime.fetch(
      new Request(
        `${API}/api/food-database/v2/parser?app_id=x&app_key=y&ingr=chicken&nutrients%5BNA%5D=500%2B`,
      ),
    )
    const body = (await response.json()) as ParserBody
    expect(labels(body)).toEqual(["Salty Chicken"])
  })

  test("a malformed range or code is a 400 bad_request, never silently ignored", async () => {
    for (const query of [
      "ingr=chicken&nutrients%5BPROCNT%5D=lots",
      "ingr=chicken&nutrients%5BPROCNT%5D=",
      "ingr=chicken&nutrients%5BPROCNT%5D=5-1x",
      "ingr=chicken&nutrients%5B%5D=5",
      "ingr=chicken&nutrients%5B%20%5D=5",
    ]) {
      const { response, body } = await parser(query)
      expect([query, response.status]).toEqual([query, 400])
      expect(body).toMatchObject({ status: "error", error: "bad_request" })
    }
  })
})
