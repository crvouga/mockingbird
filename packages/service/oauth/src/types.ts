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
export type RedirectPolicy = {
  /**
   * RFC 8252 section 7.3: an `http://` loopback redirect (`127.0.0.1`, `[::1]` or `localhost`) may
   * use any port. It must match a registered loopback URI on the same host, path and query.
   */
  loopbackAnyPort?: boolean
  /**
   * Custom schemes (for example `["exp:"]` for Expo dev clients) whose host and port may vary per
   * request, such as a LAN address. A request must still match a registered URI with the same
   * scheme, path and query. `http:`/`https:` and executable schemes are rejected.
   */
  schemes?: string[]
}
export type Client = {
  id: string
  name: string
  redirectUris: string[]
  secret?: string
  requirePkce?: boolean
  /**
   * Cognito-style public app client: let a client without a secret omit PKCE. A challenge that is
   * sent is still verified. Default `false`: public clients must use S256 PKCE. Incompatible with
   * `requirePkce: true` and with a client `secret`/`apple` configuration.
   */
  pkceOptional?: boolean
  /**
   * Cognito-style refresh tokens: every authorization-code exchange returns a `refresh_token`,
   * whether or not `offline_access` was requested. Default `false`: the profile's own rule applies
   * (`offline_access` for OIDC and Microsoft, `access_type=offline` for Google; Apple always).
   */
  alwaysIssueRefreshToken?: boolean
  /**
   * Opt-in redirect matching for dev clients. Exact registered URIs always match; this adds
   * variants of registered URIs, never arbitrary URIs. Default: exact match only.
   */
  redirectPolicy?: RedirectPolicy
  /** Apple developer/app grouping or OIDC pairwise identity sector. */
  subjectGroup?: string
  /** Verify an Apple ES256 client-secret JWT instead of a static fixture secret. */
  apple?: {
    teamId: string
    keyId: string
    publicKey: JsonWebKey
    /** Where Sign in with Apple server-to-server notifications are POSTed. */
    notificationUrl?: string
  }
}
export type AppleNotificationType =
  | "consent-revoked"
  | "account-delete"
  | "email-disabled"
  | "email-enabled"
/** Outcome of one server-to-server notification; a failed delivery never throws. */
export type NotificationDelivery = {
  clientId: string
  type: AppleNotificationType
  delivered: boolean
  status?: number
  error?: string
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
/** What one client sees for one account: see `OAuthAPI.grant`. */
export type GrantView = {
  subject: string
  granted: boolean
  scopes: string[]
  emailChoice: "share" | "hide" | null
  email: string
  isPrivateEmail: boolean
  userDisclosed: boolean
}
