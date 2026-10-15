import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { discoverPackages, root, WORKFLOW_FILE } from "../release/lib.ts"
import { command, inspect, pool, yamlFile } from "./io.ts"
import { type HealthItem, report } from "./report.ts"

export function releaseConfiguration(workflow: Record<string, unknown>): string[] {
  const jobs = workflow.jobs as
    | Record<
        string,
        {
          permissions?: Record<string, string>
          environment?: unknown
          steps?: Array<{ env?: Record<string, string>; with?: Record<string, unknown> }>
        }
      >
    | undefined
  const release = jobs?.release
  const global = workflow.permissions as Record<string, string> | undefined
  const problems: string[] = []
  if (!release) return ["Release job is missing"]
  const effective = release.permissions ?? global
  if (effective?.["id-token"] !== "write") problems.push("Release lacks id-token: write")
  if (effective?.contents !== "write")
    problems.push("Release lacks contents: write for tags and GitHub Releases")
  if (release.environment)
    problems.push("Release is scoped to an environment, unlike the configured npm publisher")
  for (const step of release.steps ?? []) {
    if (step.env?.NODE_AUTH_TOKEN || step.env?.NPM_TOKEN || step.with?.["registry-url"])
      problems.push("Release config adds legacy npm authentication that can interfere with OIDC")
  }
  return problems
}

export async function runRepositoryHealth() {
  const items: HealthItem[] = []
  const errors = releaseConfiguration(yamlFile(`.github/workflows/${WORKFLOW_FILE}`))
  items.push({
    id: "release-oidc",
    status: errors.length ? "fail" : "ok",
    message:
      errors.join("; ") ||
      "Release grants OIDC and tag permissions, uses no environment or legacy npm token.",
    remedy: "Correct .github/workflows/ci.yml and keep it consistent with npm publishers.",
  })
  const publish = yamlFile(".github/workflows/publish.yml")
  const permissions = publish.permissions as Record<string, string> | undefined
  const jobs = publish.jobs as
    | Record<
        string,
        { uses?: string; with?: Record<string, unknown>; secrets?: Record<string, unknown> }
      >
    | undefined
  const docs = jobs?.mockingbird_docs
  const publishing =
    permissions?.packages === "write" &&
    permissions?.["id-token"] === "write" &&
    docs?.uses === "crvouga/workspace/.github/workflows/ci.yml@main" &&
    docs.with?.service_id === "mockingbird-docs" &&
    docs.with?.dockerfile === "sites/docs/Dockerfile" &&
    docs.with?.context === "." &&
    Boolean(docs.secrets?.DEPLOY_DISPATCH_TOKEN)
  items.push({
    id: "docs-publish-contract",
    status: publishing ? "ok" : "fail",
    message: publishing
      ? "Docs publish uses the managed fleet workflow and required permissions."
      : "Docs publish workflow differs from the managed hosting contract.",
    remedy: "Regenerate the managed workflow through crvouga/workspace; do not deploy by hand.",
  })
  for (const pkg of discoverPackages().filter((entry) => entry.isPublic)) {
    const manifest = JSON.parse(readFileSync(pkg.manifestPath, "utf8")) as {
      version?: string
      publishConfig?: { access?: string; provenance?: boolean }
      files?: string[]
    }
    const ready =
      manifest.version === "0.0.0-development" &&
      manifest.publishConfig?.access === "public" &&
      manifest.publishConfig.provenance === true &&
      manifest.files?.includes("dist")
    items.push({
      id: pkg.name,
      status: ready ? "ok" : "fail",
      message: ready
        ? "Public manifest uses release-time versions, provenance, and dist packaging."
        : "Manifest version, public access, provenance, or dist files are misconfigured.",
      remedy: `Inspect ${pkg.relDir}/package.json.`,
    })
  }
  const syncs = [
    "check:agents",
    "check:worktree",
    "check:llms",
    "check:readme",
    "check:brands",
    "check:parity-tiers",
    "check:service-discovery",
  ]
  items.push(
    ...(await pool(
      syncs,
      (script) =>
        inspect(script, async () => {
          try {
            await command([process.execPath, "run", script], 60_000)
          } catch {
            return {
              id: script,
              status: "fail",
              message: "Repository configuration or generated files are stale.",
              remedy: `bun run ${script} (shows exact files and regeneration instructions)`,
            }
          }
          return {
            id: script,
            status: "ok",
            message: "Repository/generated configuration is current.",
          }
        }),
      2,
    )),
  )
  const resolver = existsSync(join(root, ".github/resolve-issues-app.json"))
  items.push({
    id: "issue-resolver-login",
    status: resolver ? "ok" : "optional",
    message: resolver
      ? "GitHub App configuration exists; interactive user credentials are checked when dispatching."
      : "Issue resolver GitHub App setup has not been configured in this checkout.",
    ...(!resolver
      ? {
          remedy:
            "bun github:resolve-issues setup (only needed to dispatch autonomous issue resolution)",
        }
      : {}),
  })
  return report("repository", "Repository infrastructure configuration", items)
}
