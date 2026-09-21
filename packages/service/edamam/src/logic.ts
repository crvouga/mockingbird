import { opaqueToken } from "@crvouga/mockingbird-service"
import {
  type Food,
  MEASURE_URI,
  type Measure,
  NUTRIENTS,
  type NutrientCode,
  RECIPE_URI,
  type RecipeSeed,
} from "./corpus.js"

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits
const CODES = Object.keys(NUTRIENTS) as NutrientCode[]

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  half: 0.5,
}

const MEASURE_ALIASES: Record<string, string> = {
  g: "gram",
  gr: "gram",
  grams: "gram",
  oz: "ounce",
  lb: "pound",
  lbs: "pound",
  kg: "kilogram",
  tbsp: "tablespoon",
  tbs: "tablespoon",
  tsp: "teaspoon",
  whole: "whole",
  fillets: "fillet",
}

const STOP = new Set(["of", "and", "with", "the", "fresh", "cooked", "raw", "sliced"])

/** Lower-case, singular tokens: "Large Eggs," → ["large", "egg"]. */
export const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9./ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith("ies") ? `${t.slice(0, -3)}y` : t))
    .map((t) => (t.length > 3 && /(ch|sh|s|x)es$/.test(t) ? t.slice(0, -2) : t))
    .map((t) => (t.length > 2 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t))

const quantityOf = (token: string | undefined): number | undefined => {
  if (!token) return undefined
  if (token in WORD_NUMBERS) return WORD_NUMBERS[token]
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token)
  const fraction = /^(\d+)\/(\d+)$/.exec(token)
  if (fraction) return Number(fraction[1]) / Number(fraction[2])
  return undefined
}

const foodTokens = (food: Food) => [tokens(food.label), tokens(food.knownAs)]

export type ParsedLine = { food: Food; quantity?: number; measure?: Measure } | undefined

/**
 * Parse an ingredient line the way Edamam's NLP does for our purposes: a leading quantity
 * ("2", "1/2", "1 1/2", "a", "two"), an optional measure the food has ("cup", "large", "g"),
 * and the food whose label (or known-as name) appears in the rest.
 */
export const parseLine = (text: string, foods: readonly Food[]): ParsedLine => {
  const words = tokens(text)
  let index = 0
  let quantity: number | undefined
  const first = quantityOf(words[0])
  if (first !== undefined) {
    quantity = first
    index = 1
    const second = quantityOf(words[1])
    if (second !== undefined && second < 1 && words[1]?.includes("/")) {
      quantity += second
      index = 2
    }
  }
  const rest = words.slice(index).filter((w) => !STOP.has(w))
  let best: { food: Food; score: number } | undefined
  for (const food of foods) {
    for (const candidate of foodTokens(food)) {
      if (candidate.length > 0 && candidate.every((t) => rest.includes(t))) {
        if (!best || candidate.length > best.score) best = { food, score: candidate.length }
      }
    }
  }
  if (!best) return undefined
  const food = best.food
  const labelTokens = new Set(foodTokens(food).flat())
  const measureWord = rest.find((w) => !labelTokens.has(w))
  const wanted = measureWord ? (MEASURE_ALIASES[measureWord] ?? measureWord) : undefined
  const explicit = wanted
    ? food.measures.find(
        (m) => tokens(m.label).join(" ") === wanted || m.label.toLowerCase() === wanted,
      )
    : undefined
  if (quantity === undefined && !explicit) return { food }
  const fallback =
    food.measures.find((m) => m.label === "Whole") ??
    food.measures.find((m) => m.label === "Serving")
  const measure = explicit ?? fallback
  return { food, quantity: quantity ?? 1, ...(measure ? { measure } : {}) }
}

/** Foods sharing a significant token with the query (the parser's `hints`). */
export const relatedFoods = (text: string, foods: readonly Food[]): Food[] => {
  const words = new Set(tokens(text).filter((w) => !STOP.has(w) && quantityOf(w) === undefined))
  return foods.filter((food) =>
    foodTokens(food)
      .flat()
      .some((t) => words.has(t)),
  )
}

/** Parse Edamam range syntax: `MIN-MAX`, `MIN+`, or `MAX`. */
export const parseRange = (value: string): { min: number; max: number } | undefined => {
  const both = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(value)
  if (both) return { min: Number(both[1]), max: Number(both[2]) }
  const plus = /^(\d+(?:\.\d+)?)\+$/.exec(value)
  if (plus) return { min: Number(plus[1]), max: Number.POSITIVE_INFINITY }
  if (/^\d+(\.\d+)?$/.test(value)) return { min: 0, max: Number(value) }
  return undefined
}

