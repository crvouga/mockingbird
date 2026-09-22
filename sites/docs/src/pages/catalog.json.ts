import catalog from "virtual:mockingbird/catalog"
import type { APIRoute } from "astro"
import { CATEGORIES, type CategorySlug } from "../lib/categories.ts"
import { TIERS } from "../lib/tiers.ts"

/** Machine-readable catalog for agents and tools: everything but the rendered docs. */
export const GET: APIRoute = () => {
  const body = {
    $comment:
      "Generated from packages/service/* at build time. Docs for each service: docs.markdown.",
    totals: catalog.totals,
    categories: catalog.categories.map(({ slug, label, blurb, count }) => ({
      slug,
      label,
      blurb,
      count,
    })),
    services: catalog.services.map((s) => ({
      name: s.name,
      package: s.packageName,
      displayName: s.displayName,
      description: s.description,
      category: s.category,
      categoryLabel: CATEGORIES[s.category as CategorySlug].label,
      tier: s.status,
      tierLabel: TIERS[s.status].label,
      runtime: s.runtime,
      kind: s.kind,
      surfaces: s.surfaces,
      install: `npm install -D ${s.packageName}`,
      entry: s.surfaces.inProcess
        ? `import { createRuntime } from "${s.packageName}"`
        : s.kind === "sql"
          ? `import { Database } from "${s.packageName}"`
          : `import * as mock from "${s.packageName}"`,
      operations: {
        supported: s.opsSupported,
        total: s.opsTotal,
        unsupported: s.operations.filter((o) => !o.supported).map((o) => o.id),
      },
      contract: s.contract,
      examples: s.examples.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        url: `/services/${s.name}#example-${e.id}`,
      })),
      docs: {
        page: `/services/${s.name}`,
        markdown: `/services/${s.name}.md`,
        readme: s.links.readme,
        support: s.links.support,
      },
      npm: s.links.npm,
      source: s.links.source,
    })),
  }
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}
