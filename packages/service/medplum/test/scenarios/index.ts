import type { Scenario } from "../harness/scenario.js"
import { adminScenarios } from "./admin.js"
import { authScenarios } from "./auth.js"
import { crudScenarios } from "./crud.js"
import { miscScenarios } from "./misc.js"
import { searchScenarios } from "./search.js"
import { writeScenarios } from "./writes.js"

export const scenarios: Scenario[] = [
  ...crudScenarios,
  ...searchScenarios,
  ...writeScenarios,
  ...authScenarios,
  ...adminScenarios,
  ...miscScenarios,
]
