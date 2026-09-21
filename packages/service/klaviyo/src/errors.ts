import { opaqueToken } from "@crvouga/mockingbird-service"

/** The private key in `Authorization: Klaviyo-API-Key <key>`, or `undefined`. */
export const klaviyoApiKey = (request: Request): string | undefined => {
  const header = request.headers.get("authorization")
  const match = header ? /^Klaviyo-API-Key\s+(\S+)\s*$/i.exec(header.trim()) : null
  return match?.[1]
}

export type ErrorEntry = {
  status: number
  code: string
  title: string
  detail: string
  source?: { pointer?: string; parameter?: string }
}

/** A JSON:API error body, as every Klaviyo endpoint answers errors. */
export const klaviyoError = (entry: ErrorEntry, seed = `${entry.code}:${entry.detail}`) => ({
  errors: [
    {
      id: uuidFrom(seed),
      status: entry.status,
      code: entry.code,
      title: entry.title,
      detail: entry.detail,
      source: entry.source ?? { pointer: "/data/" },
      links: {},
      meta: {},
    },
  ],
})

export const uuidFrom = (seed: string) => {
  const hex = [...opaqueToken(seed, 32)].map((c) => (c.charCodeAt(0) % 16).toString(16)).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
