import catalog from "virtual:mockingbird/catalog"
import type { APIRoute } from "astro"

/** The repo's generated llms.txt, byte for byte: one index for agents, wherever they read it. */
export const GET: APIRoute = () =>
  new Response(catalog.llmsTxt, { headers: { "content-type": "text/plain; charset=utf-8" } })
