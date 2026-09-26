/**
 * Loaders for full-stack app examples (`../lib/appExamples.ts`). Small and
 * hand-maintained on purpose — unlike `virtual:mockingbird/examples`, which
 * the catalog integration derives from every service's own package.json,
 * there is exactly one of these per app, not per service.
 */
import { defineExampleLauncher } from "./exampleModal.ts"

const appLoaders: Record<string, () => Promise<{ mount: unknown }>> = {
  "medical-testing": () => import("@crvouga/mockingbird-example-medical-testing/browser"),
}

defineExampleLauncher("app-example", (key) => appLoaders[key])
