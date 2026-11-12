import {
  getAllDataTypes,
  indexDefaultSearchParameters,
  indexSearchParameter,
  loadDataType,
} from "@medplum/core"
import type { SearchParameter, StructureDefinition } from "@medplum/fhirtypes"
import {
  DEFINITIONS_GZIP_BASE64,
  RESOURCE_TYPES,
  STRUCTURE_DEFINITIONS,
  DEFINITIONS_VERSION as VERSION,
} from "./generated/definitions-data.js"

/** The `@medplum/definitions` release the embedded FHIR definitions come from. */
export const DEFINITIONS_VERSION: string = VERSION

/**
 * Every concrete resource type the embedded definitions declare, in `@medplum/core` schema
 * order, with its StructureDefinition url and version: what `GET /metadata` lists, without
 * indexing every type to read it.
 */
export const RESOURCE_TYPE_SUMMARIES: readonly {
  readonly type: string
  readonly url: string
  readonly version: string | undefined
}[] = RESOURCE_TYPES.map(([type, url, version]) => ({ type, url, version }))

let loading: Promise<void> | undefined
const indexed: string[] = []

/** The types whose StructureDefinitions have been parsed and indexed so far, in order (a test seam). */
export const indexedStructureDefinitions = (): readonly string[] => indexed

const gunzipBase64 = async (base64: string): Promise<string> => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Response(stream).text()
}

/**
 * Index the FHIR R4 and Medplum StructureDefinitions and SearchParameters into
 * `@medplum/core`'s global schema — exactly the set the self-hosted server loads at boot.
 *
 * Parsing a StructureDefinition into a type schema is nearly all of the cost, so it happens per
 * definition on first use: each schema key a definition fills (its type and its inner backbone
 * types, precomputed by scripts/generate-definitions.ts) becomes a getter on `@medplum/core`'s
 * data type map that parses and loads the definition the first time any lookup reads it —
 * `getDataType`, `tryGetDataType`, `isResourceType`, `validateResource`, FHIRPath and the typed
 * value walkers all read that map, so every entry point sees the same schema an eager load
 * would, in the same key order. `loadDataType`'s own writes go through the matching setter and
 * turn each key back into a plain value. Search parameters (and the defaults every resource
 * type gets) are cheap and indexed eagerly, as before.
 *
 * One difference from an eager load is unobservable here: `@medplum/core`'s by-url profile map
 * (`tryGetProfile`, `isProfileLoaded`) learns a type only once it is loaded. Nothing in the mock
 * reads it, and the definitions hold no profiles (the generator refuses them).
 *
 * Idempotent; the first call inflates the text (~15 ms) and indexes the search parameters.
 * Uses only `DecompressionStream`, `Blob` and `Response`, standard in every modern JavaScript
 * runtime.
 */
export const ensureSchema = (): Promise<void> => {
  loading ??= (async () => {
    let source: string | undefined = await gunzipBase64(DEFINITIONS_GZIP_BASE64)
    const firstLineEnd = source.indexOf("\n") + 1
    const searchParameters = JSON.parse(source.slice(0, firstLineEnd)) as SearchParameter[]

    indexDefaultSearchParameters(
      STRUCTURE_DEFINITIONS.flatMap((entry) =>
        entry[2] === undefined
          ? []
          : [{ resourceType: "StructureDefinition", kind: "resource", type: entry[2] } as never],
      ),
    )

    const dataTypes = getAllDataTypes()
    let remaining = STRUCTURE_DEFINITIONS.length
    let start = firstLineEnd
    for (const [end, keys] of STRUCTURE_DEFINITIONS) {
      const from = start
      start = end
      let done = false
      const load = (): void => {
        if (done || source === undefined) return
        done = true
        indexed.push(keys[0] as string)
        const sd = JSON.parse(source.slice(from, end)) as StructureDefinition
        if (--remaining === 0) source = undefined
        loadDataType(sd)
      }
      for (const key of keys) {
        Object.defineProperty(dataTypes, key, {
          configurable: true,
          enumerable: true,
          get() {
            load()
            const own = Object.getOwnPropertyDescriptor(dataTypes, key)
            return own && "value" in own ? own.value : undefined
          },
          set(value) {
            Object.defineProperty(dataTypes, key, {
              configurable: true,
              enumerable: true,
              writable: true,
              value,
            })
          },
        })
      }
    }

    for (const searchParameter of searchParameters) indexSearchParameter(searchParameter)
  })()
  return loading
}
