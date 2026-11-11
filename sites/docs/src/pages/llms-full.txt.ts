import catalog from "virtual:mockingbird/catalog"
import type { APIRoute } from "astro"
import { FLEET } from "../lib/content.ts"

export const GET: APIRoute = () => {
  const parts = [
    "# Mockingbird",
    "",
    "Every service README, generated from the packages. The HTML site is a view of this same text.",
    "",
    "## Run the emulators as a fleet",
    "",
    FLEET.intro,
    "",
    "```sh",
    `npm install -D ${FLEET.packages.join(" ")}`,
    "```",
    "",
    `\`${FLEET.configFile}\`:`,
    "",
    "```json",
    FLEET.config,
    "```",
    "",
    "```sh",
    FLEET.serve,
    "```",
    "",
    "Point each SDK's base URL at `services.<name>.url` from `ready.json`, then open the dashboard: the Emulators tab is every emulator's admin UI, the Notifications tab is every message the app sent. A service is named by its package suffix. Each README below also covers running that emulator alone or in-process. Guide: https://mockingbird.chrisvouga.dev/docs/fleets",
    "",
  ]
  for (const service of catalog.services) {
    parts.push(
      "-----",
      "",
      `# ${service.displayName}`,
      "",
      `Package: \`${service.packageName}\``,
      `Parity: ${service.parity}`,
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
