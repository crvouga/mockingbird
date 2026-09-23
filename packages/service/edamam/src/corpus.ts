/**
 * The built-in food and recipe corpus. Edamam's databases are proprietary, so these rows are
 * synthesised in Edamam's exact shapes with realistic per-100 g nutrients (USDA-like values),
 * enough for the parser, nutrients, recipe search, meal planner and shopping list to answer
 * the questions our apps ask. Recipes are built from corpus foods, so their totals, per-serving
 * values and shopping lists stay consistent with the food database.
 */
export const MEASURE_URI = "http://www.edamam.com/ontologies/edamam.owl#Measure_"
export const RECIPE_URI = "http://www.edamam.com/ontologies/edamam.owl#recipe_"

export type NutrientCode = "ENERC_KCAL" | "PROCNT" | "FAT" | "CHOCDF" | "FIBTG" | "SUGAR"

export const NUTRIENTS: Record<NutrientCode, { label: string; unit: string; daily: number }> = {
  ENERC_KCAL: { label: "Energy", unit: "kcal", daily: 2000 },
  PROCNT: { label: "Protein", unit: "g", daily: 50 },
  FAT: { label: "Fat", unit: "g", daily: 78 },
  CHOCDF: { label: "Carbs", unit: "g", daily: 275 },
  FIBTG: { label: "Fiber", unit: "g", daily: 28 },
  SUGAR: { label: "Sugars", unit: "g", daily: 50 },
}

export type Measure = { uri: string; label: string; weight: number }

export type Food = {
  foodId: string
  label: string
  knownAs: string
  /** Per 100 g. Empty for a product Edamam knows by UPC but has no nutrition data for. */
  nutrients: Partial<Record<NutrientCode, number>>
  category: "Generic foods" | "Packaged foods" | "Generic meals"
  categoryLabel: "food" | "meal"
  image: string
  brand?: string
  foodContentsLabel?: string
  servingSizes?: { uri: string; label: string; quantity: number }[]
  /** Internal: the measures a hint lists, and what the parser accepts. */
  measures: Measure[]
  /** Internal: barcode for UPC lookups. */
  upc?: string
  /** Internal: for the `health` filter. */
  healthLabels: string[]
}

const m = (label: string, weight: number, name = label): Measure => ({
  uri: `${MEASURE_URI}${name.toLowerCase().replace(/\s+/g, "_")}`,
  label,
  weight,
})
const gram = m("Gram", 1)
const ounce = m("Ounce", 28.349_523_125)
const pound = m("Pound", 453.592_37)
const kilogram = m("Kilogram", 1000)
const weights = [gram, ounce, pound, kilogram]

const food = (
  id: string,
  label: string,
  nutrients: Food["nutrients"],
  measures: Measure[],
  extra: Partial<Food> = {},
): Food => ({
  foodId: `food_${id}`,
  label,
  knownAs: label.toLowerCase(),
  nutrients,
  category: "Generic foods",
  categoryLabel: "food",
  image: `https://www.edamam.com/food-img/${id}.jpg`,
  measures: [...measures, ...weights],
  healthLabels: [],
  ...extra,
})

const VEG = ["VEGETARIAN", "PESCATARIAN", "GLUTEN_FREE", "DAIRY_FREE"]
const VEGAN = [...VEG, "VEGAN"]

