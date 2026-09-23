import type { NutritionSearchFoodItem, NutritionSearchServingOption } from "./nutrition.ports.js"
import { getNutritionDensityViolation } from "./nutrition-plausibility.js"

const EDAMAM_SEARCH_IGNORED_TOKENS = new Set([
  "a",
  "an",
  "the",
  "of",
  "with",
  "and",
  "plus",
  "cup",
  "tablespoon",
  "tbsp",
  "teaspoon",
  "tsp",
  "oz",
  "fl",
  "ounce",
  "gram",
  "g",
  "milliliter",
  "ml",
  "piece",
  "scoop",
  "serving",
  "slice",
])
const EDAMAM_GENERIC_SERVING_LABEL = "serving"
const EDAMAM_WEIGHT_MEASURE_LABELS = new Set([
  "gram",
  "grams",
  "g",
  "ounce",
  "ounces",
  "oz",
  "pound",
  "pounds",
  "lb",
  "kilogram",
  "kilograms",
  "kg",
  "milliliter",
  "milliliters",
  "ml",
])
const EDAMAM_SERVING_SIZE_BASIC_LABELS = new Set(["gram", "g", "milliliter", "ml"])
const EDAMAM_ABBREVIATED_UNIT_LABELS = new Set(["g", "oz", "lb", "kg", "ml", "tbsp", "tsp"])
const EDAMAM_VOLUME_DESCRIPTION_PATTERN = /(?:^|\s)\d+(?:\.\d+)?\s*(?:ml|milliliters?)(?:\s|$)/i
const EDAMAM_RAW_UNIT_DESCRIPTION_PATTERN =
  /^\d+(?:\.\d+)?\s*(?:g|grams?|oz|ounces?|lb|pounds?|kg|kilograms?|ml|milliliters?)(?:\s*\(\d+(?:\.\d+)?\s*g\))?$/i
const EDAMAM_GENERIC_DESCRIPTION_PATTERN = /(?:^|\s)(?:packaged\s+)?serving(?:\s|$)/i
const EDAMAM_OPTION_SCORE_NONE = 0
const EDAMAM_OPTION_SCORE_UNIT = 1
const EDAMAM_OPTION_SCORE_GENERIC = 2
const EDAMAM_OPTION_SCORE_CONSUMER = 3
const EDAMAM_PARSED_CANDIDATE_MINIMUM_TIER = 1
const EDAMAM_CATEGORY_RANK_NEUTRAL = 1
const EDAMAM_CATEGORY_RANK_PREFERRED = 2
const EDAMAM_GENERIC_FOOD_CATEGORY = "generic foods"
const EDAMAM_MEAL_CATEGORIES = new Set(["generic meals", "fast foods"])
const EDAMAM_MEAL_CATEGORY_LABEL = "meal"
const EDAMAM_SINGLE_FOOD_CATEGORIES = new Set([EDAMAM_GENERIC_FOOD_CATEGORY])
const EDAMAM_UNIT_LABELS: Record<string, string> = {
  gram: "g",
  grams: "g",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  kilogram: "kg",
  kilograms: "kg",
  milliliter: "ml",
  milliliters: "ml",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  pattie: "patty",
  patties: "patties",
}

export type EdamamSearchMeasure = {
  label?: string
  weight?: number
}

export type EdamamSearchServingSize = {
  label?: string
  quantity?: number
}

export type EdamamSearchNutrients = {
  ENERC_KCAL?: number
  PROCNT?: number
  CHOCDF?: number
  FAT?: number
  ALC?: number
}

export type EdamamSearchCandidate = {
  source: "parsed" | "hint"
  food: {
    label?: string
    brand?: string
    category?: string
    categoryLabel?: string
    nutrients?: EdamamSearchNutrients
    servingSizes?: EdamamSearchServingSize[]
  }
  quantity?: number
  measure?: EdamamSearchMeasure
  measures: EdamamSearchMeasure[]
  servingSizes: EdamamSearchServingSize[]
}

export type EdamamServingOptionDescriptor = {
  description: string
  weightGrams: number | null
}

type ScoredServingOptionDescriptor = EdamamServingOptionDescriptor & {
  score: number
}

function getNormalizedFoodWords(value: string) {
  const tokens = value.toLowerCase().match(/[a-z]+/g) ?? []
  return tokens
    .map((token) => (token.endsWith("s") ? token.slice(0, -1) : token))
    .filter((token) => token.length > 0 && !EDAMAM_SEARCH_IGNORED_TOKENS.has(token))
}

export function getNormalizedFoodTokens(value: string) {
  return new Set(getNormalizedFoodWords(value))
}

export function isEdamamMealCategory(food: { category?: string; categoryLabel?: string }) {
  const category = (food.category ?? "").trim().toLowerCase()
  if (EDAMAM_MEAL_CATEGORIES.has(category)) return true
  return (food.categoryLabel ?? "").trim().toLowerCase() === EDAMAM_MEAL_CATEGORY_LABEL
}

