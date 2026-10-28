import type { Scenario } from "../harness.js"

const areas = [
  "basics",
  "auth",
  "post",
  "buckets",
  "objects",
  "conditional",
  "range",
  "checksums",
  "copy",
  "listing",
  "multipart",
  "versioning",
  "lock",
  "delete",
  "config",
  "policy",
  "tagging",
  "acl",
  "attributes",
] as const

/** Every scenario, named `<area>/<name>`. */
export const loadScenarios = async (): Promise<Scenario[]> => {
  const all: Scenario[] = []
  for (const area of areas) {
    const module = (await import(`./${area}.js`)) as { scenarios: Scenario[] }
    for (const scenario of module.scenarios)
      all.push({ ...scenario, name: `${area}/${scenario.name}` })
  }
  const names = new Set<string>()
  for (const { name } of all) {
    if (names.has(name)) throw new Error(`duplicate scenario ${name}`)
    names.add(name)
  }
  return all
}
