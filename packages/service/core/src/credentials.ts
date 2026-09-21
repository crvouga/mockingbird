/**
 * Reading the vendor credential a request carries.
 *
 * Several vendor SDKs (Stripe, AWS, PostHog, Twilio) cannot add a namespace header, so a
 * runtime can also pick a request's namespace from its credential: a suite maps each
 * worker's API key, token or account SID to a namespace through `PUT /__admin/credentials`.
 * These helpers pull the credential out of the usual carriers.
 */

/** The token after `Bearer `, or `undefined`. */
export const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
}

export type BasicCredentials = { username: string; password: string }

/** `{ username, password }` from `Authorization: Basic …`, or `undefined`. */
export const basicAuth = (request: Request): BasicCredentials | undefined => {
  const header = request.headers.get("authorization")
  if (!header) return undefined
  const match = /^Basic\s+(.+)$/i.exec(header.trim())
  if (!match?.[1]) return undefined
  let decoded: string
  try {
    decoded = atob(match[1].trim())
  } catch {
    return undefined
  }
  const colon = decoded.indexOf(":")
  if (colon < 0) return { username: decoded, password: "" }
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

/**
 * The access key id of an AWS SigV4-signed request (`Credential=AKID/date/region/service/…`),
 * from the `Authorization` header or a presigned `X-Amz-Credential` query parameter.
 */
export const sigV4AccessKeyId = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")
  const fromHeader = header ? /Credential=([^/,\s]+)\//.exec(header)?.[1] : undefined
  if (fromHeader) return fromHeader
  const query = new URL(request.url).searchParams.get("X-Amz-Credential")
  return query ? (query.split("/")[0] ?? undefined) : undefined
}

/** The credential in any of the common carriers: Bearer, Basic username, SigV4, or `x-api-key`. */
export const anyCredential = (request: Request): string | undefined =>
  bearerToken(request) ??
  basicAuth(request)?.username ??
  sigV4AccessKeyId(request) ??
  request.headers.get("x-api-key") ??
  undefined

/** Credential → namespace mapping behind `PUT /__admin/credentials`. */
export type CredentialRegistry = {
  set(credential: string, namespace: string): void
  get(credential: string): string | undefined
  remove(credential: string): boolean
  clear(): void
  entries(): { credential: string; namespace: string }[]
}

export const createCredentialRegistry = (): CredentialRegistry => {
  const map = new Map<string, string>()
  return {
    set: (credential, namespace) => {
      map.set(credential, namespace)
    },
    get: (credential) => map.get(credential),
    remove: (credential) => map.delete(credential),
    clear: () => map.clear(),
    entries: () =>
      [...map]
        .map(([credential, namespace]) => ({ credential, namespace }))
        .sort((a, b) => a.credential.localeCompare(b.credential)),
  }
}

/** A credential shown in admin output: enough to recognise it, never the whole secret. */
export const maskCredential = (credential: string): string =>
  credential.length <= 8
    ? `${credential.slice(0, 2)}…`
    : `${credential.slice(0, 6)}…${credential.slice(-2)}`
