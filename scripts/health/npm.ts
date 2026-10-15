import { discoverPackages, REPO, retiredPackages } from "../release/lib.ts"
import { command, githubPages, inspect, pool, request, safeError } from "./io.ts"
import { type HealthItem, report } from "./report.ts"
import { registryPackagePath, repositoryMatchesProject } from "./trusted-publisher.ts"

export type NpmVersion = {
  deprecated?: string
  repository?: unknown
  dist?: { tarball?: string; integrity?: string }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
export type Packument = {
  name?: string
  repository?: unknown
  "dist-tags"?: Record<string, string>
  versions?: Record<string, NpmVersion>
}

export function latestReleaseTags(refs: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const line of refs.split("\n")) {
    const match = /refs\/tags\/(.+)@(\d+\.\d+\.\d+)$/.exec(line.trim())
    if (!match?.[1] || !match[2]) continue
    const previous = tags.get(match[1])
    const version = match[2]
    const tuple = version.split(".").map(Number)
    const old = previous?.split(".").map(Number)
    if (
      !old ||
      tuple.some((n, i) => n > (old[i] ?? 0) && tuple.slice(0, i).every((p, j) => p === old[j]))
    )
      tags.set(match[1], version)
  }
  return tags
}

export function packageHealth(
  name: string,
  doc: Packument | null,
  tagged?: string | null,
): HealthItem[] {
  const url = `https://www.npmjs.com/package/${name}`
  if (!doc)
    return [
      {
        id: name,
        status: "fail",
        message: "Package is missing from npm.",
        remedy: "bun run release:seed",
        url,
      },
    ]
  const latest = doc["dist-tags"]?.latest
  const manifest = latest ? doc.versions?.[latest] : undefined
  const problems: string[] = []
  if (!manifest) problems.push("latest dist-tag does not resolve to a published version")
  if (manifest?.deprecated) problems.push("current public service is deprecated")
  if (manifest && !repositoryMatchesProject(manifest.repository ?? doc.repository))
    problems.push("repository metadata does not identify this project")
  if (
    manifest &&
    (!manifest.dist?.tarball?.startsWith("https://registry.npmjs.org/") || !manifest.dist.integrity)
  )
    problems.push("latest version lacks registry tarball or integrity metadata")
  if (tagged && !doc.versions?.[tagged]) problems.push(`git release ${tagged} is missing from npm`)
  if (tagged && latest !== tagged)
    problems.push(`latest is ${latest ?? "missing"}; latest git release is ${tagged}`)
  if (latest && tagged === null)
    problems.push(`published version ${latest} has no stable release tag in GitHub`)
  for (const deps of [
    manifest?.dependencies,
    manifest?.peerDependencies,
    manifest?.optionalDependencies,
  ]) {
    for (const [dep, pin] of Object.entries(deps ?? {})) {
      if (
        pin.includes("workspace:") ||
        pin.includes("0.0.0-development") ||
        pin.startsWith("file:") ||
        pin.startsWith("link:")
      )
        problems.push(`uninstallable dependency ${dep}@${pin}`)
    }
  }
  return [
    {
      id: name,
      status: problems.length ? "fail" : "ok",
      message:
        problems.join("; ") ||
        `npm ${latest}; tarball and metadata valid${tagged ? "; release tag agrees" : ""}.`,
      url,
      ...(problems.length
        ? { remedy: "Inspect the release and packed manifest; retry Release after correcting it." }
        : {}),
    },
  ]
}

