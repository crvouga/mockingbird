import { discoverPackages } from "../release/lib.ts"
import { inspect } from "./io.ts"
import { type HealthItem, report } from "./report.ts"
import { accessUrl, loadPackageTrust, npmAuthToken, publisherGap } from "./trusted-publisher.ts"

export async function runPublisherHealth(interactive = false) {
  const token = npmAuthToken()
  const packages = discoverPackages().filter((pkg) => pkg.isPublic)
  if (typeof token !== "string")
    return report("trusted-publisher", "npm trusted publishers", [
      {
        id: "npm-login",
        status: "unknown",
        message: `${packages.length} public packages' publisher settings are unverified: ${token.error}`,
        remedy: "npm login; bun run health -- trusted-publisher --interactive",
      },
    ])
  let items: HealthItem[] = []
  const result = await inspect("trusted-publisher", async () => {
    const loaded = await loadPackageTrust(
      packages.map((pkg) => pkg.name),
      token,
      undefined,
      { interactive },
    )
    if (!Array.isArray(loaded)) throw new Error(loaded.error)
    if (loaded.length !== packages.length)
      throw new Error("npm returned an incomplete publisher inventory")
    items = loaded.map((pkg): HealthItem => {
      const gap = publisherGap(pkg.published === true, pkg.configs ?? [])
      return {
        id: pkg.name,
        status: pkg.error ? "unknown" : gap ? "fail" : "ok",
        message:
          pkg.error ??
          (gap
            ? {
                missing: "No GitHub publisher matches crvouga/mockingbird and ci.yml.",
                "stage-only": "Publisher allows staging but cannot run npm publish.",
                environment: "Publisher requires an environment; the Release workflow sets none.",
                "not-published":
                  "Package is missing from npm; first publication needs a local seed.",
              }[gap]
            : "GitHub Actions ci.yml can publish; repository and environment match."),
        url: accessUrl(pkg.name),
        ...(pkg.error
          ? { remedy: "bun run health -- trusted-publisher --interactive" }
          : gap
            ? {
                remedy:
                  gap === "not-published"
                    ? "bun run release:seed"
                    : "bun run release:seed -- --trust-only",
              }
            : {}),
      }
    })
    return { id: "trusted-publisher", status: "ok", message: "Lookup complete." }
  })
  return report(
    "trusted-publisher",
    "npm trusted publishers",
    items.length
      ? items
      : [
          {
            ...result,
            message: `${packages.length} public packages' publisher settings are unverified: ${result.message}`,
            remedy: "bun run health -- trusted-publisher --interactive",
          },
        ],
  )
}
