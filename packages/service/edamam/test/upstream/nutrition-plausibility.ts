const NUTRITION_REFERENCE_GRAMS = 100
const KCAL_PER_PROTEIN_GRAM = 4
const KCAL_PER_CARB_GRAM = 4
const KCAL_PER_FAT_GRAM = 9
const KCAL_PER_ALCOHOL_GRAM = 7
const MAX_ALCOHOL_GRAMS_PER_100_GRAMS = 40
const MACRO_ENERGY_TOLERANCE_RATIO = 0.4
const MACRO_ENERGY_TOLERANCE_FLOOR_KCAL = 40
const DEFAULT_KCAL_BOUNDS = { minimum: 1, maximum: 900 }
const CATEGORY_KCAL_BOUNDS = new Map<string, { minimum: number; maximum: number }>([
  ["generic foods", { minimum: 1, maximum: 900 }],
  ["generic meals", { minimum: 15, maximum: 500 }],
  ["packaged foods", { minimum: 1, maximum: 900 }],
  ["fast foods", { minimum: 30, maximum: 600 }],
])
const ALCOHOL_EVIDENCE_TOKENS = new Set([
  "absinthe",
  "alcohol",
  "alcoholic",
  "ale",
  "aperol",
  "beer",
  "bourbon",
  "brandy",
  "cabernet",
  "campari",
  "champagne",
  "chardonnay",
  "chianti",
  "cider",
  "cocktail",
  "cognac",
  "daiquiri",
  "ethanol",
  "gin",
  "ipa",
  "lager",
  "liqueur",
  "liquor",
  "malbec",
  "margarita",
  "martini",
  "mead",
  "merlot",
  "mezcal",
  "mojito",
  "moonshine",
  "moscato",
  "negroni",
  "pilsner",
  "pinot",
  "prosecco",
  "riesling",
  "rum",
  "sake",
  "sangria",
  "sauvignon",
  "schnapps",
  "sherry",
  "shiraz",
  "soju",
  "spirit",
  "stout",
  "syrah",
  "tequila",
  "vermouth",
  "vodka",
  "whiskey",
  "whisky",
  "wine",
  "zinfandel",
])
const NON_ALCOHOL_EVIDENCE_PHRASES = [
  "vinegar",
  "non alcoholic",
  "nonalcoholic",
  "alcohol free",
  "alcoholfree",
  "de alcoholized",
  "dealcoholized",
  "alcohol removed",
  "mocktail",
]

type AlcoholTextSignal = "alcoholic" | "non_alcoholic" | "none"

export type NutritionPlausibilityViolation = "kcal_density" | "macro_energy"

export type NutritionDensity = {
  caloriesPer100Grams: number
  proteinGramsPer100Grams: number
  carbGramsPer100Grams: number
  fatGramsPer100Grams: number
  alcoholGramsPer100Grams?: number
  category?: string
  label?: string
  query?: string
}

export type NutritionPlausibilityItem = {
  calories: number
  proteinGrams: number
  carbGrams: number
  fatGrams: number
  quantity?: number
  servingWeightGrams?: number
  category?: string
  name?: string
  relevanceTier?: number
}

function getAlcoholTextSignal(value: string | undefined): AlcoholTextSignal {
  const tokens: string[] = (value ?? "").toLowerCase().match(/[a-z]+/g) ?? []
  if (tokens.length === 0) return "none"

  const paddedPhrase = ` ${tokens.join(" ")} `
  if (NON_ALCOHOL_EVIDENCE_PHRASES.some((phrase) => paddedPhrase.includes(` ${phrase} `))) {
    return "non_alcoholic"
  }
  const hasAlcoholToken = tokens.some(
    (token) =>
      ALCOHOL_EVIDENCE_TOKENS.has(token) ||
      (token.endsWith("s") && ALCOHOL_EVIDENCE_TOKENS.has(token.slice(0, -1))),
  )
  return hasAlcoholToken ? "alcoholic" : "none"
}

function hasAlcoholEvidence(density: NutritionDensity, reportedAlcoholGrams: number) {
  if (reportedAlcoholGrams > 0) return true

  const labelSignal = getAlcoholTextSignal(density.label)
  if (labelSignal !== "none") return labelSignal === "alcoholic"

  const categorySignal = getAlcoholTextSignal(density.category)
  if (categorySignal !== "none") return categorySignal === "alcoholic"

  return getAlcoholTextSignal(density.query) === "alcoholic"
}

