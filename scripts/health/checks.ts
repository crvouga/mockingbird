/**
 * Read-only infrastructure checks, composed as uncached root tasks in turbo.json.
 * Register new checks here and add health:<id> scripts/tasks; health.test.ts checks the graph.
 */

import { runDocsHealth } from "./docs.ts"
import { runGitHubHealth } from "./github.ts"
import { runImageHealth } from "./images.ts"
import { runNpmHealth } from "./npm.ts"
import { runPublisherHealth } from "./publishers.ts"
import type { HealthCheck } from "./report.ts"
import { runRepositoryHealth } from "./repository.ts"
import { runSecretsHealth } from "./secrets.ts"

export const checks: HealthCheck[] = [
  {
    id: "npm",
    summary:
      "Packages, latest versions, release tags, dependencies, retirement, and GitHub Releases",
    run: runNpmHealth,
  },
  {
    id: "trusted-publisher",
    summary:
      "npm packages from this repo whose GitHub Actions publisher is missing or cannot npm publish, each with its access page",
    run: () => runPublisherHealth(process.env.MOCKINGBIRD_HEALTH_INTERACTIVE === "1"),
  },
  {
    id: "github",
    summary: "Repository, branch protection, workflows, schedules, latest runs, and cache budget",
    run: runGitHubHealth,
  },
  {
    id: "secrets",
    summary: "GitHub secret names, workflow mappings, and parity readiness",
    run: runSecretsHealth,
  },
  {
    id: "docs",
    summary: "Fleet inventory, pages, catalog, content freshness, and webhook runtime",
    run: runDocsHealth,
  },
  {
    id: "images",
    summary: "GHCR pull, platform, port, and immutable image tag freshness",
    run: runImageHealth,
  },
  {
    id: "repository",
    summary: "OIDC, publishing, manifests, and generated infrastructure configuration",
    run: runRepositoryHealth,
  },
]