function getSearchTier(query: string, label: string) {
  const queryWords = getNormalizedFoodWords(query)
  if (queryWords.length === 0) return 0

  const labelWords = getNormalizedFoodWords(label)
  const normalizedQueryPhrase = queryWords.join(" ")
  const normalizedLabelPhrase = labelWords.join(" ")
  if (` ${normalizedLabelPhrase} `.includes(` ${normalizedQueryPhrase} `)) return 4
  if (normalizedLabelPhrase.includes(normalizedQueryPhrase)) return 3

  const queryTokens = getNormalizedFoodTokens(query)
  const labelTokens = getNormalizedFoodTokens(label)
  if ([...queryTokens].every((token) => labelTokens.has(token))) return 2
  if ([...queryTokens].some((token) => labelTokens.has(token))) return 1
  return 0
}

export function rankSearchCandidates<T extends EdamamSearchCandidate>(
  candidates: T[],
  query: string,
) {
  if (getNormalizedFoodWords(query).length === 0) {
    return candidates.map((candidate, originalIndex) => ({
      candidate,
      originalIndex,
      tier: 0,
    }))
  }

  return candidates
    .map((candidate, originalIndex) => ({
      candidate,
      originalIndex,
      tier: Math.max(
        getSearchTier(query, candidate.food.label ?? ""),
        candidate.source === "parsed" ? EDAMAM_PARSED_CANDIDATE_MINIMUM_TIER : 0,
      ),
    }))
    .filter(({ tier }) => tier > 0)
}

function getAnalysisCategoryRank(candidate: EdamamSearchCandidate, queryTokens: Set<string>) {
  const normalizedCategory = (candidate.food.category ?? "").trim().toLowerCase()
  if (!EDAMAM_SINGLE_FOOD_CATEGORIES.has(normalizedCategory)) return EDAMAM_CATEGORY_RANK_NEUTRAL

  const labelTokens = getNormalizedFoodTokens(candidate.food.label ?? "")
  if (labelTokens.size === 0) return EDAMAM_CATEGORY_RANK_NEUTRAL
  return [...labelTokens].every((token) => queryTokens.has(token))
    ? EDAMAM_CATEGORY_RANK_PREFERRED
    : EDAMAM_CATEGORY_RANK_NEUTRAL
}

function getCandidatePlausibilityRank(candidate: EdamamSearchCandidate, query: string) {
  const nutrients = candidate.food.nutrients
  if (!nutrients || nutrients.ENERC_KCAL == null) return 1
  const violation = getNutritionDensityViolation({
    caloriesPer100Grams: nutrients.ENERC_KCAL,
    proteinGramsPer100Grams: nutrients.PROCNT ?? 0,
    carbGramsPer100Grams: nutrients.CHOCDF ?? 0,
    fatGramsPer100Grams: nutrients.FAT ?? 0,
    ...(nutrients.ALC != null ? { alcoholGramsPer100Grams: nutrients.ALC } : {}),
    ...(candidate.food.category ? { category: candidate.food.category } : {}),
    ...(candidate.food.label ? { label: candidate.food.label } : {}),
    ...(query ? { query } : {}),
  })
  return violation ? 0 : 1
}

export function rankAnalysisCandidates<T extends EdamamSearchCandidate>(
  candidates: T[],
  query: string,
) {
  const queryTokens = getNormalizedFoodTokens(query)
  return rankSearchCandidates(candidates, query)
    .map((rankedCandidate) => ({
      ...rankedCandidate,
      categoryRank: getAnalysisCategoryRank(rankedCandidate.candidate, queryTokens),
      plausibilityRank: getCandidatePlausibilityRank(rankedCandidate.candidate, query),
    }))
    .sort(
      (left, right) =>
        right.tier - left.tier ||
        right.plausibilityRank - left.plausibilityRank ||
        right.categoryRank - left.categoryRank ||
        left.originalIndex - right.originalIndex,
    )
    .map(({ candidate, tier }) => ({ ...candidate, relevanceTier: tier }))
}

function getNormalizedLabel(label: string) {
  return label.trim().toLowerCase()
}

function getServingSizeScore(servingSize: EdamamSearchServingSize) {
  const normalizedLabel = getNormalizedLabel(servingSize.label ?? "")
  if (!normalizedLabel || normalizedLabel === EDAMAM_GENERIC_SERVING_LABEL) {
    return EDAMAM_OPTION_SCORE_NONE
  }
  if (EDAMAM_SERVING_SIZE_BASIC_LABELS.has(normalizedLabel)) {
    return EDAMAM_OPTION_SCORE_UNIT
  }
  if (EDAMAM_WEIGHT_MEASURE_LABELS.has(normalizedLabel)) {
    return EDAMAM_OPTION_SCORE_GENERIC
  }
  return EDAMAM_OPTION_SCORE_CONSUMER
}

