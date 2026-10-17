import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { FleetTarget } from "./fleet.js"

const suffix = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Resolve only declared installed packages, relative to the consumer (including pnpm links).
 * No downloads, arbitrary module paths, or public-request-selected imports are supported.
 */
export function createInstalledServiceLoader(options: {
  projectRoot: string
  services: readonly string[]
  targets?: readonly FleetTarget[]
}): (name: string) => Promise<FleetTarget> {
  if (!options.projectRoot) throw new Error("consumer projectRoot required")
  const allowed = new Set(options.services)
  for (const name of allowed) if (!suffix.test(name)) throw new Error("invalid service suffix")
  const require = createRequire(resolve(options.projectRoot, "package.json"))
  const targets = new Map((options.targets ?? []).map((target) => [target.name, target]))
  return async (name) => {
    if (!suffix.test(name) || !allowed.has(name))
      throw new Error("service is not declared in loader allowlist")
    const own = targets.get(name)
    if (own) return own
    const specifier = `@crvouga/mockingbird-service-${name}/server`
    let location: string
    try {
      location = require.resolve(specifier)
    } catch {
      throw new Error(
        `cannot load service "${name}": install @crvouga/mockingbird-service-${name} in the consumer project; its /server export is required`,
      )
    }
    const mod = (await import(pathToFileURL(location).href)) as { serveTarget?: FleetTarget }
    if (
      !mod.serveTarget ||
      mod.serveTarget.name !== name ||
      ("protocol" in mod.serveTarget
        ? typeof mod.serveTarget.start !== "function"
        : typeof mod.serveTarget.create !== "function")
    )
      throw new Error(`${specifier} exports no matching serveTarget`)
    return mod.serveTarget
  }
}
