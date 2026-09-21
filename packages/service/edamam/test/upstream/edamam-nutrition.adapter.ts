import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { EdamamServingOptionDescriptor } from "./edamam-nutrition-search.js"
import {
  buildServingOptions,
  getNormalizedFoodTokens,
  getSearchItemDeduplicationKey,
  isEdamamMealCategory,
  mergeServingOptions,
  rankAnalysisCandidates,
  rankSearchCandidates,
} from "./edamam-nutrition-search.js"
import type {
  INutritionAnalysisPort,
  NutritionAnalysisFoodItem,
  NutritionBarcodeLookupResult,
  NutritionClassifiableFoodItem,
  NutritionDescriptionAnalysisOptions,
  NutritionLookupResult,
  NutritionPhotoAnalysisInput,
  NutritionSearchFoodItem,
  NutritionSearchLookupResult,
} from "./nutrition.ports.js"
import { getNutritionProviderErrorName } from "./nutrition-provider-error.js"
import {
  getSanitizedMeasureWeightGrams,
  isGramBasedServingLabel,
  resolveWholeUnitPortionWeightGrams,
} from "./nutrition-serving-weight.js"
import { type ConfigService, type Fetch, type LoggerService, logStructured } from "./seams.js"

const EDAMAM_LOGGING_NUTRITION_TYPE = "logging"
const EDAMAM_FOOD_CATEGORY_LABEL = "food"
const EDAMAM_PHOTO_BETA_ENABLED = "true"
const EDAMAM_MAX_DESCRIPTION_CANDIDATES = 4
const EDAMAM_NUTRIENT_REFERENCE_GRAMS = 100
const EDAMAM_PARSER_TIMEOUT_MS = 10_000
const EDAMAM_PHOTO_TIMEOUT_MS = 30_000

const edamamNutrientsSchema = z
  .object({
    ENERC_KCAL: z.number().optional(),
    PROCNT: z.number().optional(),
    CHOCDF: z.number().optional(),
    FAT: z.number().optional(),
    SUGAR: z.number().optional(),
    FIBTG: z.number().optional(),
    ALC: z.number().optional(),
  })
  .passthrough()

const edamamFoodSchema = z
  .object({
    foodId: z.string().optional(),
    label: z.string().optional(),
    foodContentsLabel: z.string().optional(),
    brand: z.string().optional(),
    category: z.string().optional(),
    categoryLabel: z.string().optional(),
    nutrients: edamamNutrientsSchema.optional(),
    servingSizes: z
      .array(
        z.object({
          label: z.string().optional(),
          quantity: z.number().optional(),
        }),
      )
      .optional(),
  })
  .passthrough()