function getMeasureScore(measure: EdamamSearchMeasure) {
  const normalizedLabel = getNormalizedLabel(measure.label ?? "")
  if (!normalizedLabel) return EDAMAM_OPTION_SCORE_NONE
  if (EDAMAM_WEIGHT_MEASURE_LABELS.has(normalizedLabel)) return EDAMAM_OPTION_SCORE_UNIT
  if (normalizedLabel === EDAMAM_GENERIC_SERVING_LABEL) return EDAMAM_OPTION_SCORE_GENERIC
  return EDAMAM_OPTION_SCORE_CONSUMER
}

function getBestOptionIndex<T>(options: T[], getScore: (option: T) => number) {
  return options.reduce((bestIndex, option, index) => {
    const bestOption = options[bestIndex]
    return bestOption && getScore(option) > getScore(bestOption) ? index : bestIndex
  }, 0)
}

function getFormattedQuantity(quantity: number) {
  return Number.isInteger(quantity) ? String(quantity) : String(Number(quantity.toFixed(2)))
}

function getPluralizedLabel(label: string, quantity: number) {
  if (quantity <= 1 || EDAMAM_ABBREVIATED_UNIT_LABELS.has(label)) return label
  if (label === "patty") return "patties"
  if (label.endsWith("s")) return label
  return `${label}s`
}

export function formatServingDescription(
  label: string | undefined,
  quantity: number,
  weightGrams?: number,
) {
  const trimmedLabel = label?.trim()
  if (!trimmedLabel) return weightGrams && weightGrams > 0 ? `${Math.round(weightGrams)} g` : null

  const normalizedLabel = trimmedLabel.toLowerCase()
  const containsQuantity = /\d/.test(normalizedLabel)
  const unitLabel = EDAMAM_UNIT_LABELS[normalizedLabel] ?? normalizedLabel
  const servingLabel = containsQuantity
    ? unitLabel
    : `${getFormattedQuantity(quantity)} ${getPluralizedLabel(unitLabel, quantity)}`
  const containsGrams = /(?:^|\s)\d+(?:\.\d+)?\s*(?:g|grams?)(?:\s|$)/i.test(servingLabel)
  const containsVolume = EDAMAM_VOLUME_DESCRIPTION_PATTERN.test(servingLabel)
  if (!weightGrams || weightGrams <= 0 || containsGrams || containsVolume) return servingLabel
  return `${servingLabel} (${Math.round(weightGrams)} g)`
}

function getServingSizeWeight(
  servingSize: EdamamSearchServingSize,
  measures: EdamamSearchMeasure[],
) {
  const label = getNormalizedLabel(servingSize.label ?? "")
  const quantity = servingSize.quantity
  if (!label || !quantity || quantity <= 0) return null

  const matchingMeasure = measures.find(
    (measure) => getNormalizedLabel(measure.label ?? "") === label,
  )
  if (matchingMeasure?.weight && matchingMeasure.weight > 0) {
    return matchingMeasure.weight * quantity
  }
  const servingMeasure = measures.find(
    (measure) => getNormalizedLabel(measure.label ?? "") === EDAMAM_GENERIC_SERVING_LABEL,
  )
  if (servingMeasure?.weight && servingMeasure.weight > 0) return servingMeasure.weight
  return null
}

function getRoundedServingWeight(weightGrams: number | null) {
  return weightGrams == null ? null : Math.round(weightGrams)
}

function deduplicateServingOptionDescriptors(options: ScoredServingOptionDescriptor[]) {
  const uniqueOptions = new Map<number | null, ScoredServingOptionDescriptor>()
  for (const option of options) {
    const key = getRoundedServingWeight(option.weightGrams)
    const existingOption = uniqueOptions.get(key)
    if (!existingOption || option.score > existingOption.score) uniqueOptions.set(key, option)
  }
  return [...uniqueOptions.values()].map(({ description, weightGrams }) => ({
    description,
    weightGrams,
  }))
}

