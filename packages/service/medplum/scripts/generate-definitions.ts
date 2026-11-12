/**
 * Generate `src/generated/definitions-data.js`: the FHIR R4 StructureDefinitions and
 * SearchParameters the self-hosted Medplum server loads at boot (`loadStructureDefinitions`
 * in packages/server/src/fhir/structure.ts), trimmed to the fields `@medplum/core`'s schema
 * parser and search indexer read, and embedded as a plain ES module so the mock needs no
 * filesystem, JSON import attributes or `@medplum/definitions` at runtime, laid out so each
 * StructureDefinition is parsed and indexed on first use (src/schema.ts).
 *
 *   bun scripts/generate-definitions.ts          write the module
 *   bun scripts/generate-definitions.ts --check  fail when it is stale
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { isResourceTypeSchema, parseStructureDefinition } from "@medplum/core"
import type { StructureDefinition } from "@medplum/fhirtypes"

const require = createRequire(import.meta.url)
const definitionsDir = join(dirname(require.resolve("@medplum/definitions/package.json")), "dist")
const version = JSON.parse(readFileSync(join(dirname(definitionsDir), "package.json"), "utf8"))
  .version as string

type Json = Record<string, unknown>

const readBundle = (name: string): Json[] =>
  (
    JSON.parse(readFileSync(join(definitionsDir, "fhir", "r4", name), "utf8")) as {
      entry?: { resource?: Json }[]
    }
  ).entry?.flatMap((entry) => (entry.resource ? [entry.resource] : [])) ?? []

/** Element fields read by `@medplum/core`'s StructureDefinition parser (typeschema/types.ts). */
const ELEMENT_FIELDS = new Set([
  "id",
  "path",
  "sliceName",
  "slicing",
  "isSummary",
  "contentReference",
  "min",
  "max",
  "base",
  "type",
])

const trimElement = (element: Json): Json => {
  const out: Json = {}
  for (const [key, value] of Object.entries(element)) {
    if (ELEMENT_FIELDS.has(key) || key.startsWith("fixed") || key.startsWith("pattern")) {
      out[key] = value
    }
  }
  const base = element.base as Json | undefined
  if (base) out.base = { path: base.path, min: base.min, max: base.max }
  const constraints = element.constraint as Json[] | undefined
  if (constraints?.length) {
    out.constraint = constraints.map((c) => ({
      key: c.key,
      severity: c.severity,
      human: c.human,
      expression: c.expression,
    }))
  }
  const binding = element.binding as Json | undefined
  if (binding) {
    out.binding = {
      strength: binding.strength,
      ...(binding.valueSet !== undefined ? { valueSet: binding.valueSet } : {}),
    }
  }
  return out
}

const SD_FIELDS = [
  "resourceType",
  "id",
  "url",
  "version",
  "name",
  "title",
  "status",
  "kind",
  "abstract",
  "type",
  "baseDefinition",
  "derivation",
] as const

const structureDefinitions: Json[] = []
for (const file of ["profiles-types.json", "profiles-resources.json", "profiles-medplum.json"]) {
  for (const resource of readBundle(file)) {
    if (resource.resourceType !== "StructureDefinition") continue
    const out: Json = {}
    for (const key of SD_FIELDS) if (resource[key] !== undefined) out[key] = resource[key]
    const elements = ((resource.snapshot as Json | undefined)?.element ?? []) as Json[]
    out.snapshot = { element: elements.map(trimElement) }
    structureDefinitions.push(out)
  }
}

/** SearchParameter fields read by `indexSearchParameter` and `getSearchParameterDetails`. */
const SP_FIELDS = [
  "resourceType",
  "id",
  "url",
  "name",
  "code",
  "base",
  "type",
  "expression",
  "target",
  "modifier",
  "comparator",
  "multipleOr",
  "multipleAnd",
  "chain",
  "component",
] as const

const searchParameters: Json[] = []
for (const file of [
  "search-parameters.json",
  "search-parameters-medplum.json",
  "search-parameters-uscore.json",
]) {
  for (const resource of readBundle(file)) {
    if (resource.resourceType !== "SearchParameter") continue
    const out: Json = {}
    for (const key of SP_FIELDS) if (resource[key] !== undefined) out[key] = resource[key]
    searchParameters.push(out)
  }
}

/** Patient compartment membership (compartmentdefinition-patient.json): resource type -> params. */
const compartment = JSON.parse(
  readFileSync(join(definitionsDir, "fhir", "r4", "compartmentdefinition-patient.json"), "utf8"),
) as { resource?: { code?: string; param?: string[] }[] }
const patientCompartment: Record<string, string[]> = {}
for (const entry of compartment.resource ?? []) {
  if (entry.code && entry.param?.length) patientCompartment[entry.code] = entry.param
}

