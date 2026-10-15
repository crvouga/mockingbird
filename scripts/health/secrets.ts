import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO, root } from "../release/lib.ts"
import {
  loadManifest,
  parityRequirements,
  paritySettingNames,
  readEnvLocal,
} from "../secrets/lib.ts"
import { github, githubPages, inspect } from "./io.ts"
import { type HealthItem, report } from "./report.ts"

export function referencedSecrets(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/secrets(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)].map(
        (match) => match[1] ?? match[2] ?? "",
      ),
    ),
  ]
    .filter((name) => name !== "GITHUB_TOKEN")
    .sort()
}

export function paritySecretMappings(source: string): Set<string> {
  const workflow = Bun.YAML.parse(source) as {
    jobs?: Record<string, { steps?: Array<{ env?: Record<string, unknown> }> }>
  }
  return new Set(
    Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).flatMap((step) =>
        Object.entries(step.env ?? {})
          .filter(
            ([name, value]) => typeof value === "string" && referencedSecrets(value).includes(name),
          )
          .map(([name]) => name),
      ),
    ),
  )
}

export async function runSecretsHealth() {
  const items: HealthItem[] = []
  const manifest = await loadManifest()
  const repo = await github<{ owner: { type: string } }>(`repos/${REPO}`)
  const names = new Set<string>()
  const access = await inspect("secret-inventory", async () => {
    const secrets = await githubPages<{ name: string }>(
      `repos/${REPO}/actions/secrets?per_page=100`,
      "secrets",
    )
    for (const secret of secrets) names.add(secret.name)
    if (repo.owner.type === "Organization") {
      for (const secret of await githubPages<{ name: string }>(
        `repos/${REPO}/actions/organization-secrets?per_page=100`,
        "secrets",
      ))
        names.add(secret.name)
    }
    return {
      id: "secret-inventory",
      status: "ok",
      message: `${names.size} effective repository/organization secret names; values are never requested. Presence does not verify validity or expiry.`,
    }
  })
  items.push(access)
  const requirements = parityRequirements()
  const local = await readEnvLocal()
  const parityNames = new Set([
    ...requirements.flatMap((entry) => entry.env),
    ...paritySettingNames(),
  ])
  const sources = readdirSync(join(root, ".github/workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({ file, source: readFileSync(join(root, ".github/workflows", file), "utf8") }))
  const workflowNames = new Set(sources.flatMap(({ source }) => referencedSecrets(source)))
  const required = new Set(
    manifest.secrets
      .filter((entry) => entry.github.required && entry.github.name)
      .map((entry) => entry.github.name as string),
  )
  for (const name of workflowNames) if (!parityNames.has(name)) required.add(name)
  const parityWorkflow = sources.find(({ file }) => file === "parity.yml")?.source ?? ""
  const mapped = paritySecretMappings(parityWorkflow)
  for (const requirement of requirements) {
    const pkg = JSON.parse(
      readFileSync(join(root, "packages/service", requirement.service, "package.json"), "utf8"),
    ) as { mockingbird?: { parityTier?: string } }
    const expected = pkg.mockingbird?.parityTier === "hot" || pkg.mockingbird?.parityTier === "warm"
    if (expected) for (const name of requirement.env) required.add(name)
    const missing = requirement.env.filter((name) => !names.has(name))
    const unmapped = requirement.env.filter((name) => !mapped.has(name))
    const localMissing = requirement.env.filter(
      (name) => !(local[name]?.trim() || process.env[name]?.trim()),
    )
    items.push({
      id: `local-parity:${requirement.service}`,
      status: "optional",
      message: localMissing.length
        ? `Local parity lacks: ${localMissing.join(", ")}; GitHub parity can run independently.`
        : "Local parity credentials are present; values are untested.",
    })
    items.push({
      id: `parity:${requirement.service}`,
      status:
        access.status !== "ok"
          ? "unknown"
          : unmapped.length
            ? expected || missing.length === 0
              ? "fail"
              : "optional"
            : missing.length
              ? expected
                ? "fail"
                : "optional"
              : "ok",
      message: unmapped.length
        ? `Parity workflow does not map: ${unmapped.join(", ")}`
        : missing.length
          ? `${expected ? "Scheduled" : "On-demand"} parity lacks: ${missing.join(", ")}`
          : "All required parity keys are present and mapped; values are untested.",
      ...(missing.length || unmapped.length
        ? {
            remedy: "Configure the named GitHub Actions secrets and their parity.yml env mappings.",
          }
        : {}),
    })
  }
  for (const name of [...new Set([...workflowNames, ...required, ...parityNames])].sort()) {
    items.push({
      id: name,
      status:
        access.status !== "ok"
          ? "unknown"
          : names.has(name)
            ? "ok"
            : required.has(name)
              ? "fail"
              : "optional",
      message: names.has(name)
        ? "GitHub Actions secret is present (value not read)."
        : `${required.has(name) ? "Required" : "Optional/on-demand parity"} GitHub Actions secret is missing.`,
      url: `https://github.com/${REPO}/settings/secrets/actions`,
      ...(!names.has(name)
        ? { remedy: `Configure ${name} in GitHub Actions secrets; see docs/SECRETS.md.` }
        : {}),
    })
  }
  return report("secrets", "GitHub secrets and parity readiness", items)
}
