import type { Decisions } from "./behavior.js"
export type Provider = "google" | "apple" | "oidc" | "microsoft" | "github"
export type Account = {
  id: string
  email: string
  name: string
  emailVerified?: boolean
  picture?: string
  givenName?: string
  familyName?: string
  locale?: string
  hostedDomain?: string
  privateEmail?: boolean
  disabled?: boolean
  /** Apple relay address override; generated when omitted. */
  relayEmail?: string
  /** Apple risk signal: 0 unsupported, 1 unknown, 2 likely real person. */
  realUserStatus?: 0 | 1 | 2
  /** Apple app-transfer subject, when the fixture is exercising account migration. */
  transferSub?: string
  omitEmail?: boolean
  omitName?: boolean
  /** Microsoft mutable display login; never use as the stable identity. */
  preferredUsername?: string
  tenantId?: string
  objectId?: string
  /** GitHub has separate public profile email and authenticated email collection. */
  github?: {
    id: number
    login: string
    publicEmail?: string | null
    emails?: {
      email: string
      primary: boolean
      verified: boolean
      visibility: "public" | "private" | null
    }[]
  }
}
export type Client = {
  id: string
  name: string
  redirectUris: string[]
  secret?: string
  requirePkce?: boolean
  /** Apple developer/app grouping or OIDC pairwise identity sector. */
  subjectGroup?: string
  /** Verify an Apple ES256 client-secret JWT instead of a static fixture secret. */
  apple?: { teamId: string; keyId: string; publicKey: JsonWebKey }
}
export type Authorization = {
  clientId: string
  redirectUri: string
  scope: string
  state: string
  nonce: string
  responseType: string
  responseMode: string
  challenge: string
  expires: number
  offline: boolean
  forceConsent: boolean
  includeGrantedScopes: boolean
  decisions: Decisions
  emailChoice?: "hide" | "share"
  authTime: number
  accountId?: string
}
export type Grant = Authorization & {
  accountId: string
  family: string
  identity: { sub: string; email: string; privateEmail: boolean }
  issueRefresh: boolean
}
export type Token = Grant & { kind: "access" | "refresh"; consumed?: boolean; lastUsed?: number }
