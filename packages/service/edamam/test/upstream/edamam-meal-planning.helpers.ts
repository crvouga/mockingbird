import type { z } from "zod"
import type {
  edamamMealPlanResponseSchema,
  edamamRecipeSearchResponseSchema,
} from "./edamam-meal-planning.schemas.js"
import type {
  BuildShoppingListInput,
  MealPlanConstraints,
  MealPlanSectionConstraints,
  MealPlanSectionName,
  NutrientBand,
  NutrientBands,
  RecipeSearchCriteria,
} from "./meal-planning.ports.js"

export const EDAMAM_PUBLIC_RECIPE_TYPE = "public"
const EDAMAM_REGULAR_IMAGE_SIZE = "REGULAR"
const EDAMAM_PLAN_MINIMUM_DAYS = 1
const EDAMAM_PLAN_MAXIMUM_DAYS = 14
const EDAMAM_NUTRIENT_MAPPINGS = [
  { key: "calories", code: "ENERC_KCAL" },
  { key: "proteinGrams", code: "PROCNT" },
  { key: "carbohydrateGrams", code: "CHOCDF" },
  { key: "fatGrams", code: "FAT" },
  { key: "fiberGrams", code: "FIBTG" },
] as const
const MEAL_PLAN_SECTION_NAMES = ["breakfast", "lunch", "dinner", "snack"] as const

type EdamamFitBand = {
  min?: number
  max?: number
  mark?: number
}

type EdamamPredicate = { health: string[] } | { meal: string[] } | { dish: string[] }

type EdamamPlanSection = {
  accept?: { all: EdamamPredicate[] }
  fit?: Record<string, EdamamFitBand>
  exclude?: string[]
  sections?: Record<string, EdamamPlanSection>
}

export function buildRecipeSearchQuery(criteria: RecipeSearchCriteria) {
  const query: Array<[string, string]> = [["type", EDAMAM_PUBLIC_RECIPE_TYPE]]
  if (criteria.query !== undefined) {
    if (!criteria.query.trim()) throw new Error("Invalid recipe search query")
    query.push(["q", criteria.query])
  }
  appendRepeatedQuery(query, "health", criteria.healthFilters)
  appendRepeatedQuery(query, "diet", criteria.dietFilters)
  appendBandQuery(query, "calories", criteria.calorieBand)
  for (const mapping of EDAMAM_NUTRIENT_MAPPINGS) {
    appendBandQuery(query, `nutrients[${mapping.code}]`, criteria.nutrientBands?.[mapping.key])
  }
  appendRepeatedQuery(query, "excluded", criteria.excludedIngredients)
  appendRepeatedQuery(query, "cuisineType", criteria.cuisineTypes ?? [])
  appendRepeatedQuery(query, "mealType", criteria.mealTypes ?? [])
  appendRepeatedQuery(query, "dishType", criteria.dishTypes ?? [])
  if (criteria.maximumTimeMinutes !== undefined) {
    if (!Number.isFinite(criteria.maximumTimeMinutes) || criteria.maximumTimeMinutes <= 0) {
      throw new Error("Invalid recipe maximum time")
    }
    query.push(["time", String(criteria.maximumTimeMinutes)])
  }
  query.push(["imageSize", EDAMAM_REGULAR_IMAGE_SIZE])
  if (criteria.randomize) query.push(["random", "true"])
  return query
}

export function appendRepeatedQuery(query: Array<[string, string]>, key: string, values: string[]) {
  for (const value of values) {
    if (!value.trim()) throw new Error(`Invalid ${key} query value`)
    query.push([key, value])
  }
}

export function buildMealPlanRequest(constraints: MealPlanConstraints) {
  const plan = buildPlanSection(constraints)
  const sections: Record<string, EdamamPlanSection> = {}
  for (const sectionName of MEAL_PLAN_SECTION_NAMES) {
    const sectionConstraints = constraints.sections[sectionName]
    if (sectionConstraints) {
      sections[getEdamamSectionName(sectionName)] = buildPlanSection(sectionConstraints)
    }
  }
  if (Object.keys(sections).length > 0) plan.sections = sections
  return { size: constraints.dayCount, plan }
}

export function hasValidPlanConstraints(constraints: MealPlanConstraints) {
  if (
    !Number.isInteger(constraints.dayCount) ||
    constraints.dayCount < EDAMAM_PLAN_MINIMUM_DAYS ||
    constraints.dayCount > EDAMAM_PLAN_MAXIMUM_DAYS
  ) {
    return false
  }
  const allConstraints: MealPlanSectionConstraints[] = [constraints]
  for (const sectionName of MEAL_PLAN_SECTION_NAMES) {
    const section = constraints.sections[sectionName]
    if (section) allConstraints.push(section)
  }
  if (
    allConstraints.some(
      (section) => section.cautionExclusions.length > 0 || section.excludedIngredients.length > 0,
    )
  ) {
    return false
  }
  try {
    for (const section of allConstraints) {
      validateStringArray(section.healthFilters)
      validateStringArray(section.excludedRecipeUris)
      validateStringArray(section.mealTypes ?? [])
      validateStringArray(section.dishTypes ?? [])
      buildPlanFit(section.nutrientBands)
    }
    return true
  } catch {
    return false
  }
}

export function hasValidShoppingListInput(input: BuildShoppingListInput) {
  return (
    input.recipes.length > 0 &&
    input.recipes.every(
      (recipe) =>
        Boolean(recipe.recipeUri.trim()) && Number.isFinite(recipe.quantity) && recipe.quantity > 0,
    )
  )
}