// Layout of the inflated text, so the runtime indexes one StructureDefinition at a time, on first
// use, instead of all of them at startup (src/schema.ts): the SearchParameters as one JSON array
// on the first line, then one StructureDefinition JSON per line in load order. Each definition's
// line end and the `@medplum/core` schema keys it fills (its type, then its inner backbone types,
// as `loadDataType` writes them) ship uncompressed beside it, read off the real parser here.
const SPECIAL_CASE_TYPES: Record<string, string> = {
  "http://hl7.org/fhir/StructureDefinition/MoneyQuantity": "MoneyQuantity",
  "http://hl7.org/fhir/StructureDefinition/SimpleQuantity": "SimpleQuantity",
  "http://hl7.org/fhir/uv/sql-on-fhir/StructureDefinition/ViewDefinition": "ViewDefinition",
}
let payload = `${JSON.stringify(searchParameters)}\n`
const definitionIndex: [end: number, keys: string[], resourceType?: string][] = []
const resourceTypes: [type: string, url: string, version: string | undefined][] = []
const seenKeys = new Set<string>()
for (const sd of structureDefinitions) {
  const type = sd.type as string
  const url = sd.url as string
  const specialCase = SPECIAL_CASE_TYPES[url]
  const isBaseType =
    specialCase !== undefined ||
    url === `http://hl7.org/fhir/StructureDefinition/${type}` ||
    url === `https://medplum.com/fhir/StructureDefinition/${type}` ||
    type.startsWith("http://") ||
    type.startsWith("https://")
  // A profile lands in @medplum/core's private per-profile maps, which cannot be filled lazily.
  if (!isBaseType) throw new Error(`${url} is a profile, not a base type: index it eagerly`)
  const schema = parseStructureDefinition(sd as unknown as StructureDefinition)
  const keys = [specialCase ?? type, ...schema.innerTypes.map((inner) => inner.name)]
  for (const key of keys) {
    // Eager indexing lets a later definition overwrite a key; lazy indexing would not.
    if (seenKeys.has(key)) throw new Error(`schema key ${key} is defined twice`)
    seenKeys.add(key)
  }
  payload += `${JSON.stringify(sd)}\n`
  definitionIndex.push(
    sd.kind === "resource" ? [payload.length, keys, type] : [payload.length, keys],
  )
  if (isResourceTypeSchema(schema)) {
    if (schema.name !== keys[0]) throw new Error(`${url}: name ${schema.name} is not its type`)
    resourceTypes.push([schema.name, schema.url as string, schema.version])
  }
}

// gzip + base64: a fraction of the size, and no FHIR path text (`ExampleScenario.process.id`)
// in the bundle for text-based runtime scanners to mistake for code.
const gzipped = Buffer.from(
  Bun.gzipSync(Buffer.from(payload), { level: 9, mtime: 0 } as never),
).toString("base64")
const renderModule = (
  gzipBase64: string,
) => `// Generated by scripts/generate-definitions.ts from @medplum/definitions ${version}. Do not edit.
// FHIR R4 definitions: HL7 FHIR (CC0). Medplum profiles and search parameters: Apache-2.0,
// Copyright Orangebot, Inc. and Medplum contributors.
export const DEFINITIONS_VERSION = ${JSON.stringify(version)}
/** gzip, base64-encoded, of the SearchParameters as a JSON array on one line, then one StructureDefinition JSON per line. */
export const DEFINITIONS_GZIP_BASE64 = ${JSON.stringify(gzipBase64)}
/** Per StructureDefinition, in load order: [end of its line in the inflated text, the schema keys it defines, its type when it is a resource]. */
export const STRUCTURE_DEFINITIONS = ${JSON.stringify(definitionIndex)}
/** Every concrete resource type, in schema order: [type, StructureDefinition url, version]. */
export const RESOURCE_TYPES = ${JSON.stringify(resourceTypes)}
export const patientCompartment = ${JSON.stringify(patientCompartment)}
`
const moduleText = renderModule(gzipped)
const declarations = `// Generated by scripts/generate-definitions.ts. Do not edit.
export declare const DEFINITIONS_VERSION: string
/** gzip, base64-encoded, of the SearchParameters as a JSON array on one line, then one StructureDefinition JSON per line. */
export declare const DEFINITIONS_GZIP_BASE64: string
/** Per StructureDefinition, in load order: [end of its line in the inflated text, the schema keys it defines, its type when it is a resource]. */
export declare const STRUCTURE_DEFINITIONS: readonly (
  | readonly [end: number, keys: readonly string[]]
  | readonly [end: number, keys: readonly string[], resourceType: string]
)[]
/** Every concrete resource type, in schema order: [type, StructureDefinition url, version]. */
export declare const RESOURCE_TYPES: readonly (readonly [type: string, url: string, version: string | undefined])[]
/** Patient compartment: resource type -> the search parameters that place it in a Patient's compartment. */
export declare const patientCompartment: Record<string, string[]>
`

const target = join(import.meta.dir, "..", "src", "generated", "definitions-data.js")
const targetTypes = join(import.meta.dir, "..", "src", "generated", "definitions-data.d.ts")

if (process.argv.includes("--check")) {
  const current = (() => {
    try {
      return [readFileSync(target, "utf8"), readFileSync(targetTypes, "utf8")]
    } catch {
      return undefined
    }
  })()
  // gzip output differs between zlib builds (macOS vs Linux), so compare the decompressed
  // payload and the text around it rather than the compressed bytes.
  const currentGzip = current?.[0]?.match(/^export const DEFINITIONS_GZIP_BASE64 = (".*")$/m)?.[1]
  const currentPayload =
    currentGzip === undefined
      ? undefined
      : Buffer.from(
          Bun.gunzipSync(Buffer.from(JSON.parse(currentGzip) as string, "base64")),
        ).toString()
  if (
    currentGzip === undefined ||
    currentPayload !== payload ||
    current?.[0] !== renderModule(JSON.parse(currentGzip) as string) ||
    current?.[1] !== declarations
  ) {
    console.error("definitions-data.js is stale: run `bun scripts/generate-definitions.ts`")
    process.exit(1)
  }
  console.log("definitions-data.js is up to date")
} else {
  await Bun.write(target, moduleText)
  await Bun.write(targetTypes, declarations)
  console.log(
    `wrote ${structureDefinitions.length} StructureDefinitions and ${searchParameters.length} SearchParameters (${(moduleText.length / 1e6).toFixed(2)} MB, ${(payload.length / 1e6).toFixed(1)} MB unpacked) from @medplum/definitions ${version}`,
  )
}
