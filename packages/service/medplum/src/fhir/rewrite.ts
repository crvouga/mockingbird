/**
 * Write- and read-time rewrites the server applies to every resource, ported from
 * packages/server/src/fhir/references.ts (`replaceConditionalReferences`) and rewrite.ts
 * (`rewriteAttachments`) plus storage/presign.ts (`generatePresignedUrl`).
 */
import {
  badRequest,
  crawlTypedValueAsync,
  createReference,
  OperationOutcomeError,
  PropertyType,
  parseSearchRequest,
  toTypedValue,
} from "@medplum/core"
import type { Binary, Reference, Resource } from "@medplum/fhirtypes"
import type { MockRepository } from "./repo.js"

const isReferenceValue = (value: { type: string } | { type: string }[]): boolean =>
  (Array.isArray(value) ? value[0]?.type : value.type) === PropertyType.Reference

const resolveReplacementReference = async (
  repo: MockRepository,
  reference: Reference | undefined,
  path: string,
): Promise<Reference | undefined> => {
  if (!reference?.reference?.includes?.("?")) return undefined
  const criteria = parseSearchRequest(reference.reference)
  criteria.sortRules = undefined
  criteria.count = 2
  const matches = await repo.searchResources(criteria)
  if (matches.length !== 1) {
    throw new OperationOutcomeError(
      badRequest(
        `Conditional reference '${reference.reference}' ${matches.length ? "matched multiple" : "did not match any"} resources`,
        path,
      ),
    )
  }
  return createReference(matches[0] as Resource & { id: string })
}

/** Resolve `Type?search` references to the one resource each matches (400 otherwise). */
export const replaceConditionalReferences = async <T extends Resource>(
  repo: MockRepository,
  resource: T,
): Promise<T> => {
  await crawlTypedValueAsync(
    toTypedValue(resource),
    {
      async visitPropertyAsync(parent, key, path, propertyValue) {
        if (!isReferenceValue(propertyValue as { type: string })) return
        if (Array.isArray(propertyValue)) {
          for (let i = 0; i < propertyValue.length; i++) {
            const replacement = await resolveReplacementReference(
              repo,
              propertyValue[i]?.value as Reference,
              `${path}[${i}]`,
            )
            if (replacement) parent.value[key][i] = replacement
          }
        } else {
          const replacement = await resolveReplacementReference(
            repo,
            propertyValue.value as Reference,
            path,
          )
          if (replacement) parent.value[key] = replacement
        }
      },
    },
    { skipMissingProperties: true },
  )
  return resource
}

export const RewriteMode = { PRESIGNED_URL: "PRESIGNED_URL", REFERENCE: "REFERENCE" } as const
export type RewriteMode = (typeof RewriteMode)[keyof typeof RewriteMode]

/** `normalizeBinaryUrl`: the Binary a URL points at, in any of its three spellings. */
export const normalizeBinaryUrl = (
  repo: MockRepository,
  url: string,
): { id?: string; versionId?: string } => {
  const base = repo.services.baseUrl
  const storage = `${base}storage/`
  let ref: string | undefined
  if (url.startsWith(`${base}fhir/R4/Binary/`)) ref = url.substring(`${base}fhir/R4/Binary/`.length)
  else if (url.startsWith(storage)) ref = url.substring(storage.length)
  else if (url.startsWith("Binary/")) ref = url.substring("Binary/".length)
  if (!ref) return {}
  const parts = ref.split("/")
  if (parts.length === 3 && parts[1] === "_history") return { id: parts[0], versionId: parts[2] }
  return { id: parts[0] }
}

const containsBinaryUrl = (repo: MockRepository, input: unknown): boolean => {
  if (input === null || typeof input !== "object") return false
  if (Array.isArray(input)) return input.some((item) => containsBinaryUrl(repo, item))
  if ((input as Resource).resourceType === "Binary") return false
  for (const [key, value] of Object.entries(input)) {
    if ((key === "url" || key === "path") && typeof value === "string") {
      if (normalizeBinaryUrl(repo, value).id) return true
    } else if (containsBinaryUrl(repo, value)) {
      return true
    }
  }
  return false
}

/**
 * Rewrite attachment URLs: to `Binary/<id>` references (on write) or to presigned storage
 * URLs the caller can download from (on read, when it may read the Binary).
 */
export const rewriteAttachments = async <T>(
  mode: RewriteMode,
  repo: MockRepository,
  input: T,
): Promise<T> => {
  if (!containsBinaryUrl(repo, input)) return input
  const cache: Record<string, string> = {}
  const presigned = async (id: string, versionId: string | undefined): Promise<string> => {
    try {
      const binary = versionId
        ? await repo.readVersion<Binary>("Binary", id, versionId)
        : await repo.readResource<Binary>("Binary", id)
      return presignedUrl(repo, binary)
    } catch {
      return `Binary/${id}`
    }
  }
  const rewriteValue = async (value: unknown): Promise<unknown> => {
    if (value === null || value === undefined) return value
    if (Array.isArray(value)) {
      const out = []
      for (const item of value) out.push(await rewriteValue(item))
      return out
    }
    if (typeof value !== "object") return value
    if ((value as Resource).resourceType === "Binary") return value
    const entries: [string, unknown][] = []
    for (const [key, item] of Object.entries(value)) {
      if ((key === "url" || key === "path") && typeof item === "string") {
        const { id, versionId } = normalizeBinaryUrl(repo, item)
        if (id) {
          cache[item] ??=
            mode === RewriteMode.REFERENCE ? `Binary/${id}` : await presigned(id, versionId)
          entries.push([key, cache[item]])
          continue
        }
        entries.push([key, item])
        continue
      }
      entries.push([key, await rewriteValue(item)])
    }
    return Object.fromEntries(entries)
  }
  return (await rewriteValue(input)) as T
}

/**
 * `generatePresignedUrl`: `<base>storage/<id>/<versionId>?Expires=…&Project=…&Signature=…`, an
 * hour's validity; the signature is an HMAC the mock's own storage route verifies.
 */
export const presignedUrl = async (repo: MockRepository, binary: Binary): Promise<string> => {
  const result = new URL(`${repo.services.baseUrl}storage/${binary.id}/${binary.meta?.versionId}`)
  const expires = new Date(repo.services.now())
  expires.setHours(expires.getHours() + 1)
  result.searchParams.set("Expires", Math.floor(expires.getTime() / 1000).toString())
  if (binary.meta?.project) result.searchParams.set("Project", binary.meta.project)
  result.searchParams.set("Signature", await repo.services.sign(`GET ${result.toString()}`))
  return result.toString()
}
