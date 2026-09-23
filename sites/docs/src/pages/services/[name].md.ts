import catalog from "virtual:mockingbird/catalog"
import type { APIRoute } from "astro"

export function getStaticPaths() {
  return catalog.services.map((service) => ({ params: { name: service.name } }))
}

export const GET: APIRoute = ({ params }) => {
  const service = catalog.services.find((item) => item.name === params.name)
  if (!service) return new Response("Not found", { status: 404 })
  return new Response(service.readme.markdown, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  })
}
