// Copied from apps/backend/src/modules/metrics/ports/outbound/nutrition-analysis.port.ts and
// packages/api-types/src/nutrition (NutritionAnalysisFoodItem), types only.
export type NutritionAnalysisFoodItem = {
  id: string
  name: string
  servingDescription: string
  quantity: number
  calories: number
  proteinGrams: number
  carbGrams: number
  fatGrams: number
  sugarGrams: number
  fiberGrams: number | null
  confidence: "high" | "medium" | "low"
  brand?: string
  externalFoodId?: string
  servingWeightGrams?: number
  barcode?: string
  processingGrade?: string
  portionAssumed?: boolean
}

export type NutritionPhotoAnalysisInput = {
  imageBase64: string
  imageMimeType: "image/jpeg" | "image/png"
}

export type NutritionDescriptionAnalysisOptions = {
  rankingEnabled: boolean
}

export type NutritionClassifiableFoodItem = NutritionAnalysisFoodItem & {
  classificationIngredients?: string
  category?: string
  relevanceTier?: number
}

export type NutritionSearchServingOption = {
  description: string
  weightGrams: number | null
  macros: {
    calories: number
    proteinGrams: number
    carbGrams: number
    fatGrams: number
    sugarGrams: number
    fiberGrams: number | null
  }
}

export type NutritionSearchFoodItem = NutritionAnalysisFoodItem & {
  category?: string
  servingOptions?: NutritionSearchServingOption[]
}

export type NutritionLookupResult =
  | { status: "ok"; items: NutritionClassifiableFoodItem[] }
  | { status: "unavailable" }
  | { status: "not_found" }

export type NutritionSearchLookupResult =
  | { status: "ok"; items: NutritionSearchFoodItem[] }
  | { status: "unavailable" }
  | { status: "not_found" }

export type NutritionBarcodeLookupResult =
  | { status: "ok"; items: NutritionClassifiableFoodItem[] }
  | { status: "unavailable" }
  | { status: "not_found" }
  | { status: "no_nutrition_data"; productLabel: string }

export type INutritionAnalysisPort = {
  searchFoodsByDescription(description: string, limit: number): Promise<NutritionSearchLookupResult>
  analyzeFoodsByDescription(
    description: string,
    limit: number,
    options: NutritionDescriptionAnalysisOptions,
  ): Promise<NutritionLookupResult>
  lookupFoodsByBarcode(barcode: string): Promise<NutritionBarcodeLookupResult>
  analyzeFoodPhoto(input: NutritionPhotoAnalysisInput): Promise<NutritionLookupResult>
}
