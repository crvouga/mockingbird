import type { Meta } from "@storybook/html-vite"
import { openapiDocument, signedIn } from "./fixtures.js"
import { ok } from "./mock.js"
import { story } from "./story.js"

export default { title: "API reference" } satisfies Meta

/** Drawn from the server's own OpenAPI document. */
export const Reference = story({
  path: "/api-reference",
  routes: { ...signedIn(), "GET /api/openapi.json": ok(openapiDocument) },
})
