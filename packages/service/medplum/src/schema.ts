import { indexSearchParameter, indexStructureDefinitionBundle } from "@medplum/core"
import type { SearchParameter, StructureDefinition } from "@medplum/fhirtypes"
import {
  DEFINITIONS_GZIP_BASE64,
  DEFINITIONS_VERSION as VERSION,
} from "./generated/definitions-data.js"

/** The `@medplum/definitions` release the embedded FHIR definitions come from. */
export const DEFINITIONS_VERSION: string = VERSION

let loading: Promise<void> | undefined

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
 * Idempotent; the first call costs ~150 ms (inflate, parse, index). Uses only
 * `DecompressionStream`, `Blob` and `Response`, standard in every modern JavaScript runtime.
 */
export const ensureSchema = (): Promise<void> => {
  loading ??= (async () => {
    const { structureDefinitions, searchParameters } = JSON.parse(
      await gunzipBase64(DEFINITIONS_GZIP_BASE64),
    ) as {
      structureDefinitions: StructureDefinition[]
      searchParameters: SearchParameter[]
    }
    indexStructureDefinitionBundle(structureDefinitions)
    for (const searchParameter of searchParameters) indexSearchParameter(searchParameter)
  })()
  return loading
}
