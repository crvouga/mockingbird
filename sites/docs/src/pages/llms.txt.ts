import catalog from "virtual:mockingbird/catalog"
import type { APIRoute } from "astro"
import { CATEGORIES, type CategorySlug } from "../lib/categories.ts"

export const GET: APIRoute = () => {
  const lines = [
    "# Mockingbird",
    "",
    `> Stateful mocks for ${catalog.totals.services} third-party APIs and SQL databases. Each service README below is the integration guide and ships inside the npm package.`,
    "",
    "This site is generated from the service packages. Prefer the markdown links over the HTML pages.",
    "",
    `- [Catalog JSON](${absolute("/catalog.json")}): surfaces, runtimes, and operation coverage`,
    `- [Full text](${absolute("/llms-full.txt")}): every README in one file`,
    `- [Why](${absolute("/why.md")}): what Mockingbird is for`,
    "",
    "## Services",
    "",
  ]
  for (const service of catalog.services) {
    const category = CATEGORIES[service.category as CategorySlug].label
    lines.push(
      `- [${service.displayName}](${absolute(`/services/${service.name}.md`)}): ${service.description} (${category}, \`${service.packageName}\`)`,
    )
  }
  lines.push("")
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

const absolute = (path: string) => path
