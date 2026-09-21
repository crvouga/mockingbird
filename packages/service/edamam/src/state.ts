import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { DEFAULT_FOODS, DEFAULT_RECIPES, type Food, type RecipeSeed } from "./corpus.js"

/** What `nutrients-from-image` recognises, when a test pins it. */
export type VisionOverride =
  | { foodId: string; quantity?: number; measure?: string }
  | { notFound: true }

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Only these app_id / app_key pairs authenticate; empty means any pair does. */
  apps: { appId: string; appKey: string }[]
  /** Answer 401 to recipe / meal-planner / shopping-list calls without `Edamam-Account-User`. */
  requireAccountUser: boolean
  vision: VisionOverride | null
}

export const DEFAULT_SETTINGS: Settings = { apps: [], requireAccountUser: false, vision: null }

export class EdamamState {
  readonly foods: Collection<Food>
  readonly recipes: Collection<RecipeSeed>
  readonly settings: Collection<Settings>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: {
      foods: readonly Food[]
      recipes: readonly RecipeSeed[]
      settings: Partial<Settings>
    },
  ) {
    this.foods = new Collection(sqlite, namespace, "foods")
    this.recipes = new Collection(sqlite, namespace, "recipes")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (this.foods.count() === 0) {
      for (const food of this.seed.foods.length > 0 ? this.seed.foods : DEFAULT_FOODS) {
        this.foods.insert(food.foodId, food)
      }
    }
    if (this.recipes.count() === 0) {
      for (const recipe of this.seed.recipes.length > 0 ? this.seed.recipes : DEFAULT_RECIPES) {
        this.recipes.insert(recipe.id, recipe)
      }
    }
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  allFoods(): Food[] {
    return this.foods.list({ order: "oldest" }).map((r) => r.value)
  }

  allRecipes(): RecipeSeed[] {
    return this.recipes.list({ order: "oldest" }).map((r) => r.value)
  }
}
