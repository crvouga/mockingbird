import type { APIRoute } from "astro"
import catalog from "virtual:mockingbird/catalog"
import { CATEGORIES, type CategorySlug } from "../lib/categories.ts"
import { TIER_ORDER, TIERS } from "../lib/tiers.ts"

export const GET: APIRoute = () => {
  const { totals } = catalog
  const lines = [
    "# Mockingbird",
    "",
    `> Stateful test doubles for ${totals.services} third-party HTTP APIs and SQL databases: ${totals.ready} ready to use, ${totals.wip} work in progress. Each mock speaks the vendor's real surface (fetch(Request) → Response), keeps state in an in-memory SQL engine, and is driven by a vendored OpenAPI contract. Install one package per vendor: \`npm install -D @crvouga/mockingbird-service-<name>\`.`,
    "",
    "Every HTTP service exports `createRuntime()` (an in-process fetch), and most ship a Node server (`<package>/server`) and a `mockingbird-<name> serve` CLI. All share `/health`, `/__admin/*` (reset, snapshot, clock, faults, request journal) and per-request namespaces (`x-mockingbird-namespace`). Each README below is the integration guide and also ships in the npm tarball.",
    "",
    `Release tiers: **${TIERS.ready.label}**: ${TIERS.ready.blurb} **${TIERS.wip.label}**: ${TIERS.wip.blurb} Prefer ready services; pin exact versions of work-in-progress ones.`,
    "",
    "- [catalog.json](/catalog.json): every service's package, tier, entry point, surfaces and operation coverage",
    "- [llms-full.txt](/llms-full.txt): every README in one file",
    "",
  ]
  for (const tier of TIER_ORDER) {
    const members = catalog.services.filter((s) => s.status === tier)
    if (members.length === 0) continue
    lines.push(`## ${TIERS[tier].label} (${members.length})`, "")
    for (const s of members) {
      const category = CATEGORIES[s.category as CategorySlug].label
      lines.push(
        `- [${s.displayName}](/services/${s.name}.md): \`${s.packageName}\` (${category}). ${s.description}`,
      )
    }
    lines.push("")
  }
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}
