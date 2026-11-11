import type { Meta } from "@storybook/html-vite"
import { openapiDocument, signedIn } from "./fixtures.js"
import { ok } from "./mock.js"
import { query } from "./story.js"

export default { title: "API reference" } satisfies Meta

/** Every call of the control API, grouped as the OpenAPI document tags them. */
export const Reference = query({
  path: "/api-reference",
  routes: { ...signedIn(), "GET /api/openapi.json": ok(openapiDocument) },
})