export function buildServingOptions(candidate: EdamamSearchCandidate) {
  const validMeasures = candidate.measures.filter((measure) => {
    const normalizedLabel = getNormalizedLabel(measure.label ?? "")
    const hasWeight = measure.weight != null && measure.weight > 0
    return hasWeight || Boolean(normalizedLabel && normalizedLabel !== EDAMAM_GENERIC_SERVING_LABEL)
  })
  const validServingSizes = candidate.servingSizes.filter(
    (servingSize) =>
      Boolean(servingSize.label?.trim()) &&
      servingSize.quantity != null &&
      servingSize.quantity > 0 &&
      (getNormalizedLabel(servingSize.label ?? "") !== EDAMAM_GENERIC_SERVING_LABEL ||
        getServingSizeWeight(servingSize, validMeasures) != null),
  )
  const servingSizeOptions = validServingSizes.flatMap((servingSize) => {
    const quantity = servingSize.quantity
    if (quantity == null) return []
    const weightGrams = getServingSizeWeight(servingSize, validMeasures)
    const description = formatServingDescription(
      servingSize.label,
      quantity,
      getNormalizedLabel(servingSize.label ?? "") === EDAMAM_GENERIC_SERVING_LABEL
        ? (weightGrams ?? undefined)
        : undefined,
    )
    if (!description) return []
    return [{ description, weightGrams, score: getServingSizeScore(servingSize) }]
  })
  const emittedMeasures = validMeasures.filter(
    (measure) => !EDAMAM_WEIGHT_MEASURE_LABELS.has(getNormalizedLabel(measure.label ?? "")),
  )
  const measureOptions = emittedMeasures.flatMap((measure) => {
    const quantity = measure === candidate.measure ? (candidate.quantity ?? 1) : 1
    const weightGrams = measure.weight && measure.weight > 0 ? measure.weight * quantity : null
    const description = formatServingDescription(measure.label, quantity, weightGrams ?? undefined)
    return description ? [{ description, weightGrams, score: getMeasureScore(measure) }] : []
  })

  if (servingSizeOptions.length > 0) {
    const servingOptions = [...servingSizeOptions, ...measureOptions]
    const bestIndex = getBestOptionIndex(servingOptions, (option) => option.score)
    const bestOption = servingOptions[bestIndex]
    if (!bestOption) return deduplicateServingOptionDescriptors(servingOptions)
    const orderedOptions = [bestOption, ...servingOptions.filter((_, index) => index !== bestIndex)]
    return deduplicateServingOptionDescriptors(orderedOptions)
  }

  if (measureOptions.length > 0) {
    const bestIndex = getBestOptionIndex(measureOptions, (option) => option.score)
    const genericServingIndex = measureOptions.findIndex(
      (option) =>
        option.score === EDAMAM_OPTION_SCORE_GENERIC &&
        option.weightGrams != null &&
        option.weightGrams > 0,
    )
    const preferredIndexes =
      genericServingIndex >= 0 && genericServingIndex !== bestIndex
        ? [genericServingIndex, bestIndex]
        : [bestIndex]
    const orderedOptions = [
      ...preferredIndexes.flatMap((index) => {
        const option = measureOptions[index]
        return option ? [option] : []
      }),
      ...measureOptions.filter((_, index) => !preferredIndexes.includes(index)),
    ]
    return deduplicateServingOptionDescriptors(orderedOptions)
  }

  return [
    {
      description: candidate.food.brand ? "1 packaged serving" : "100 g",
      weightGrams: null,
    },
  ]
}

function normalizeDeduplicationText(value: string | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function getSearchItemDeduplicationKey(item: NutritionSearchFoodItem) {
  if (item.externalFoodId) return `edamam:${item.externalFoodId}`
  return JSON.stringify([
    normalizeDeduplicationText(item.name),
    normalizeDeduplicationText(item.brand),
    normalizeDeduplicationText(item.servingDescription),
    item.servingWeightGrams ?? null,
    item.calories,
    item.proteinGrams,
    item.carbGrams,
    item.fatGrams,
    item.sugarGrams,
    item.fiberGrams,
  ])
}

export function mergeServingOptions(
  primary: NutritionSearchServingOption[] | undefined,
  duplicate: NutritionSearchServingOption[] | undefined,
) {
  const uniqueOptions = new Map<string, NutritionSearchServingOption>()
  for (const option of [...(primary ?? []), ...(duplicate ?? [])]) {
    const key = JSON.stringify([
      getRoundedServingWeight(option.weightGrams),
      option.macros.calories,
      option.macros.proteinGrams,
      option.macros.carbGrams,
      option.macros.fatGrams,
      option.macros.sugarGrams,
      option.macros.fiberGrams,
    ])
    const existingOption = uniqueOptions.get(key)
    const existingScore = existingOption
      ? getServingDescriptionScore(existingOption.description)
      : EDAMAM_OPTION_SCORE_NONE
    if (!existingOption || getServingDescriptionScore(option.description) > existingScore) {
      uniqueOptions.set(key, option)
    }
  }
  return [...uniqueOptions.values()]
}

function getServingDescriptionScore(description: string) {
  if (EDAMAM_RAW_UNIT_DESCRIPTION_PATTERN.test(description)) return EDAMAM_OPTION_SCORE_UNIT
  if (EDAMAM_GENERIC_DESCRIPTION_PATTERN.test(description)) return EDAMAM_OPTION_SCORE_GENERIC
  return EDAMAM_OPTION_SCORE_CONSUMER
}
