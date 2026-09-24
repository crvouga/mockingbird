# @crvouga/mockingbird-service-edamam

Stateful mock of the **Edamam** APIs our apps call, answering from a built-in food and recipe
corpus: the Food Database v2 parser (text and UPC), nutrients and image recognition, Nutrition
Analysis (`nutrition-data`, `nutrition-details`), Recipe Search v2 (search with filters and
`_cont` paging, by URI, by id), the Meal Planner v1 `select`, and Shopping List v2. Nutrition
logging, barcode scans, photo logging, recipe search, meal plans and grocery lists then work in
tests without Edamam keys, quotas or network.

- Operation coverage: [SUPPORT.md](https://github.com/crvouga/mockingbird/blob/main/packages/service/edamam/SUPPORT.md)
- The contract (`openapi.yaml`) is hand-authored from Edamam's per-API docs and our consumers:
  `metrics/adapters/outbound/edamam-nutrition.adapter.ts`,
  `meal-planning/adapters/outbound/edamam-meal-planning.adapter.ts`, and the Python chat
  service's `tools/nutrition/client.py`.

## Install

```bash
npm install -D @crvouga/mockingbird-service-edamam
```

ESM only. Node >= 22 or Bun >= 1.2. No native dependencies. Serve it with
`npx mockingbird-edamam serve`, `createServer` from `./server` (Node), or `createRuntime` with
any Fetch server.

## Usage

Both backend adapters hardcode `https://api.edamam.com` (seam: a base-URL env for
`EDAMAM_BASE_URL` / `EDAMAM_MEAL_BASE_URL`, and the Python client's `EDAMAM_BASE_URL`). Keys can be
any values (`EDAMAM_FOOD_APP_ID/KEY` or `EDAMAM_APP_ID/KEY`, `EDAMAM_MEAL_APP_ID/KEY`, the Python
client's `edamam_*` settings); without them our adapters report `unavailable` and never call out.

```bash
npx mockingbird-edamam serve --port 8824
```

```ts
import { createRuntime } from "@crvouga/mockingbird-service-edamam"

const edamam = createRuntime()
const parsed = await edamam.fetch(
  new Request(
    "http://edamam.test/api/food-database/v2/parser?app_id=a&app_key=k&ingr=2%20large%20eggs&nutrition-type=logging",
  ),
)
// → {text, parsed: [{food: {foodId: "food_egg", label: "Egg", nutrients: {ENERC_KCAL: 143, …}},
//     quantity: 2, measure: {uri: "…#Measure_large", label: "Large", weight: 50}}], hints: […]}
```

### Routes

Every call takes `app_id` and `app_key` as query parameters (the meal planner and shopping list
also accept `Authorization: Basic app_id:app_key`, which our adapter sends).

| Route | Behaviour |
| --- | --- |
| `GET /api/food-database/v2/parser` | `ingr` is parsed into a leading quantity ("2", "1/2", "a", "two"), a measure the food has ("cup", "large", "slice", "g", "oz") and the best-matching food → `parsed[]`; every food sharing a word → `hints[]` with `measures`. Filters: `categoryLabel` (`food` drops meals), `category`, `health` (repeatable), `calories` (per 100 g). `upc` looks up a packaged food (unknown UPC 404). |
| `POST /api/food-database/v2/nutrients` | `{ingredients: [{quantity, measureURI, foodId}]}` → `calories`, `totalWeight`, `totalNutrients`, `totalDaily`, `dietLabels`, `healthLabels`, `ingredients[].parsed[]`; an unknown food or measure is 422. |
| `POST /api/food-database/nutrients-from-image?beta=true` | `{image: data URL or http URL}` → `{parsed: {food, quantity, measure}, recipe: {label, calories, totalNutrients}}`, deterministic per image (or pinned with `PUT /__admin/vision`). |
| `GET /api/nutrition-data?ingr=` | One ingredient line; unparsable is 422. |
| `POST /api/nutrition-details` | `{ingr: [...], title?, yield?}`; no lines is 422, any unparsable line 555. |
| `GET /api/recipes/v2` | `type` required; `q`, `health`, `diet`, `mealType`, `dishType`, `cuisineType`, `excluded` (repeatable), `calories` and `nutrients[CODE]` ranges per serving, `time`, `random`, `imageSize`. 20 per page; `_links.next.href` carries `_cont`. |
| `GET /api/recipes/v2/by-uri` | Up to 20 `uri` parameters; unknown URIs are skipped. |
| `GET /api/recipes/v2/{id}` | One recipe (the `_links.self` target). |
| `POST /api/meal-planner/v1/{app_id}/select` | `{size, plan: {accept, fit, exclude, sections: {Breakfast: {…}, …}}}` → `{status: OK \| INCOMPLETE, selection: [{sections: {<name>: {assigned, _links}}}]}`. Each section gets a recipe satisfying its and the plan's `accept` predicates (`health`, `meal`, `dish`), its per-serving `fit`, and `exclude`, varying by day; an unfillable section has no `assigned` and the status is `INCOMPLETE`. A plan without sections is 400. |
| `POST /api/shopping-list/v2` | `{entries: [{quantity, measure?: Measure_serving, item: recipe uri}]}` → ingredients aggregated per food in grams (`Measure_serving` scales by servings over the recipe's yield); `?shopping-cart=true&beta=true` adds `_links.shopping-cart`. |

Errors: Food Database and Nutrition Analysis answer `{status: "error", error, message}`;
Recipe Search, Meal Planner and Shopping List answer `[{errorCode, message, params}]`.

**Corpus** (`DEFAULT_FOODS`, `DEFAULT_RECIPES`): 18 foods with per-100 g nutrients and measures
(including a meal, two packaged products with UPCs `850000000012` and `850000000036`, and one
UPC `850000000029` with no nutrition data) and 8 recipes built from them, so recipe totals,
per-serving values and shopping lists agree with the food database.

### Admin (beyond the standard contract)

| Route | Effect |
| --- | --- |
| `GET` / `POST /__admin/foods` | List foods, or add one (`{foodId, label, nutrients, measures: [{uri, label, weight}], upc?, brand?, category?, categoryLabel?, healthLabels?}`). |
| `GET` / `POST /__admin/recipes` | List recipes, or add one (`{id, label, yield, ingredients: [{foodId, quantity, measure, text}], mealType?, dishType?, cuisineType?, dietLabels?, healthLabels?, cautions?, totalTime?}`). |
| `PUT /__admin/vision` | `{foodId, quantity?, measure?}` pins what image recognition returns; `{notFound: true}` recognises nothing; `null` restores the default. |
| `GET/PUT /__admin/settings` | `{apps?: [{appId, appKey}], requireAccountUser?}`. |

Fault presets (`POST /__admin/faults {"preset": "<name>", "count"?: n}`): `rate_limited` (429),
`payment_required` (402), `unauthorized` (401), `server_error` (500), `parser_schema_drift`,
`recipe_quality` (555), `vision_not_found`, `meal_plan_incomplete`, `meal_plan_timeout`,
`slow` (12 s, past our 10 s timeouts), `connection_drop`.

### Namespaces

`x-mockingbird-namespace`, a `/ns/<name>` prefix on the base URL (works for the nutrition adapter
and the Python client, which concatenate paths; the meal adapter resolves paths with
`new URL(endpoint, base)`, which drops a prefix), or by application id:
`PUT /__admin/credentials {"credentials": {"<app_id>": "<namespace>"}}`.

### Deliberately not modelled

- Edamam's NLP and databases: the parser understands leading quantities, known measures and
  corpus food names only; real food and recipe content needs a recorded corpus.
- Food Database autocomplete, brand search and `nutrients` qualifiers; Recipe Search user
  recipes (`type=user`), `field=` projection and images other than the URL.
- Meal Planner plan-level `fit` beyond a day-calorie check, `mark` weighting, nested
  sub-sections, and shopping-cart checkout pages.

## API

| Export | Kind | Description |
| --- | --- | --- |
| `EdamamAPI` | class | The in-process mock: `fetch(request)`, `reset()`, `addFood(food)`, `addRecipe(seed)`, `recipes()`. Options: `sqlite`, `now`, `namespace`, `foods`, `recipes`, `settings`. |
| `createRuntime` | function | The mock with the full service contract (health, admin, namespaces, credentials, presets). Options: `foods`, `recipes`, `settings`, `clock`, `seed`, `adminKey`, `onLog`, `sqlite`. |
| `EDAMAM_PRESETS` | object | Every named fault preset. |
| `EDAMAM_NAMESPACE` | string | The service name, `"edamam"`. |
| `ACCOUNT_USER_HEADER` | string | `edamam-account-user`. |
| `DEFAULT_FOODS`, `DEFAULT_RECIPES` | arrays | The built-in corpus. |
| `MEASURE_URI`, `RECIPE_URI`, `NUTRIENTS` | values | Edamam's measure and recipe URI prefixes, and the nutrient codes served. |
| `buildRecipe` | function | A recipe in Recipe Search v2 shape from a seed and the food corpus. |
| `parseLine` | function | The ingredient-line parser. |
| `perServing` | function | A recipe's per-serving value of a nutrient code. |
| `appIdCredential` | function | The `app_id` a request carries (how credentials map to namespaces). |
| `foodError`, `recipeErrors` | functions | Build each API family's error response. |
| `document`, `operationIds`, `supportedOperationIds` | values | The OpenAPI contract and its operation ids. |
| `createServer`, `serveTarget`, `DEFAULT_PORT` (`./server`) | Node | Serve over `node:http`; the `serve` CLI target (`--app`, `--require-account-user`); port 8824. |

Part of [mockingbird](https://github.com/crvouga/mockingbird).
