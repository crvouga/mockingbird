import catalog from "virtual:mockingbird/catalog"
import type { APIRoute, GetStaticPaths } from "astro"

export const getStaticPaths = (() =>
  catalog.guides.map((g) => ({
    params: { slug: g.slug },
    props: { markdown: g.markdown },
  }))) satisfies GetStaticPaths

export const GET: APIRoute = ({ props }) =>
  new Response(String(props.markdown), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  })
