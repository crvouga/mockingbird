export type CommonFoodNutrition = {
  calories: number
  proteinGrams: number
  carbGrams: number
  fatGrams: number
  sugarGrams: number
  fiberGrams: number | null
}

export type CommonFood = CommonFoodNutrition & {
  matcher: RegExp
  name: string
  servingDescription: string
}

export const DEFAULT_FALLBACK_FOOD_NAME = "Vegetables"

export const GENERIC_NUTRITION_DESCRIPTIONS = new Set([
  "photo",
  "image",
  "meal photo",
  "food photo",
  "meal image",
])

export const COMMON_FOODS: CommonFood[] = [
  {
    matcher: /\b(?:uncured\s+)?turkey bacon\b/i,
    name: "Turkey bacon",
    servingDescription: "2 slices",
    calories: 60,
    proteinGrams: 6,
    carbGrams: 0,
    fatGrams: 4,
    sugarGrams: 0,
    fiberGrams: null,
  },
  {
    matcher: /\bchicken\b/i,
    name: "Chicken",
    servingDescription: "1 serving",
    calories: 220,
    proteinGrams: 35,
    carbGrams: 0,
    fatGrams: 8,
    sugarGrams: 0,
    fiberGrams: null,
  },
  {
    matcher: /\bturkey\b(?!\s+bacon\b)/i,
    name: "Turkey",
    servingDescription: "1 serving",
    calories: 180,
    proteinGrams: 32,
    carbGrams: 0,
    fatGrams: 6,
    sugarGrams: 0,
    fiberGrams: null,
  },
  {
    matcher: /\beggs?\b(?!\s+whites?\b)/i,
    name: "Eggs",
    servingDescription: "2 eggs",
    calories: 140,
    proteinGrams: 12,
    carbGrams: 1,
    fatGrams: 10,
    sugarGrams: 0,
    fiberGrams: null,
  },
  {
    matcher: /\b(egg whites|egg white)\b/i,
    name: "Egg whites",
    servingDescription: "1 cup",
    calories: 126,
    proteinGrams: 26,
    carbGrams: 2,
    fatGrams: 0,
    sugarGrams: 2,
    fiberGrams: null,
  },
  {
    matcher: /\b(cottage cheese)\b/i,
    name: "Cottage cheese",
    servingDescription: "3/4 cup",
    calories: 150,
    proteinGrams: 21,
    carbGrams: 7,
    fatGrams: 4,
    sugarGrams: 7,
    fiberGrams: null,
  },
  {
    matcher: /\b(rice|quinoa|pasta)\b/i,
    name: "Grain",
    servingDescription: "1 cup cooked",
    calories: 210,
    proteinGrams: 5,
    carbGrams: 42,
    fatGrams: 2,
    sugarGrams: 1,
    fiberGrams: null,
  },
  {
    matcher: /\b(salmon|fish|tuna)\b/i,
    name: "Fish",
    servingDescription: "1 serving",
    calories: 250,
    proteinGrams: 34,
    carbGrams: 0,
    fatGrams: 12,
    sugarGrams: 0,
    fiberGrams: null,
  },
  {
    matcher: /\b(avocado)\b/i,
    name: "Avocado",
    servingDescription: "1/2 avocado",
    calories: 160,
    proteinGrams: 2,
    carbGrams: 8,
    fatGrams: 15,
    sugarGrams: 1,
    fiberGrams: null,
  },
  {
    matcher: /\b(bell peppers?|red peppers?|green peppers?|yellow peppers?)\b/i,
    name: "Bell pepper",
    servingDescription: "1 serving",
    calories: 30,
    proteinGrams: 1,
    carbGrams: 7,
    fatGrams: 0,
    sugarGrams: 4,
    fiberGrams: null,
  },
  {
    matcher: /\bmushrooms?\b/i,
    name: "Mushrooms",
    servingDescription: "1 serving",
    calories: 20,
    proteinGrams: 3,
    carbGrams: 3,
    fatGrams: 0,
    sugarGrams: 1,
    fiberGrams: null,
  },
  {
    matcher: /\b(salad|lettuce|romaine|spinach|greens|broccoli|vegetables|veggies)\b/i,
    name: "Vegetables",
    servingDescription: "1 serving",
    calories: 60,
    proteinGrams: 3,
    carbGrams: 10,
    fatGrams: 1,
    sugarGrams: 3,
    fiberGrams: null,
  },
  {
    matcher: /\b(yogurt|greek yogurt)\b/i,
    name: "Greek yogurt",
    servingDescription: "1 cup",
    calories: 150,
    proteinGrams: 20,
    carbGrams: 9,
    fatGrams: 4,
    sugarGrams: 7,
    fiberGrams: null,
  },
  {
    matcher: /\b(blueberries)\b/i,
    name: "Blueberries",
    servingDescription: "1 serving",
    calories: 95,
    proteinGrams: 1,
    carbGrams: 24,
    fatGrams: 0,
    sugarGrams: 15,
    fiberGrams: null,
  },
  {
    matcher: /\b(berries|apples?|bananas?|fruit)\b/i,
    name: "Fruit",
    servingDescription: "1 serving",
    calories: 95,
    proteinGrams: 1,
    carbGrams: 24,
    fatGrams: 0,
    sugarGrams: 15,
    fiberGrams: null,
  },
  {
    matcher: /\b(peanut butter)\b/i,
    name: "Peanut butter",
    servingDescription: "2 tablespoons",
    calories: 190,
    proteinGrams: 7,
    carbGrams: 7,
    fatGrams: 16,
    sugarGrams: 2,
    fiberGrams: null,
  },
  {
    matcher: /\b(almond butter|nut butter)\b/i,
    name: "Almond butter",
    servingDescription: "2 tablespoons",
    calories: 190,
    proteinGrams: 7,
    carbGrams: 7,
    fatGrams: 16,
    sugarGrams: 2,
    fiberGrams: null,
  },
  {
    matcher: /\b(protein powder|hydrolyzed beef)\b/i,
    name: "Protein powder",
    servingDescription: "1 scoop",
    calories: 120,
    proteinGrams: 24,
    carbGrams: 2,
    fatGrams: 1,
    sugarGrams: 1,
    fiberGrams: null,
  },
  {
    matcher: /\b(almond milk)\b/i,
    name: "Almond milk",
    servingDescription: "1 cup",
    calories: 40,
    proteinGrams: 1,
    carbGrams: 2,
    fatGrams: 3,
    sugarGrams: 0,
    fiberGrams: null,
  },
  {
    matcher: /\b(beet|beets|beats)\b/i,
    name: "Beets",
    servingDescription: "1 serving",
    calories: 70,
    proteinGrams: 2,
    carbGrams: 16,
    fatGrams: 0,
    sugarGrams: 11,
    fiberGrams: null,
  },
  {
    matcher: /\b(olive|olives)\b(?!\s+oil)/i,
    name: "Olives",
    servingDescription: "1 serving",
    calories: 40,
    proteinGrams: 0,
    carbGrams: 1,
    fatGrams: 4,
    sugarGrams: 0,
    fiberGrams: null,
  },
  {
    matcher: /\b(hummus)\b/i,
    name: "Hummus",
    servingDescription: "1 serving",
    calories: 70,
    proteinGrams: 2,
    carbGrams: 4,
    fatGrams: 5,
    sugarGrams: 0,
    fiberGrams: null,
  },
]

