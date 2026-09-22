import { z } from "zod"

const edamamLinkSchema = z
  .object({
    href: z.string().url(),
  })
  .passthrough()

const edamamRecipeIngredientSchema = z
  .object({
    food: z.string().min(1),
    quantity: z.number(),
    measure: z.string().nullable().optional(),
    weight: z.number().nullable().optional(),
    foodId: z.string().nullable().optional(),
    foodCategory: z.string().nullable().optional(),
  })
  .passthrough()

const edamamRecipeNutrientSchema = z
  .object({
    label: z.string().min(1),
    quantity: z.number(),
    unit: z.string().min(1),
  })
  .passthrough()

const edamamRecipeSchema = z
  .object({
    uri: z.string().min(1),
    label: z.string().min(1),
    image: z.string().url().optional(),
    url: z.string().url(),
    yield: z.number(),
    ingredientLines: z.array(z.string()),
    ingredients: z.array(edamamRecipeIngredientSchema),
    totalNutrients: z.record(z.string(), edamamRecipeNutrientSchema),
    cautions: z.array(z.string()),
    dietLabels: z.array(z.string()),
    healthLabels: z.array(z.string()),
  })
  .passthrough()

export const edamamRecipeSearchResponseSchema = z
  .object({
    hits: z.array(
      z
        .object({
          recipe: edamamRecipeSchema,
        })
        .passthrough(),
    ),
    _links: z
      .object({
        next: edamamLinkSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const edamamMealPlanSectionSchema = z
  .object({
    assigned: z.string().min(1).optional(),
    _links: z
      .object({
        self: edamamLinkSchema,
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const edamamMealPlanResponseSchema = z
  .object({
    status: z.enum(["OK", "INCOMPLETE", "TIME_OUT"]).optional(),
    selection: z
      .array(
        z
          .object({
            sections: z.record(z.string(), edamamMealPlanSectionSchema),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()
  .refine((payload) => payload.status !== undefined || payload.selection !== undefined)

const edamamShoppingQuantitySchema = z
  .object({
    quantity: z.number(),
    measure: z.string().min(1),
    qualifiers: z.array(z.string()).optional(),
  })
  .passthrough()

export const edamamShoppingListResponseSchema = z
  .object({
    entries: z.array(
      z
        .object({
          foodId: z.string().min(1),
          food: z.string().min(1),
          quantities: z.array(edamamShoppingQuantitySchema),
        })
        .passthrough(),
    ),
    _links: z
      .object({
        "shopping-cart": edamamLinkSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
