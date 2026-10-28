import type { Scenario } from "../harness.js"
import { scenarios as bucketConfig } from "./parts/config-bucket.js"
import { scenarios as misc } from "./parts/config-misc.js"

export const scenarios: Scenario[] = [...bucketConfig, ...misc]