export function getNutritionDensityViolation(
  density: NutritionDensity,
): NutritionPlausibilityViolation | null {
  if (!Number.isFinite(density.caloriesPer100Grams)) return "kcal_density"

  const bounds =
    CATEGORY_KCAL_BOUNDS.get((density.category ?? "").trim().toLowerCase()) ?? DEFAULT_KCAL_BOUNDS
  if (
    density.caloriesPer100Grams < bounds.minimum ||
    density.caloriesPer100Grams > bounds.maximum
  ) {
    return "kcal_density"
  }

  const reportedAlcoholGrams =
    density.alcoholGramsPer100Grams != null && density.alcoholGramsPer100Grams > 0
      ? density.alcoholGramsPer100Grams
      : 0
  const macroGrams =
    density.proteinGramsPer100Grams +
    density.carbGramsPer100Grams +
    density.fatGramsPer100Grams +
    reportedAlcoholGrams
  if (!Number.isFinite(macroGrams) || macroGrams <= 0) return null

  const macroEnergy =
    density.proteinGramsPer100Grams * KCAL_PER_PROTEIN_GRAM +
    density.carbGramsPer100Grams * KCAL_PER_CARB_GRAM +
    density.fatGramsPer100Grams * KCAL_PER_FAT_GRAM +
    reportedAlcoholGrams * KCAL_PER_ALCOHOL_GRAM
  const tolerance = Math.max(
    MACRO_ENERGY_TOLERANCE_FLOOR_KCAL,
    density.caloriesPer100Grams * MACRO_ENERGY_TOLERANCE_RATIO,
  )
  const energyShortfall = density.caloriesPer100Grams - macroEnergy
  if (Math.abs(energyShortfall) <= tolerance) return null

  const impliedAlcoholGrams =
    energyShortfall > 0 ? reportedAlcoholGrams + energyShortfall / KCAL_PER_ALCOHOL_GRAM : 0
  if (
    impliedAlcoholGrams > 0 &&
    impliedAlcoholGrams <= MAX_ALCOHOL_GRAMS_PER_100_GRAMS &&
    hasAlcoholEvidence(density, reportedAlcoholGrams)
  ) {
    return null
  }
  return "macro_energy"
}

export function getNutritionItemDensity(
  item: NutritionPlausibilityItem,
  query?: string,
): NutritionDensity {
  const quantity = item.quantity && item.quantity > 0 ? item.quantity : 1
  const servedGrams =
    item.servingWeightGrams && item.servingWeightGrams > 0
      ? quantity * item.servingWeightGrams
      : NUTRITION_REFERENCE_GRAMS
  const densityScale = NUTRITION_REFERENCE_GRAMS / servedGrams
  return {
    caloriesPer100Grams: item.calories * densityScale,
    proteinGramsPer100Grams: item.proteinGrams * densityScale,
    carbGramsPer100Grams: item.carbGrams * densityScale,
    fatGramsPer100Grams: item.fatGrams * densityScale,
    ...(item.category ? { category: item.category } : {}),
    ...(item.name ? { label: item.name } : {}),
    ...(query ? { query } : {}),
  }
}

function getSameRelevanceTierItems<T extends NutritionPlausibilityItem>(items: T[], topItem: T) {
  if (topItem.relevanceTier == null) return items
  return items.filter((item) => item.relevanceTier === topItem.relevanceTier)
}

export function getNutritionItemViolation(
  item: NutritionPlausibilityItem,
  query?: string,
): NutritionPlausibilityViolation | null {
  return getNutritionDensityViolation(getNutritionItemDensity(item, query))
}

export function selectPlausibleNutritionItem<T extends NutritionPlausibilityItem>(
  items: T[],
  query?: string,
): { item: T; violation: NutritionPlausibilityViolation | null } | null {
  const firstItem = items[0]
  if (!firstItem) return null

  for (const item of getSameRelevanceTierItems(items, firstItem)) {
    const violation = getNutritionItemViolation(item, query)
    if (!violation) return { item, violation: null }
  }
  return { item: firstItem, violation: getNutritionItemViolation(firstItem, query) }
}
