export function getNutritionProviderErrorName(error: unknown) {
  return error instanceof Error && error.name ? error.name : "UnknownError"
}