export async function readPackument(name: string): Promise<Packument | null> {
  const res = await request(`https://registry.npmjs.org/${registryPackagePath(name)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`npm HTTP ${res.status}`)
  const body = (await res.json()) as Packument
  if (!body.versions || !body.name) throw new Error("npm returned invalid package metadata")
  return body
}

export async function runNpmHealth() {
  const packages = discoverPackages()
  const items: HealthItem[] = []
  let tags: Map<string, string> | undefined
  try {
    tags = latestReleaseTags(
      await command(["git", "ls-remote", "--tags", `https://github.com/${REPO}.git`]),
    )
  } catch (error) {
    items.push({ id: "release-tags", status: "unknown", message: safeError(error) })
  }
  const publicPackages = packages.filter((pkg) => pkg.isPublic)
  const documents = new Map<string, Packument | null>()
  const rows = await pool(publicPackages, async (pkg) => {
    const read = await inspect(pkg.name, async () => {
      documents.set(pkg.name, await readPackument(pkg.name))
      return { id: pkg.name, status: "ok", message: "Registry lookup succeeded." }
    })
    if (read.status !== "ok") return [read]
    const entries = packageHealth(
      pkg.name,
      documents.get(pkg.name) ?? null,
      tags ? (tags.get(pkg.name) ?? null) : undefined,
    )
    const doc = documents.get(pkg.name)
    const latest = doc?.["dist-tags"]?.latest
    const tarball = latest ? doc?.versions?.[latest]?.dist?.tarball : undefined
    if (entries[0]?.status === "ok" && tarball) {
      const reachable = await inspect(`${pkg.name}:tarball`, async () => {
        const response = await request(tarball, { method: "HEAD" })
        await response.body?.cancel()
        return {
          id: `${pkg.name}:tarball`,
          status: response.ok ? "ok" : "fail",
          message: `npm tarball HTTP ${response.status}.`,
          remedy:
            "Inspect the published version and registry availability before releasing consumers.",
        }
      })
      if (reachable.status !== "ok") entries.push(reachable)
      else entries[0].message += " Tarball endpoint is reachable."
    }
    return entries
  })
  items.push(...rows.flat())
  // Exact internal pins must point at a version consumers can actually install.
  for (const [name, doc] of documents) {
    const latest = doc?.["dist-tags"]?.latest
    const value = latest ? doc?.versions?.[latest] : undefined
    for (const deps of [
      value?.dependencies,
      value?.peerDependencies,
      value?.optionalDependencies,
    ]) {
      for (const [dep, pin] of Object.entries(deps ?? {})) {
        if (!documents.has(dep) || !/^\d+\.\d+\.\d+$/.test(pin)) continue
        if (!documents.get(dep)?.versions?.[pin])
          items.push({
            id: `${name} → ${dep}`,
            status: "fail",
            message: `Dependency ${pin} is not published.`,
            remedy: "Release the dependency before the consumer.",
          })
      }
    }
  }
  items.push(
    ...(await pool(retiredPackages(packages), (retired) =>
      inspect(retired.name, async () => {
        const doc = await readPackument(retired.name)
        const active = Object.entries(doc?.versions ?? {}).filter(([, value]) => !value.deprecated)
        return {
          id: `retired:${retired.name}`,
          status: active.length ? "fail" : "ok",
          message: active.length
            ? `${active.length} retired version(s) still advertised without a deprecation.`
            : "Absent or deprecated on npm.",
          ...(active.length ? { remedy: "bun run release:seed" } : {}),
        }
      }),
    )),
  )
  items.push(
    await inspect("github-releases", async () => {
      const releases = await githubPages<{ tag_name: string; draft: boolean }>(
        `repos/${REPO}/releases?per_page=100`,
      )
      const published = new Set(releases.filter((r) => !r.draft).map((r) => r.tag_name))
      const missing = [...(tags ?? [])]
        .filter(
          ([name, version]) =>
            publicPackages.some((pkg) => pkg.name === name) && !published.has(`${name}@${version}`),
        )
        .map(([name, version]) => `${name}@${version}`)
      return {
        id: "github-releases",
        status: !tags ? "unknown" : missing.length ? "fail" : "ok",
        message: !tags
          ? "Release tags could not be read."
          : missing.length
            ? `Missing GitHub releases: ${missing.join(", ")}`
            : "Every current package tag has a GitHub Release.",
        remedy: "Retry the Release workflow to repair missing GitHub Releases.",
      }
    }),
  )
  return report("npm", "npm packages and releases", items)
}
