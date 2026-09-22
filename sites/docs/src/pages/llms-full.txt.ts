import catalog from "virtual:mockingbird/catalog"
import type { APIRoute } from "astro"
import { TIERS } from "../lib/tiers.ts"

export const GET: APIRoute = () => {
  const parts = [
    "# Mockingbird",
    "",
    "Every service README, generated from the packages. The HTML site is a view of this same text.",
    "",
  ]
  for (const service of catalog.services) {
    parts.push(
      "-----",
      "",
      `# ${service.displayName}`,
      "",
      `Package: \`${service.packageName}\``,
      `Tier: ${TIERS[service.status].label}`,
      `Source: ${service.links.source}`,
      "",
      service.readme.markdown.trim(),
      "",
    )
  }
  return new Response(parts.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}