export type TablespoonPortionOverride = {
  matcher: RegExp
  excludeMatcher?: RegExp
  referenceTablespoons: number
  nutrition: CommonFoodNutrition
}

export const TABLESPOON_PORTION_OVERRIDES: TablespoonPortionOverride[] = [
  {
    matcher: /\b(olive|olives)\b(?!\s+oil)/i,
    excludeMatcher: /\boils?\b/i,
    referenceTablespoons: 1,
    nutrition: {
      calories: 9,
      proteinGrams: 0,
      carbGrams: 1,
      fatGrams: 1,
      sugarGrams: 0,
      fiberGrams: null,
    },
  },
  {
    matcher: /\bhummus\b/i,
    referenceTablespoons: 2,
    nutrition: {
      calories: 71,
      proteinGrams: 2,
      carbGrams: 5,
      fatGrams: 5,
      sugarGrams: 0,
      fiberGrams: null,
    },
  },
]

export type WholeUnitFoodStandard = {
  matcher: RegExp
  excludeMatcher?: RegExp
  minimumGrams: number
  maximumGrams: number
  typicalGrams: number
}

const PORTIONED_CUT_EXCLUSIONS =
  /\b(?:strips?|tenders?|tenderloins?|nuggets?|bites?|chunks?|cubes?|slices?|sliced|diced|shredded|ground|minced|deli|jerky|sausages?|patt(?:y|ies)|burgers?|salad|soup|spread|nachos?|wraps?|sandwich(?:es)?|pizzas?)\b/i