export function buildShoppingListEntries(input: BuildShoppingListInput, servingMeasureUri: string) {
  return input.recipes.map((recipe) => ({
    quantity: recipe.quantity,
    ...(recipe.scaleByServings ? { measure: servingMeasureUri } : {}),
    item: recipe.recipeUri,
  }))
}

export function mapPlanSections(
  sections: NonNullable<
    z.infer<typeof edamamMealPlanResponseSchema>["selection"]
  >[number]["sections"],
) {
  const mappedSections: Partial<Record<MealPlanSectionName, { recipeUri: string }>> = {}
  const unassignedSections: MealPlanSectionName[] = []
  for (const [sectionName, selection] of Object.entries(sections)) {
    const mappedName = getMealPlanSectionName(sectionName)
    if (!mappedName) return null
    if (selection.assigned === undefined) {
      unassignedSections.push(mappedName)
      continue
    }
    mappedSections[mappedName] = { recipeUri: selection.assigned }
  }
  return { sections: mappedSections, unassignedSections }
}

export function mapRecipe(
  recipe: z.infer<typeof edamamRecipeSearchResponseSchema>["hits"][number]["recipe"],
) {
  const servings = Number.isFinite(recipe.yield) && recipe.yield >= 1 ? recipe.yield : 1

  return {
    uri: recipe.uri,
    label: recipe.label,
    ...(recipe.image !== undefined ? { imageUrl: recipe.image } : {}),
    sourceUrl: recipe.url,
    servings,
    ingredientLines: recipe.ingredientLines,
    ingredients: recipe.ingredients.map((ingredient) => ({
      food: ingredient.food,
      quantity: ingredient.quantity,
      ...(ingredient.measure != null ? { measure: ingredient.measure } : {}),
      ...(ingredient.weight != null ? { weight: ingredient.weight } : {}),
      ...(ingredient.foodId != null ? { foodId: ingredient.foodId } : {}),
      ...(ingredient.foodCategory != null ? { category: ingredient.foodCategory } : {}),
    })),
    nutrients: Object.fromEntries(
      EDAMAM_NUTRIENT_MAPPINGS.flatMap(({ key, code }) => {
        const nutrient = recipe.totalNutrients[code]
        return nutrient
          ? [[key, { quantity: nutrient.quantity / servings, unit: nutrient.unit }]]
          : []
      }),
    ),
    cautionLabels: recipe.cautions,
    dietLabels: recipe.dietLabels,
    healthLabels: recipe.healthLabels,
  }
}

function appendBandQuery(
  query: Array<[string, string]>,
  key: string,
  band: NutrientBand | undefined,
) {
  const value = getBandQueryValue(band)
  if (value) query.push([key, value])
}

function getBandQueryValue(band: NutrientBand | undefined) {
  if (!band || (band.min === undefined && band.max === undefined)) return undefined
  validateBand(band)
  if (band.min !== undefined && band.max !== undefined) return `${band.min}-${band.max}`
  if (band.min !== undefined) return `${band.min}+`
  return String(band.max)
}

function buildPlanSection(constraints: MealPlanSectionConstraints): EdamamPlanSection {
  const predicates: EdamamPredicate[] = []
  if (constraints.healthFilters.length > 0) {
    predicates.push({ health: constraints.healthFilters })
  }
  if (constraints.mealTypes && constraints.mealTypes.length > 0) {
    predicates.push({ meal: constraints.mealTypes })
  }
  if (constraints.dishTypes && constraints.dishTypes.length > 0) {
    predicates.push({ dish: constraints.dishTypes })
  }
  const fit = buildPlanFit(constraints.nutrientBands)

  return {
    ...(predicates.length > 0 ? { accept: { all: predicates } } : {}),
    ...(Object.keys(fit).length > 0 ? { fit } : {}),
    ...(constraints.excludedRecipeUris.length > 0
      ? { exclude: constraints.excludedRecipeUris }
      : {}),
  }
}

function buildPlanFit(nutrientBands: NutrientBands) {
  const fit: Record<string, EdamamFitBand> = {}
  for (const mapping of EDAMAM_NUTRIENT_MAPPINGS) {
    const band = nutrientBands[mapping.key]
    if (band && (band.min !== undefined || band.max !== undefined || band.mark !== undefined)) {
      validateBand(band)
      fit[mapping.code] = {
        ...(band.min !== undefined ? { min: band.min } : {}),
        ...(band.max !== undefined ? { max: band.max } : {}),
        ...(band.mark !== undefined ? { mark: band.mark } : {}),
      }
    }
  }
  return fit
}

function validateBand(band: NutrientBand) {
  for (const value of [band.min, band.max, band.mark]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error("Invalid nutrient band")
    }
  }
  if (band.min !== undefined && band.max !== undefined && band.min > band.max) {
    throw new Error("Invalid nutrient band range")
  }
}

function validateStringArray(values: string[]) {
  if (values.some((value) => !value.trim())) throw new Error("Invalid string constraint")
}

function getEdamamSectionName(sectionName: MealPlanSectionName) {
  return `${sectionName.charAt(0).toUpperCase()}${sectionName.slice(1)}`
}

function getMealPlanSectionName(sectionName: string): MealPlanSectionName | undefined {
  switch (sectionName) {
    case "Breakfast":
      return "breakfast"
    case "Lunch":
      return "lunch"
    case "Dinner":
      return "dinner"
    case "Snack":
      return "snack"
    default:
      return undefined
  }
}