export const DEFAULT_FOODS: readonly Food[] = [
  food(
    "egg",
    "Egg",
    { ENERC_KCAL: 143, PROCNT: 12.6, FAT: 9.5, CHOCDF: 0.7, FIBTG: 0, SUGAR: 0.4 },
    [
      m("Whole", 50, "unit"),
      m("Serving", 50),
      m("Large", 50),
      m("Medium", 44),
      m("Small", 38),
      m("Cup", 243),
    ],
    { healthLabels: ["VEGETARIAN", "GLUTEN_FREE", "DAIRY_FREE"] },
  ),
  food(
    "chicken_breast",
    "Chicken Breast",
    { ENERC_KCAL: 165, PROCNT: 31, FAT: 3.6, CHOCDF: 0, FIBTG: 0, SUGAR: 0 },
    [m("Whole", 174, "unit"), m("Serving", 120), m("Breast", 174), m("Cup", 140)],
    { healthLabels: ["GLUTEN_FREE", "DAIRY_FREE"] },
  ),
  food(
    "rice_cooked",
    "Cooked White Rice",
    { ENERC_KCAL: 130, PROCNT: 2.7, FAT: 0.3, CHOCDF: 28.2, FIBTG: 0.4, SUGAR: 0.1 },
    [m("Serving", 158), m("Cup", 158), m("Tablespoon", 10)],
    { knownAs: "rice", healthLabels: VEGAN },
  ),
  food(
    "banana",
    "Banana",
    { ENERC_KCAL: 89, PROCNT: 1.1, FAT: 0.3, CHOCDF: 22.8, FIBTG: 2.6, SUGAR: 12.2 },
    [m("Whole", 118, "unit"), m("Serving", 118), m("Medium", 118), m("Cup", 150)],
    { healthLabels: VEGAN },
  ),
  food(
    "apple",
    "Apple",
    { ENERC_KCAL: 52, PROCNT: 0.3, FAT: 0.2, CHOCDF: 13.8, FIBTG: 2.4, SUGAR: 10.4 },
    [m("Whole", 182, "unit"), m("Serving", 182), m("Cup", 125)],
    { healthLabels: VEGAN },
  ),
  food(
    "oats",
    "Oats",
    { ENERC_KCAL: 389, PROCNT: 16.9, FAT: 6.9, CHOCDF: 66.3, FIBTG: 10.6, SUGAR: 1 },
    [m("Serving", 40), m("Cup", 81), m("Tablespoon", 5)],
    { knownAs: "oatmeal", healthLabels: VEGAN },
  ),
  food(
    "milk",
    "Whole Milk",
    { ENERC_KCAL: 61, PROCNT: 3.2, FAT: 3.3, CHOCDF: 4.8, FIBTG: 0, SUGAR: 5.1 },
    [m("Serving", 244), m("Cup", 244), m("Fluid ounce", 30.5)],
    { knownAs: "milk", healthLabels: ["VEGETARIAN", "GLUTEN_FREE"] },
  ),
  food(
    "greek_yogurt",
    "Greek Yogurt",
    { ENERC_KCAL: 59, PROCNT: 10.2, FAT: 0.4, CHOCDF: 3.6, FIBTG: 0, SUGAR: 3.2 },
    [m("Container", 170), m("Serving", 170), m("Cup", 245)],
    { knownAs: "yogurt", healthLabels: ["VEGETARIAN", "GLUTEN_FREE"] },
  ),
  food(
    "salmon",
    "Salmon",
    { ENERC_KCAL: 208, PROCNT: 20.4, FAT: 13.4, CHOCDF: 0, FIBTG: 0, SUGAR: 0 },
    [m("Fillet", 198), m("Serving", 113)],
    { healthLabels: ["PESCATARIAN", "GLUTEN_FREE", "DAIRY_FREE"] },
  ),
  food(
    "avocado",
    "Avocado",
    { ENERC_KCAL: 160, PROCNT: 2, FAT: 14.7, CHOCDF: 8.5, FIBTG: 6.7, SUGAR: 0.7 },
    [m("Whole", 201, "unit"), m("Serving", 50), m("Cup", 150)],
    { healthLabels: VEGAN },
  ),
  food(
    "almonds",
    "Almonds",
    { ENERC_KCAL: 579, PROCNT: 21.2, FAT: 49.9, CHOCDF: 21.6, FIBTG: 12.5, SUGAR: 4.4 },
    [m("Serving", 28), m("Cup", 143), m("Almond", 1.2)],
    { healthLabels: VEGAN },
  ),
  food(
    "bread",
    "Whole Wheat Bread",
    { ENERC_KCAL: 247, PROCNT: 13, FAT: 3.4, CHOCDF: 41, FIBTG: 7, SUGAR: 6 },
    [m("Slice", 32), m("Serving", 32)],
    { knownAs: "bread", healthLabels: ["VEGETARIAN", "VEGAN", "DAIRY_FREE"] },
  ),
  food(
    "spinach",
    "Spinach",
    { ENERC_KCAL: 23, PROCNT: 2.9, FAT: 0.4, CHOCDF: 3.6, FIBTG: 2.2, SUGAR: 0.4 },
    [m("Cup", 30), m("Serving", 30), m("Bunch", 340)],
    { healthLabels: VEGAN },
  ),
  food(
    "olive_oil",
    "Olive Oil",
    { ENERC_KCAL: 884, PROCNT: 0, FAT: 100, CHOCDF: 0, FIBTG: 0, SUGAR: 0 },
    [m("Tablespoon", 13.5), m("Teaspoon", 4.5), m("Serving", 13.5)],
    { knownAs: "oil", healthLabels: VEGAN },
  ),
  food(
    "chicken_salad",
    "Chicken Salad",
    { ENERC_KCAL: 229, PROCNT: 13.2, FAT: 18, CHOCDF: 3.3, FIBTG: 0.4, SUGAR: 1.9 },
    [m("Serving", 226), m("Cup", 226)],
    {
      category: "Generic meals",
      categoryLabel: "meal",
      foodContentsLabel: "chicken; mayonnaise; celery; onion",
      healthLabels: ["GLUTEN_FREE"],
    },
  ),
  food(
    "protein_bar",
    "Protein Bar",
    { ENERC_KCAL: 350, PROCNT: 30, FAT: 10, CHOCDF: 40, FIBTG: 12, SUGAR: 5 },
    [m("Serving", 60), m("Package", 60)],
    {
      category: "Packaged foods",
      brand: "Mockingbird Foods",
      foodContentsLabel: "protein blend; almonds; chicory root fiber; cocoa",
      servingSizes: [{ uri: `${MEASURE_URI}gram`, label: "Gram", quantity: 60 }],
      upc: "850000000012",
      healthLabels: ["VEGETARIAN", "GLUTEN_FREE"],
    },
  ),
  food("mystery_snack", "Mystery Snack", {}, [m("Package", 40)], {
    category: "Packaged foods",
    brand: "Mockingbird Foods",
    upc: "850000000029",
  }),
  food(
    "plain_greek_yogurt",
    "Plain Greek Yogurt",
    { ENERC_KCAL: 59, PROCNT: 10, FAT: 0.4, CHOCDF: 3.5, FIBTG: 0, SUGAR: 3.3 },
    [m("Container", 170), m("Serving", 170)],
    {
      category: "Packaged foods",
      brand: "Mockingbird Dairy",
      foodContentsLabel: "cultured pasteurized nonfat milk",
      servingSizes: [{ uri: `${MEASURE_URI}container`, label: "Container", quantity: 1 }],
      upc: "850000000036",
      healthLabels: ["VEGETARIAN", "GLUTEN_FREE"],
    },
  ),
]

