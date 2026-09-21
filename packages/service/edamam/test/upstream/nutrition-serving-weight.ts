import type { WholeUnitFoodStandard } from "./nutrition-foods.constants.js"
import { WHOLE_UNIT_FOOD_STANDARDS } from "./nutrition-foods.constants.js"

type MeasureStandard = {
  grams: number
  minimumRatio: number
  maximumRatio: number
}

const MASS_MEASURE_MINIMUM_RATIO = 0.9
const MASS_MEASURE_MAXIMUM_RATIO = 1.1
const VOLUME_MEASURE_MINIMUM_RATIO = 0.1
const VOLUME_MEASURE_MAXIMUM_RATIO = 1.6

function massMeasure(grams: number): MeasureStandard {
  return {
    grams,
    minimumRatio: MASS_MEASURE_MINIMUM_RATIO,
    maximumRatio: MASS_MEASURE_MAXIMUM_RATIO,
  }
}

function volumeMeasure(grams: number): MeasureStandard {
  return {
    grams,
    minimumRatio: VOLUME_MEASURE_MINIMUM_RATIO,
    maximumRatio: VOLUME_MEASURE_MAXIMUM_RATIO,
  }
}

const STANDARD_MEASURE_WEIGHTS = new Map<string, MeasureStandard>([
  ["gram", massMeasure(1)],
  ["grams", massMeasure(1)],
  ["g", massMeasure(1)],
  ["kilogram", massMeasure(1000)],
  ["kilograms", massMeasure(1000)],
  ["kg", massMeasure(1000)],
  ["ounce", massMeasure(28.35)],
  ["ounces", massMeasure(28.35)],
  ["oz", massMeasure(28.35)],
  ["pound", massMeasure(453.59)],
  ["pounds", massMeasure(453.59)],
  ["lb", massMeasure(453.59)],
  ["milliliter", volumeMeasure(1)],
  ["milliliters", volumeMeasure(1)],
  ["ml", volumeMeasure(1)],
  ["liter", volumeMeasure(1000)],
  ["liters", volumeMeasure(1000)],
  ["teaspoon", volumeMeasure(4.93)],
  ["teaspoons", volumeMeasure(4.93)],
  ["tsp", volumeMeasure(4.93)],
  ["tablespoon", volumeMeasure(14.79)],
  ["tablespoons", volumeMeasure(14.79)],
  ["tbsp", volumeMeasure(14.79)],
  ["fluid ounce", volumeMeasure(29.57)],
  ["fl oz", volumeMeasure(29.57)],
  ["cup", volumeMeasure(240)],
  ["cups", volumeMeasure(240)],
  ["pint", volumeMeasure(473)],
  ["quart", volumeMeasure(946)],
  ["gallon", volumeMeasure(3785)],
])

const GRAM_BASED_SERVING_LABELS = new Set(["g", "gram", "grams"])

const WHOLE_UNIT_MEASURE_LABELS = new Set([
  "whole",
  "unit",
  "each",
  "item",
  "egg",
  "fruit",
  "breast",
  "fillet",
  "filet",
  "cutlet",
  "chop",
  "thigh",
])

const GENERIC_SERVING_MEASURE_LABEL = "serving"

export type WholeUnitAlternateMeasure = {
  label?: string
  weight?: number
}

export type WholeUnitPortionResolution = {
  weightGrams: number | undefined
  portionAssumed: boolean
}

function getNormalizedMeasureLabel(label: string | undefined) {
  return (label ?? "").trim().toLowerCase()
}

export function isGramBasedServingLabel(label: string | undefined) {
  return GRAM_BASED_SERVING_LABELS.has(getNormalizedMeasureLabel(label))
}

export function getSanitizedMeasureWeightGrams(
  label: string | undefined,
  weightGrams: number | undefined,
) {
  if (weightGrams == null || !Number.isFinite(weightGrams) || weightGrams <= 0) return undefined

  const standard = STANDARD_MEASURE_WEIGHTS.get(getNormalizedMeasureLabel(label))
  if (!standard) return weightGrams

  const minimumWeight = standard.grams * standard.minimumRatio
  const maximumWeight = standard.grams * standard.maximumRatio
  if (weightGrams < minimumWeight || weightGrams > maximumWeight) return standard.grams
  return weightGrams
}

export function isWholeUnitMeasureLabel(label: string | undefined) {
  return WHOLE_UNIT_MEASURE_LABELS.has(getNormalizedMeasureLabel(label))
}

function findWholeUnitFoodStandard(foodName: string | undefined) {
  const name = (foodName ?? "").trim()
  if (!name) return undefined
  return WHOLE_UNIT_FOOD_STANDARDS.find(
    (standard) => standard.matcher.test(name) && !standard.excludeMatcher?.test(name),
  )
}

function isWithinWholeUnitRange(weightGrams: number, standard: WholeUnitFoodStandard) {
  return weightGrams >= standard.minimumGrams && weightGrams <= standard.maximumGrams
}

function getPlausibleAlternateWeightGrams(
  measures: readonly WholeUnitAlternateMeasure[],
  standard: WholeUnitFoodStandard,
) {
  const usableMeasures = measures.filter((measure) => {
    const normalizedLabel = getNormalizedMeasureLabel(measure.label)
    if (!normalizedLabel || STANDARD_MEASURE_WEIGHTS.has(normalizedLabel)) return false
    if (WHOLE_UNIT_MEASURE_LABELS.has(normalizedLabel)) return false
    const weight = measure.weight
    return weight != null && Number.isFinite(weight) && isWithinWholeUnitRange(weight, standard)
  })
  const genericServing = usableMeasures.find(
    (measure) => getNormalizedMeasureLabel(measure.label) === GENERIC_SERVING_MEASURE_LABEL,
  )
  return (genericServing ?? usableMeasures[0])?.weight
}

export function resolveWholeUnitPortionWeightGrams(params: {
  measureLabel: string | undefined
  weightGrams: number | undefined
  foodName: string | undefined
  alternateMeasures?: readonly WholeUnitAlternateMeasure[]
}): WholeUnitPortionResolution {
  const { weightGrams } = params
  if (weightGrams == null || !Number.isFinite(weightGrams) || weightGrams <= 0) {
    return { weightGrams: undefined, portionAssumed: false }
  }
  if (!isWholeUnitMeasureLabel(params.measureLabel)) {
    return { weightGrams, portionAssumed: false }
  }

  const standard = findWholeUnitFoodStandard(params.foodName)
  if (!standard || isWithinWholeUnitRange(weightGrams, standard)) {
    return { weightGrams, portionAssumed: false }
  }

  const alternateWeightGrams = getPlausibleAlternateWeightGrams(
    params.alternateMeasures ?? [],
    standard,
  )
  return {
    weightGrams: alternateWeightGrams ?? standard.typicalGrams,
    portionAssumed: true,
  }
}