/** The food object as Edamam returns it (internal fields stripped). */
export const publicFood = (food: Food) => ({
  foodId: food.foodId,
  label: food.label,
  knownAs: food.knownAs,
  nutrients: food.nutrients,
  ...(food.brand ? { brand: food.brand } : {}),
  category: food.category,
  categoryLabel: food.categoryLabel,
  ...(food.foodContentsLabel ? { foodContentsLabel: food.foodContentsLabel } : {}),
  image: food.image,
  ...(food.servingSizes ? { servingSizes: food.servingSizes } : {}),
})

type NutrientMap = Record<string, { label: string; quantity: number; unit: string }>

export const nutrientMap = (totals: Partial<Record<NutrientCode, number>>): NutrientMap =>
  Object.fromEntries(
    CODES.filter((code) => totals[code] !== undefined).map((code) => [
      code,
      {
        label: NUTRIENTS[code].label,
        quantity: round(totals[code] ?? 0),
        unit: NUTRIENTS[code].unit,
      },
    ]),
  )

const dailyMap = (totals: Partial<Record<NutrientCode, number>>): NutrientMap =>
  Object.fromEntries(
    CODES.filter((code) => totals[code] !== undefined && code !== "SUGAR").map((code) => [
      code,
      {
        label: NUTRIENTS[code].label,
        quantity: round(((totals[code] ?? 0) / NUTRIENTS[code].daily) * 100),
        unit: "%",
      },
    ]),
  )

const scaled = (food: Food, grams: number) =>
  Object.fromEntries(
    Object.entries(food.nutrients).map(([code, per100]) => [code, ((per100 ?? 0) * grams) / 100]),
  ) as Partial<Record<NutrientCode, number>>

const add = (
  a: Partial<Record<NutrientCode, number>>,
  b: Partial<Record<NutrientCode, number>>,
) => {
  const out = { ...a }
  for (const code of CODES) {
    if (b[code] !== undefined) out[code] = (out[code] ?? 0) + (b[code] ?? 0)
  }
  return out
}

const dietLabels = (totals: Partial<Record<NutrientCode, number>>) => {
  const kcal = totals.ENERC_KCAL ?? 0
  if (kcal <= 0) return []
  const labels: string[] = []
  if (((totals.PROCNT ?? 0) * 4) / kcal >= 0.3) labels.push("HIGH_PROTEIN")
  if (((totals.CHOCDF ?? 0) * 4) / kcal <= 0.2) labels.push("LOW_CARB")
  if ((totals.FIBTG ?? 0) >= 5) labels.push("HIGH_FIBER")
  return labels.length > 0 ? labels : ["BALANCED"]
}

export type Portion = { food: Food; quantity: number; measure: Measure; text?: string }

/** The Nutrition Analysis / Food Database `nutrients` body for a set of portions. */
export const analysis = (portions: Portion[], opts: { yield?: number; seed: string }) => {
  let totals: Partial<Record<NutrientCode, number>> = {}
  let weight = 0
  const ingredients = portions.map((p) => {
    const grams = p.quantity * p.measure.weight
    weight += grams
    const nutrients = scaled(p.food, grams)
    totals = add(totals, nutrients)
    return {
      ...(p.text !== undefined ? { text: p.text } : {}),
      parsed: [
        {
          quantity: p.quantity,
          measure: p.measure.label.toLowerCase(),
          foodMatch: p.food.knownAs,
          food: p.food.knownAs,
          foodId: p.food.foodId,
          weight: round(grams),
          retainedWeight: round(grams),
          nutrients: nutrientMap(nutrients),
          measureURI: p.measure.uri,
          status: "OK",
        },
      ],
    }
  })
  const health =
    portions.length === 0
      ? []
      : portions
          .map((p) => p.food.healthLabels)
          .reduce((acc, labels) => acc.filter((l) => labels.includes(l)))
  return {
    uri: `http://www.edamam.com/ontologies/edamam.owl#${opaqueToken(opts.seed, 24)}`,
    ...(opts.yield !== undefined ? { yield: opts.yield } : {}),
    calories: Math.round(totals.ENERC_KCAL ?? 0),
    totalWeight: round(weight),
    dietLabels: dietLabels(totals),
    healthLabels: health,
    cautions: [] as string[],
    totalNutrients: nutrientMap(totals),
    totalDaily: dailyMap(totals),
    ingredients,
  }
}

export type Recipe = ReturnType<typeof buildRecipe>

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())

