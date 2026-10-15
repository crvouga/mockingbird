import manifest from "virtual:mockingbird/deployment"
import type { APIRoute } from "astro"

export const prerender = true
export const GET: APIRoute = () =>
  new Response(JSON.stringify(manifest), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