export const WHOLE_UNIT_FOOD_STANDARDS: WholeUnitFoodStandard[] = [
  {
    matcher: /\bchicken\s+breasts?\b/i,
    excludeMatcher: PORTIONED_CUT_EXCLUSIONS,
    minimumGrams: 80,
    maximumGrams: 450,
    typicalGrams: 172,
  },
  {
    matcher: /\bturkey\s+breasts?\b/i,
    excludeMatcher: PORTIONED_CUT_EXCLUSIONS,
    minimumGrams: 80,
    maximumGrams: 600,
    typicalGrams: 175,
  },
  {
    matcher: /\bchicken\s+thighs?\b/i,
    excludeMatcher: PORTIONED_CUT_EXCLUSIONS,
    minimumGrams: 40,
    maximumGrams: 250,
    typicalGrams: 95,
  },
  {
    matcher: /\bpork\s+chops?\b/i,
    excludeMatcher: PORTIONED_CUT_EXCLUSIONS,
    minimumGrams: 60,
    maximumGrams: 400,
    typicalGrams: 150,
  },
  {
    matcher:
      /\b(?:salmon|tuna|cod|tilapia|halibut|haddock|trout|sea\s*bass|mahi\s*mahi)\s+(?:fille?ts?|steaks?)\b/i,
    excludeMatcher: PORTIONED_CUT_EXCLUSIONS,
    minimumGrams: 60,
    maximumGrams: 400,
    typicalGrams: 150,
  },
  {
    matcher: /\beggs?\b/i,
    excludeMatcher:
      /\begg\s*plants?\b|\beggplants?\b|\b(?:whites?|yolks?|noodles?|rolls?|nog|beaters?|substitutes?|liquid|powdered?|dried|wash|drop|foo\s*young|bites?|mcmuffin|benedict|salad|casserole|scramble|omelettes?|omelets?)\b/i,
    minimumGrams: 25,
    maximumGrams: 95,
    typicalGrams: 50,
  },
  {
    matcher: /\bapples?\b/i,
    excludeMatcher:
      /\b(?:juices?|ciders?|sauces?|butter|pies?|chips?|crisps?|turnovers?|strudels?|dumplings?|jacks?|dried|rings?|custard|fritters?|tarts?|cakes?|breads?|muffins?)\b/i,
    minimumGrams: 70,
    maximumGrams: 400,
    typicalGrams: 182,
  },
  {
    matcher: /\bbananas?\b/i,
    excludeMatcher:
      /\b(?:breads?|chips?|puddings?|smoothies?|shakes?|splits?|muffins?|pancakes?|cakes?|creams?|dried|flour|powder)\b/i,
    minimumGrams: 60,
    maximumGrams: 300,
    typicalGrams: 118,
  },
]

export const NUMBER_WORDS = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
])