const edamamParsedFoodSchema = z
  .object({
    food: edamamFoodSchema,
    quantity: z.number().optional(),
    measure: z
      .object({
        label: z.string().optional(),
        weight: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const edamamParserResponseSchema = z.object({
  parsed: z.array(edamamParsedFoodSchema).optional(),
  hints: z
    .array(
      z.object({
        food: edamamFoodSchema,
        measures: z
          .array(
            z
              .object({
                label: z.string().optional(),
                weight: z.number().optional(),
              })
              .passthrough(),
          )
          .optional(),
      }),
    )
    .optional(),
})

const edamamTotalNutrientSchema = z
  .object({
    quantity: z.number().optional(),
  })
  .passthrough()

const edamamVisionResponseSchema = z
  .object({
    parsed: edamamParsedFoodSchema.optional(),
    recipe: z
      .object({
        label: z.string().optional(),
        calories: z.number().optional(),
        totalNutrients: z
          .object({
            ENERC_KCAL: edamamTotalNutrientSchema.optional(),
            PROCNT: edamamTotalNutrientSchema.optional(),
            CHOCDF: edamamTotalNutrientSchema.optional(),
            FAT: edamamTotalNutrientSchema.optional(),
            SUGAR: edamamTotalNutrientSchema.optional(),
            FIBTG: edamamTotalNutrientSchema.optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

type EdamamParserCandidate = {
  source: "parsed" | "hint"
  food: z.infer<typeof edamamFoodSchema>
  servingDescription?: string
  relevanceTier?: number
  quantity?: number
  measure?: z.infer<typeof edamamParsedFoodSchema>["measure"]
  measures: NonNullable<
    NonNullable<z.infer<typeof edamamParserResponseSchema>["hints"]>[number]["measures"]
  >
  alternateMeasures: NonNullable<
    NonNullable<z.infer<typeof edamamParserResponseSchema>["hints"]>[number]["measures"]
  >
  servingSizes: NonNullable<z.infer<typeof edamamFoodSchema>["servingSizes"]>
}

type EdamamDescriptionParserResult =
  | { status: "ok"; parsed: z.infer<typeof edamamParserResponseSchema> }
  | { status: "unavailable" }
  | { status: "not_found" }

type EdamamParserQueryOptions = {
  categoryLabel?: "food" | "meal"
}

export class EdamamNutritionAdapter implements INutritionAnalysisPort {
  private hasWarnedMissingCredentials = false

  // Seam: the app hardcodes EDAMAM_BASE_URL = 'https://api.edamam.com' and the global fetch.
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigService,
    private readonly EDAMAM_BASE_URL: string,
    private readonly fetch: Fetch,
  ) {}

  async searchFoodsByDescription(
    description: string,
    limit: number,
  ): Promise<NutritionSearchLookupResult> {
    const result = await this.getDescriptionParserResult(description, {
      categoryLabel: EDAMAM_FOOD_CATEGORY_LABEL,
    })
    if (result.status !== "ok") return result

    const candidates = this.extractParserCandidates(result.parsed).filter(
      (candidate) => !isEdamamMealCategory(candidate.food),
    )
    const items = this.rankAndDeduplicateSearchItems(candidates, description, limit)
    return items.length > 0 ? { status: "ok", items } : { status: "not_found" }
  }

  async analyzeFoodsByDescription(
    description: string,
    limit: number,
    options: NutritionDescriptionAnalysisOptions,
  ): Promise<NutritionLookupResult> {
    const result = await this.getDescriptionParserResult(description)
    if (result.status !== "ok") return result

    const candidates = this.extractParserCandidates(result.parsed, description)
    const selectedCandidates = options.rankingEnabled
      ? rankAnalysisCandidates(candidates, description)
      : candidates
    const items = this.buildItemsFromCandidates(selectedCandidates, "medium", undefined, limit)
    return items.length > 0 ? { status: "ok", items } : { status: "not_found" }
  }

  private async getDescriptionParserResult(
    description: string,
    options?: EdamamParserQueryOptions,
  ): Promise<EdamamDescriptionParserResult> {
    const credentials = this.getCredentials()
    if (!credentials) {
      this.warnMissingCredentialsOnce()
      return { status: "unavailable" }
    }
    if (!description) return { status: "not_found" }

    try {
      const params = new URLSearchParams({
        app_id: credentials.appId,
        app_key: credentials.appKey,
        ingr: description,
        "nutrition-type": EDAMAM_LOGGING_NUTRITION_TYPE,
        ...(options?.categoryLabel ? { categoryLabel: options.categoryLabel } : {}),
      })
      const response = await this.fetch(
        `${this.EDAMAM_BASE_URL}/api/food-database/v2/parser?${params}`,
        {
          signal: AbortSignal.timeout(EDAMAM_PARSER_TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        this.logUnavailable("parser_description", response.status)
        return { status: "unavailable" }
      }

      const rawPayload: unknown = await response.json()
      const parsed = edamamParserResponseSchema.safeParse(rawPayload)
      if (!parsed.success) {
        logStructured(this.logger, "warn", {
          event: "nutrition.edamam_unavailable",
          endpoint: "parser_description",
          reason: "schema_validation_failed",
        })
        return { status: "unavailable" }
      }
      return { status: "ok", parsed: parsed.data }
    } catch (error) {
      logStructured(this.logger, "warn", {
        event: "nutrition.edamam_unavailable",
        endpoint: "parser_description",
        reason: "request_failed",
        errorName: getNutritionProviderErrorName(error),
      })
      return { status: "unavailable" }
    }
  }

  async lookupFoodsByBarcode(barcode: string): Promise<NutritionBarcodeLookupResult> {
    const credentials = this.getCredentials()
    if (!credentials) {
      this.warnMissingCredentialsOnce()
      return { status: "unavailable" }
    }
    if (!barcode) return { status: "not_found" }

    try {
      const params = new URLSearchParams({
        app_id: credentials.appId,
        app_key: credentials.appKey,
        upc: barcode,
        "nutrition-type": EDAMAM_LOGGING_NUTRITION_TYPE,
      })
      const response = await this.fetch(
        `${this.EDAMAM_BASE_URL}/api/food-database/v2/parser?${params}`,
        {
          signal: AbortSignal.timeout(EDAMAM_PARSER_TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        this.logUnavailable("parser_barcode", response.status)
        return { status: "unavailable" }
      }

      const rawPayload: unknown = await response.json()
      const parsed = edamamParserResponseSchema.safeParse(rawPayload)
      if (!parsed.success) {
        logStructured(this.logger, "warn", {
          event: "nutrition.edamam_unavailable",
          endpoint: "parser_barcode",
          reason: "schema_validation_failed",
        })
        return { status: "unavailable" }
      }

      const candidates = this.extractParserCandidates(parsed.data)
      const items = this.buildItemsFromCandidates(candidates, "high", barcode)
      if (items.length > 0) return { status: "ok", items }

      const productLabel = candidates[0]?.food.label
      if (productLabel) return { status: "no_nutrition_data", productLabel }
      return { status: "not_found" }
    } catch (error) {
      logStructured(this.logger, "warn", {
        event: "nutrition.edamam_unavailable",
        endpoint: "parser_barcode",
        reason: "request_failed",
        errorName: getNutritionProviderErrorName(error),
      })
      return { status: "unavailable" }
    }
  }

  async analyzeFoodPhoto(input: NutritionPhotoAnalysisInput): Promise<NutritionLookupResult> {
    const credentials = this.getCredentials()
    if (!credentials) {
      this.warnMissingCredentialsOnce()
      return { status: "unavailable" }
    }

    try {
      const query = new URLSearchParams({
        app_id: credentials.appId,
        app_key: credentials.appKey,
        beta: EDAMAM_PHOTO_BETA_ENABLED,
      })
      const response = await this.fetch(
        `${this.EDAMAM_BASE_URL}/api/food-database/nutrients-from-image?${query}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: `data:${input.imageMimeType};base64,${input.imageBase64}`,
          }),
          signal: AbortSignal.timeout(EDAMAM_PHOTO_TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        this.logUnavailable("vision", response.status)
        return { status: "unavailable" }
      }

      const rawPayload: unknown = await response.json()
      const items = this.getVisionItems(rawPayload)
      return items.length > 0 ? { status: "ok", items } : { status: "not_found" }
    } catch (error) {
      logStructured(this.logger, "warn", {
        event: "nutrition.edamam_unavailable",
        endpoint: "vision",
        reason: "request_failed",
        errorName: getNutritionProviderErrorName(error),
      })
      return { status: "unavailable" }
    }
  }

  private logUnavailable(endpoint: string, httpStatus: number) {
    logStructured(this.logger, "warn", {
      event: "nutrition.edamam_unavailable",
      endpoint,
      reason: "http_error",
      httpStatus,
    })
  }

  private warnMissingCredentialsOnce(): void {
    if (this.hasWarnedMissingCredentials) return
    this.hasWarnedMissingCredentials = true
    logStructured(this.logger, "warn", {
      event: "nutrition.edamam_credentials_missing",
    })
  }

  private getCredentials() {
    const appId =
      this.config.get<string>("EDAMAM_FOOD_APP_ID") ?? this.config.get<string>("EDAMAM_APP_ID")
    const appKey =
      this.config.get<string>("EDAMAM_FOOD_APP_KEY") ?? this.config.get<string>("EDAMAM_APP_KEY")

    return appId && appKey ? { appId, appKey } : null
  }

  private getFoodItem(params: {
    food: z.infer<typeof edamamFoodSchema>
    confidence: NutritionAnalysisFoodItem["confidence"]
    servingDescription?: string
    quantity?: number
    servingWeightGrams?: number
    barcode?: string
    searchServingOptions?: EdamamServingOptionDescriptor[]
    includeClassificationIngredients?: boolean
    relevanceTier?: number
    portionAssumed?: boolean
  }): (NutritionClassifiableFoodItem & NutritionSearchFoodItem) | null {
    const nutrients = params.food.nutrients
    const label = params.food.label
    if (!nutrients || !label) return null

    const quantity = params.quantity && params.quantity > 0 ? params.quantity : 1
    const firstServing = params.searchServingOptions ? undefined : params.food.servingSizes?.[0]
    const gramBasedServingWeight =
      firstServing && isGramBasedServingLabel(firstServing.label)
        ? firstServing.quantity
        : undefined
    const parsedServingWeightGrams =
      params.servingWeightGrams && params.servingWeightGrams > 0
        ? params.servingWeightGrams
        : undefined
    const servingWeightGrams =
      parsedServingWeightGrams != null ? parsedServingWeightGrams : gramBasedServingWeight
    const nutrientScale = this.getNutrientScale({
      quantity,
      servingWeightGrams,
    })
    const macros = this.getFoodMacros(nutrients, nutrientScale)
    if (macros.calories <= 0) return null

    const servingDescription =
      params.servingDescription ??
      firstServing?.label ??
      (params.food.brand ? "1 packaged serving" : "100 g")

    return {
      id: randomUUID(),
      name: label,
      servingDescription,
      quantity,
      ...macros,
      confidence: params.confidence,
      ...(params.food.brand ? { brand: params.food.brand } : {}),
      ...(params.food.foodId ? { externalFoodId: params.food.foodId } : {}),
      ...(servingWeightGrams ? { servingWeightGrams } : {}),
      ...(params.barcode ? { barcode: params.barcode } : {}),
      ...(params.portionAssumed ? { portionAssumed: true } : {}),
      ...(params.food.category ? { category: params.food.category } : {}),
      ...(params.relevanceTier != null ? { relevanceTier: params.relevanceTier } : {}),
      ...(params.includeClassificationIngredients && params.food.foodContentsLabel
        ? { classificationIngredients: params.food.foodContentsLabel }
        : {}),
      ...(params.searchServingOptions
        ? {
            servingOptions: params.searchServingOptions.map((option) => ({
              description: option.description,
              weightGrams: option.weightGrams,
              macros: this.getFoodMacros(
                nutrients,
                this.getNutrientScale({
                  quantity: 1,
                  ...(option.weightGrams != null ? { servingWeightGrams: option.weightGrams } : {}),
                }),
              ),
            })),
          }
        : {}),
    }
  }

  private getFoodMacros(nutrients: z.infer<typeof edamamNutrientsSchema>, nutrientScale: number) {
    return {
      calories: Math.round((nutrients.ENERC_KCAL ?? 0) * nutrientScale),
      proteinGrams: Math.round((nutrients.PROCNT ?? 0) * nutrientScale),
      carbGrams: Math.round((nutrients.CHOCDF ?? 0) * nutrientScale),
      fatGrams: Math.round((nutrients.FAT ?? 0) * nutrientScale),
      sugarGrams: Math.round((nutrients.SUGAR ?? 0) * nutrientScale),
      fiberGrams: nutrients.FIBTG != null ? Math.round(nutrients.FIBTG * nutrientScale) : null,
    }
  }

  private getNutrientScale(params: { quantity: number; servingWeightGrams?: number }) {
    if (!params.servingWeightGrams || params.servingWeightGrams <= 0) return 1
    return (params.quantity * params.servingWeightGrams) / EDAMAM_NUTRIENT_REFERENCE_GRAMS
  }

  private extractParserCandidates(
    parsed: z.infer<typeof edamamParserResponseSchema>,
    hintQuery?: string,
  ): EdamamParserCandidate[] {
    const hintMeasuresByFoodId = this.getHintMeasuresByFoodId(parsed)
    const parsedCandidates: EdamamParserCandidate[] = (parsed.parsed ?? []).map((candidate) => ({
      source: "parsed",
      food: candidate.food,
      ...(candidate.measure?.label != null ? { servingDescription: candidate.measure.label } : {}),
      ...(candidate.quantity != null ? { quantity: candidate.quantity } : {}),
      ...(candidate.measure != null ? { measure: candidate.measure } : {}),
      measures: candidate.measure ? [candidate.measure] : [],
      alternateMeasures:
        (candidate.food.foodId ? hintMeasuresByFoodId.get(candidate.food.foodId) : undefined) ??
        (candidate.measure ? [candidate.measure] : []),
      servingSizes: candidate.food.servingSizes ?? [],
    }))
    const hintCandidates: EdamamParserCandidate[] = (parsed.hints ?? [])
      .filter(
        (candidate) => !hintQuery || this.isRelevantHint(hintQuery, candidate.food.label ?? ""),
      )
      .map((candidate) => {
        const measure = candidate.measures?.[0]
        return {
          source: "hint",
          food: candidate.food,
          ...(measure?.label != null ? { servingDescription: measure.label } : {}),
          ...(measure != null ? { measure } : {}),
          measures: candidate.measures ?? [],
          alternateMeasures: candidate.measures ?? [],
          servingSizes: candidate.food.servingSizes ?? [],
        }
      })

    return [...parsedCandidates, ...hintCandidates]
  }

  private getHintMeasuresByFoodId(parsed: z.infer<typeof edamamParserResponseSchema>) {
    const measuresByFoodId = new Map<
      string,
      NonNullable<
        NonNullable<z.infer<typeof edamamParserResponseSchema>["hints"]>[number]["measures"]
      >
    >()
    for (const hint of parsed.hints ?? []) {
      const foodId = hint.food.foodId
      if (!foodId || !hint.measures || measuresByFoodId.has(foodId)) continue
      measuresByFoodId.set(foodId, hint.measures)
    }
    return measuresByFoodId
  }

  private isRelevantHint(query: string, label: string) {
    const queryTokens = getNormalizedFoodTokens(query)
    const labelTokens = getNormalizedFoodTokens(label)
    return [...labelTokens].some((token) => queryTokens.has(token))
  }

  private rankAndDeduplicateSearchItems(
    candidates: EdamamParserCandidate[],
    query: string,
    limit: number,
  ) {
    const deduplicatedItems: NutritionSearchFoodItem[] = []
    const itemIndexesByKey = new Map<string, number>()

    for (const { candidate } of rankSearchCandidates(candidates, query)) {
      const servingOptions = buildServingOptions(candidate)
      const primaryServing = servingOptions[0]
      if (!primaryServing) continue

      const item = this.getFoodItem({
        food: candidate.food,
        confidence: "medium",
        servingDescription: primaryServing.description,
        quantity: 1,
        ...(primaryServing.weightGrams != null
          ? { servingWeightGrams: primaryServing.weightGrams }
          : {}),
        searchServingOptions: servingOptions,
      })
      if (!item) continue

      const deduplicationKey = getSearchItemDeduplicationKey(item)
      const existingIndex = itemIndexesByKey.get(deduplicationKey)
      if (existingIndex == null) {
        itemIndexesByKey.set(deduplicationKey, deduplicatedItems.length)
        deduplicatedItems.push(item)
        continue
      }

      const existingItem = deduplicatedItems[existingIndex]
      if (!existingItem) continue
      const mergedServingOptions = mergeServingOptions(
        existingItem.servingOptions,
        item.servingOptions,
      )
      const mergedPrimaryServing = mergedServingOptions[0]
      deduplicatedItems[existingIndex] = {
        ...existingItem,
        ...(mergedPrimaryServing
          ? {
              servingDescription: mergedPrimaryServing.description,
              servingWeightGrams:
                mergedPrimaryServing.weightGrams ?? existingItem.servingWeightGrams,
              ...mergedPrimaryServing.macros,
            }
          : {}),
        ...((existingItem.category ?? item.category)
          ? { category: existingItem.category ?? item.category }
          : {}),
        servingOptions: mergedServingOptions,
      }
    }

    return deduplicatedItems.slice(0, limit)
  }

  private buildItemsFromCandidates(
    candidates: EdamamParserCandidate[],
    confidence: NutritionAnalysisFoodItem["confidence"],
    barcode?: string,
    limit?: number,
  ): NutritionClassifiableFoodItem[] {
    return candidates
      .flatMap((candidate) => {
        const measureWeightGrams = getSanitizedMeasureWeightGrams(
          candidate.measure?.label,
          candidate.measure?.weight,
        )
        const portion = this.resolveWholeUnitPortion({
          measureLabel: candidate.measure?.label,
          weightGrams: measureWeightGrams,
          foodName: candidate.food.label,
          alternateMeasures: candidate.alternateMeasures,
        })
        const item = this.getFoodItem({
          food: candidate.food,
          confidence,
          servingDescription: candidate.servingDescription,
          ...(candidate.quantity != null ? { quantity: candidate.quantity } : {}),
          ...(portion.weightGrams != null ? { servingWeightGrams: portion.weightGrams } : {}),
          ...(candidate.relevanceTier != null ? { relevanceTier: candidate.relevanceTier } : {}),
          portionAssumed: portion.portionAssumed,
          barcode,
          includeClassificationIngredients: true,
        })
        return item ? [item] : []
      })
      .slice(0, limit ?? EDAMAM_MAX_DESCRIPTION_CANDIDATES)
  }

  private resolveWholeUnitPortion(params: {
    measureLabel: string | undefined
    weightGrams: number | undefined
    foodName: string | undefined
    alternateMeasures?: readonly { label?: string; weight?: number }[]
  }) {
    const resolution = resolveWholeUnitPortionWeightGrams(params)
    if (resolution.portionAssumed) {
      logStructured(this.logger, "warn", {
        event: "nutrition.whole_unit_portion_adjusted",
        foodName: params.foodName,
        measureLabel: params.measureLabel,
        providerWeightGrams: params.weightGrams,
        resolvedWeightGrams: resolution.weightGrams,
      })
    }
    return resolution
  }

  private getVisionItems(payload: unknown): NutritionClassifiableFoodItem[] {
    const parsed = edamamVisionResponseSchema.safeParse(payload)
    if (!parsed.success) return []

    const visionMeasureWeightGrams = getSanitizedMeasureWeightGrams(
      parsed.data.parsed?.measure?.label,
      parsed.data.parsed?.measure?.weight,
    )
    const visionPortion = this.resolveWholeUnitPortion({
      measureLabel: parsed.data.parsed?.measure?.label,
      weightGrams: visionMeasureWeightGrams,
      foodName: parsed.data.parsed?.food?.label,
    })
    const parsedItem = parsed.data.parsed?.food
      ? this.getFoodItem({
          food: parsed.data.parsed.food,
          confidence: "medium",
          servingDescription: parsed.data.parsed.measure?.label,
          ...(parsed.data.parsed.quantity != null ? { quantity: parsed.data.parsed.quantity } : {}),
          ...(visionPortion.weightGrams != null
            ? { servingWeightGrams: visionPortion.weightGrams }
            : {}),
          portionAssumed: visionPortion.portionAssumed,
          includeClassificationIngredients: true,
        })
      : null

    if (parsedItem) return [parsedItem]

    const nutrients = parsed.data.recipe?.totalNutrients
    const label =
      parsed.data.recipe?.label ??
      parsed.data.parsed?.food?.label ??
      parsed.data.parsed?.food?.foodContentsLabel
    if (!nutrients || !label) return []

    const calories = Math.round(parsed.data.recipe?.calories ?? nutrients.ENERC_KCAL?.quantity ?? 0)
    if (calories <= 0) return []

    return [
      {
        id: randomUUID(),
        name: label,
        servingDescription: "Estimated plate",
        quantity: 1,
        calories,
        proteinGrams: Math.round(nutrients.PROCNT?.quantity ?? 0),
        carbGrams: Math.round(nutrients.CHOCDF?.quantity ?? 0),
        fatGrams: Math.round(nutrients.FAT?.quantity ?? 0),
        sugarGrams: Math.round(nutrients.SUGAR?.quantity ?? 0),
        fiberGrams: nutrients.FIBTG?.quantity != null ? Math.round(nutrients.FIBTG.quantity) : null,
        confidence: "medium",
        ...(parsed.data.parsed?.food?.category
          ? { category: parsed.data.parsed.food.category }
          : {}),
        ...(parsed.data.parsed?.food?.foodContentsLabel
          ? { classificationIngredients: parsed.data.parsed.food.foodContentsLabel }
          : {}),
      },
    ]
  }
}
