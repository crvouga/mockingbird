import { exampleLoaders } from "virtual:mockingbird/examples"
import { defineExampleLauncher } from "./exampleModal.ts"

defineExampleLauncher("service-example", (key) => exampleLoaders[key])