/** A recipe in Recipe Search v2's shape, with totals computed from the food corpus. */
export const buildRecipe = (seed: RecipeSeed, foods: readonly Food[]) => {
  let totals: Partial<Record<NutrientCode, number>> = {}
  let weight = 0
  const ingredients = seed.ingredients.map((i) => {
    const food = foods.find((f) => f.foodId === i.foodId)
    const measure = food?.measures.find((mm) => mm.label === i.measure)
    const grams = i.quantity * (measure?.weight ?? 100)
    weight += grams
    if (food) totals = add(totals, scaled(food, grams))
    return {
      text: i.text,
      quantity: i.quantity,
      measure: i.measure.toLowerCase(),
      food: food?.knownAs ?? i.foodId,
      weight: round(grams),
      foodCategory: food?.category.toLowerCase() ?? null,
      foodId: i.foodId,
      image: food?.image ?? null,
    }
  })
  const slug = seed.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return {
    uri: `${RECIPE_URI}${seed.id}`,
    label: seed.label,
    image: `https://edamam-product-images.s3.amazonaws.com/web-img/${seed.id}.jpg`,
    source: "Mockingbird Kitchen",
    url: `https://kitchen.mockingbird.dev/recipes/${slug}`,
    shareAs: `http://www.edamam.com/recipe/${slug}/${seed.id}`,
    yield: seed.yield,
    dietLabels: seed.dietLabels,
    healthLabels: seed.healthLabels.map((l) => titleCase(l.toLowerCase().replace(/_/g, "-"))),
    cautions: seed.cautions,
    ingredientLines: seed.ingredients.map((i) => i.text),
    ingredients,
    calories: round(totals.ENERC_KCAL ?? 0),
    totalWeight: round(weight),
    totalTime: seed.totalTime,
    cuisineType: seed.cuisineType,
    mealType: seed.mealType,
    dishType: seed.dishType,
    totalNutrients: nutrientMap(totals),
    totalDaily: dailyMap(totals),
  }
}

/** Per-serving value of a nutrient code (or calories) of a built recipe. */
export const perServing = (recipe: Recipe, code: NutrientCode) =>
  (recipe.totalNutrients[code]?.quantity ?? 0) / Math.max(1, recipe.yield)

const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "-")

export type RecipeFilters = {
  q?: string
  health: string[]
  diet: string[]
  mealType: string[]
  dishType: string[]
  cuisineType: string[]
  excluded: string[]
  calories?: { min: number; max: number }
  time?: { min: number; max: number }
  nutrients: Partial<Record<NutrientCode, { min: number; max: number }>>
}

const mealMatches = (recipeMeals: string[], wanted: string) => {
  const w = wanted.toLowerCase()
  return recipeMeals.some((m) => m === w || m.split("/").includes(w) || w.split("/").includes(m))
}

export const matchesFilters = (recipe: Recipe, seed: RecipeSeed, f: RecipeFilters): boolean => {
  if (f.q) {
    const haystack = new Set([
      ...tokens(recipe.label),
      ...recipe.ingredients.flatMap((i) => tokens(i.food)),
    ])
    if (!tokens(f.q).every((t) => haystack.has(t))) return false
  }
  const health = seed.healthLabels.map(norm)
  if (!f.health.every((h) => health.includes(norm(h)))) return false
  const diets = recipe.dietLabels.map(norm)
  if (!f.diet.every((d) => diets.includes(norm(d)))) return false
  if (f.mealType.length > 0 && !f.mealType.some((m) => mealMatches(recipe.mealType, m)))
    return false
  if (f.dishType.length > 0 && !f.dishType.some((d) => recipe.dishType.includes(d.toLowerCase())))
    return false
  if (
    f.cuisineType.length > 0 &&
    !f.cuisineType.some((c) => recipe.cuisineType.includes(c.toLowerCase()))
  )
    return false
  if (f.excluded.some((x) => recipe.ingredients.some((i) => i.food.includes(x.toLowerCase()))))
    return false
  const kcal = perServing(recipe, "ENERC_KCAL")
  if (f.calories && (kcal < f.calories.min || kcal > f.calories.max)) return false
  if (f.time && (recipe.totalTime < f.time.min || recipe.totalTime > f.time.max)) return false
  for (const [code, range] of Object.entries(f.nutrients)) {
    const value = perServing(recipe, code as NutrientCode)
    if (range && (value < range.min || value > range.max)) return false
  }
  return true
}

/** Deterministic shuffle for `random=true`. */
export const shuffle = <T>(items: T[], seed: string): T[] =>
  items
    .map((item, i) => ({ item, key: opaqueToken(`${seed}:${i}`, 8) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((x) => x.item)

export const MEASURE_SERVING = `${MEASURE_URI}serving`
export const MEASURE_GRAM = `${MEASURE_URI}gram`
