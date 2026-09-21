// Copied from apps/backend/src/modules/meal-planning/ports/outbound/*.port.ts (types only).

export type NutrientBand = {
  min?: number
  max?: number
  mark?: number
}

export type NutrientBands = {
  calories?: NutrientBand
  proteinGrams?: NutrientBand
  carbohydrateGrams?: NutrientBand
  fatGrams?: NutrientBand
  fiberGrams?: NutrientBand
}

export type RecipeIngredient = {
  food: string
  quantity: number
  measure?: string
  weight?: number
  foodId?: string
  category?: string
}

export type RecipeNutrient = {
  quantity: number
  unit: string
}

export type RecipeNutrients = {
  calories?: RecipeNutrient
  proteinGrams?: RecipeNutrient
  carbohydrateGrams?: RecipeNutrient
  fatGrams?: RecipeNutrient
  fiberGrams?: RecipeNutrient
}

export type RecipeSummary = {
  uri: string
  label: string
  imageUrl?: string
  sourceUrl: string
  servings: number
  ingredientLines: string[]
  ingredients: RecipeIngredient[]
  nutrients: RecipeNutrients
  cautionLabels: string[]
  dietLabels: string[]
  healthLabels: string[]
}

export type RecipeSearchCriteria = {
  query?: string
  healthFilters: string[]
  cautionExclusions: string[]
  dietFilters: string[]
  excludedIngredients: string[]
  calorieBand?: NutrientBand
  nutrientBands?: NutrientBands
  cuisineTypes?: string[]
  mealTypes?: string[]
  dishTypes?: string[]
  maximumTimeMinutes?: number
  randomize?: boolean
  nextPageToken?: string
}

export type RecipeUriLookup = {
  uris: string[]
}

export type RecipeSearchResult =
  | { status: "ok"; recipes: RecipeSummary[]; nextPageToken?: string }
  | { status: "invalid_constraints" }
  | { status: "unavailable"; rateLimited?: boolean }
  | { status: "not_found" }

export type IRecipeSearchPort = {
  searchRecipes(userId: number, criteria: RecipeSearchCriteria): Promise<RecipeSearchResult>
  getRecipesByUri(userId: number, uris: string[]): Promise<RecipeSearchResult>
}

export type MealPlanSectionName = "breakfast" | "lunch" | "dinner" | "snack"

export type MealPlanSectionConstraints = {
  healthFilters: string[]
  cautionExclusions: string[]
  excludedIngredients: string[]
  excludedRecipeUris: string[]
  nutrientBands: NutrientBands
  mealTypes?: string[]
  dishTypes?: string[]
}

export type MealPlanConstraints = MealPlanSectionConstraints & {
  dayCount: number
  sections: Partial<Record<MealPlanSectionName, MealPlanSectionConstraints>>
}

export type MealPlanSelection = {
  recipeUri: string
}

export type MealPlanDay = {
  dayIndex: number
  sections: Partial<Record<MealPlanSectionName, MealPlanSelection>>
}

export type MealPlanUnassignedSlot = {
  dayIndex: number
  section: MealPlanSectionName
}

type MealPlanGeneratedDays = {
  days: MealPlanDay[]
  unassignedSlots?: MealPlanUnassignedSlot[]
}

export type MealPlanGenerationResult =
  | ({ status: "ok" } & MealPlanGeneratedDays)
  | ({ status: "incomplete" } & MealPlanGeneratedDays)
  | ({ status: "timeout" } & MealPlanGeneratedDays)
  | { status: "invalid_constraints" }
  | { status: "unavailable"; rateLimited?: boolean }

export type IMealPlanGeneratorPort = {
  generatePlan(userId: number, constraints: MealPlanConstraints): Promise<MealPlanGenerationResult>
}

export type ShoppingQuantity = {
  quantity: number
  measure: string
  qualifiers: string[]
}

export type ShoppingEntry = {
  foodId: string
  food: string
  quantities: ShoppingQuantity[]
}

export type ShoppingListRecipe = {
  recipeUri: string
  quantity: number
  scaleByServings: boolean
}

export type BuildShoppingListInput = {
  recipes: ShoppingListRecipe[]
  cartLink: boolean
}

export type GroceryFulfillmentResult =
  | { status: "ok"; entries: ShoppingEntry[]; cartUrl?: string }
  | { status: "unavailable"; rateLimited?: boolean }

export type IGroceryFulfillmentPort = {
  buildShoppingList(
    userId: number,
    input: BuildShoppingListInput,
  ): Promise<GroceryFulfillmentResult>
}