export type RecipeIngredient = { foodId: string; quantity: number; measure: string; text: string }

export type RecipeSeed = {
  id: string
  label: string
  yield: number
  totalTime: number
  mealType: string[]
  dishType: string[]
  cuisineType: string[]
  dietLabels: string[]
  healthLabels: string[]
  cautions: string[]
  ingredients: RecipeIngredient[]
}

const ing = (
  foodId: string,
  quantity: number,
  measure: string,
  text: string,
): RecipeIngredient => ({
  foodId: `food_${foodId}`,
  quantity,
  measure,
  text,
})

export const DEFAULT_RECIPES: readonly RecipeSeed[] = [
  {
    id: "overnight_oats",
    label: "Banana Overnight Oats",
    yield: 2,
    totalTime: 5,
    mealType: ["breakfast"],
    dishType: ["cereals"],
    cuisineType: ["american"],
    dietLabels: ["High-Fiber"],
    healthLabels: ["VEGETARIAN", "PESCATARIAN", "GLUTEN_FREE"],
    cautions: [],
    ingredients: [
      ing("oats", 1, "Cup", "1 cup rolled oats"),
      ing("milk", 1, "Cup", "1 cup milk"),
      ing("banana", 1, "Whole", "1 banana, sliced"),
      ing("greek_yogurt", 0.5, "Cup", "1/2 cup greek yogurt"),
    ],
  },
  {
    id: "veggie_omelette",
    label: "Spinach Omelette",
    yield: 1,
    totalTime: 10,
    mealType: ["breakfast"],
    dishType: ["egg"],
    cuisineType: ["french"],
    dietLabels: ["Low-Carb", "High-Protein"],
    healthLabels: ["VEGETARIAN", "PESCATARIAN", "GLUTEN_FREE", "DAIRY_FREE"],
    cautions: [],
    ingredients: [
      ing("egg", 3, "Large", "3 large eggs"),
      ing("spinach", 1, "Cup", "1 cup spinach"),
      ing("olive_oil", 1, "Teaspoon", "1 tsp olive oil"),
    ],
  },
  {
    id: "avocado_toast",
    label: "Avocado Toast",
    yield: 1,
    totalTime: 5,
    mealType: ["breakfast", "lunch/dinner"],
    dishType: ["sandwiches"],
    cuisineType: ["american"],
    dietLabels: ["High-Fiber"],
    healthLabels: ["VEGAN", "VEGETARIAN", "PESCATARIAN", "DAIRY_FREE"],
    cautions: [],
    ingredients: [
      ing("bread", 2, "Slice", "2 slices whole wheat bread"),
      ing("avocado", 1, "Whole", "1 avocado"),
      ing("olive_oil", 1, "Teaspoon", "1 tsp olive oil"),
    ],
  },
  {
    id: "chicken_rice_bowl",
    label: "Chicken and Rice Bowl",
    yield: 2,
    totalTime: 30,
    mealType: ["lunch/dinner"],
    dishType: ["main course"],
    cuisineType: ["asian"],
    dietLabels: ["High-Protein"],
    healthLabels: ["GLUTEN_FREE", "DAIRY_FREE"],
    cautions: [],
    ingredients: [
      ing("chicken_breast", 2, "Breast", "2 chicken breasts"),
      ing("rice_cooked", 2, "Cup", "2 cups cooked rice"),
      ing("spinach", 2, "Cup", "2 cups spinach"),
      ing("olive_oil", 1, "Tablespoon", "1 tbsp olive oil"),
    ],
  },
  {
    id: "baked_salmon",
    label: "Lemon Baked Salmon",
    yield: 2,
    totalTime: 25,
    mealType: ["lunch/dinner"],
    dishType: ["main course"],
    cuisineType: ["mediterranean"],
    dietLabels: ["Low-Carb", "High-Protein"],
    healthLabels: ["PESCATARIAN", "GLUTEN_FREE", "DAIRY_FREE"],
    cautions: ["FODMAP"],
    ingredients: [
      ing("salmon", 2, "Fillet", "2 salmon fillets"),
      ing("olive_oil", 1, "Tablespoon", "1 tbsp olive oil"),
      ing("spinach", 2, "Cup", "2 cups spinach"),
    ],
  },
  {
    id: "chicken_salad_plate",
    label: "Chicken Salad Plate",
    yield: 1,
    totalTime: 10,
    mealType: ["lunch/dinner"],
    dishType: ["salad"],
    cuisineType: ["american"],
    dietLabels: ["Low-Carb"],
    healthLabels: ["GLUTEN_FREE"],
    cautions: ["Eggs"],
    ingredients: [
      ing("chicken_salad", 1, "Cup", "1 cup chicken salad"),
      ing("spinach", 1, "Cup", "1 cup spinach"),
    ],
  },
  {
    id: "yogurt_parfait",
    label: "Greek Yogurt Parfait",
    yield: 1,
    totalTime: 5,
    mealType: ["snack", "breakfast"],
    dishType: ["desserts"],
    cuisineType: ["american"],
    dietLabels: ["High-Protein"],
    healthLabels: ["VEGETARIAN", "PESCATARIAN", "GLUTEN_FREE"],
    cautions: [],
    ingredients: [
      ing("greek_yogurt", 1, "Container", "1 container greek yogurt"),
      ing("almonds", 1, "Serving", "1 oz almonds"),
      ing("banana", 0.5, "Whole", "1/2 banana"),
    ],
  },
  {
    id: "apple_almonds",
    label: "Apple with Almonds",
    yield: 1,
    totalTime: 2,
    mealType: ["snack"],
    dishType: ["starter"],
    cuisineType: ["american"],
    dietLabels: ["Balanced"],
    healthLabels: ["VEGAN", "VEGETARIAN", "PESCATARIAN", "GLUTEN_FREE", "DAIRY_FREE"],
    cautions: [],
    ingredients: [
      ing("apple", 1, "Whole", "1 apple"),
      ing("almonds", 1, "Serving", "1 oz almonds"),
    ],
  },
]
