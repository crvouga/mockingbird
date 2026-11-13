import { Collection, IdSequence, OutboxStore } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { SrpChallenge } from "./srp.js"

export type CognitoAttribute = { Name: string; Value?: string }
export type CognitoUser = {
  username: string
  sub: string
  password: string
  attributes: CognitoAttribute[]
  confirmed: boolean
  enabled: boolean
  status: string
  createdAt: number
  /** UserLastModifiedDate; absent on users stored before it was tracked (createdAt stands in). */
  modifiedAt?: number
  groups: string[]
  identities: Record<string, unknown>[]
  confirmationCode?: string
  resetCode?: string
  /** The code UpdateUserAttributes sent for a changed email or phone, until VerifyUserAttribute. */
  attributeCode?: string
}
export type CognitoGroup = {
  groupName: string
  description?: string
  precedence?: number
  roleArn?: string
  createdAt: number
  modifiedAt: number
}
export type CognitoSession = {
  username: string
  clientId: string
  expires: number
  revoked: boolean
  kind: "access" | "refresh" | "challenge"
  /** The challenge a challenge session answers; older sessions without it are NEW_PASSWORD_REQUIRED. */
  challenge?: "NEW_PASSWORD_REQUIRED" | "PASSWORD_VERIFIER"
  /** The server's half of a USER_SRP_AUTH exchange, for PASSWORD_VERIFIER. */
  srp?: SrpChallenge
  /**
   * origin_jti and event_id of the sign-in a token came from; refreshes keep them, and RevokeToken
   * revokes every access token that shares its refresh token's origin.
   */
  origin?: TokenOrigin
  /** Unix seconds of the sign-in a refresh token came from; refreshed tokens keep it. */
  authTime?: number
  /** OAuth scopes granted through the hosted UI; refreshed tokens keep them. */
  scope?: string
}
/** A user-pool app client as the hosted UI (/oauth2/authorize, /oauth2/token) sees it. */
export type CognitoAppClient = {
  clientId: string
  /** When set, /oauth2/token requires it (client_secret_basic or client_secret_post). */
  clientSecret?: string
  /** Allowed callback URLs; redirect_uri must match one exactly. */
  callbackUrls: string[]
  /** SupportedIdentityProviders; omitted allows every provider name. */
  identityProviders?: string[]
  /** AllowedOAuthScopes; omitted allows the five system scopes. */
  scopes?: string[]
  /**
   * PreventUserExistenceErrors ENABLED: ForgotPassword and ResendConfirmationCode for an unknown
   * user answer a simulated delivery, and confirmations answer CodeMismatchException.
   */
  preventUserExistenceErrors?: boolean
}
/** A hosted-UI authorization in flight (picker shown) or an issued authorization code. */
export type HostedGrant = {
  kind: "transaction" | "code"
  clientId: string
  redirectUri: string
  state?: string
  scope: string
  provider: string
  challenge?: string
  nonce?: string
  username?: string
  expires: number
}
/** What triggered a Cognito message: the operation, as Cognito's custom message triggers name it. */
export type CognitoMessageTrigger =
  | "SignUp"
  | "ResendConfirmationCode"
  | "ForgotPassword"
  | "AdminCreateUser"
  | "UpdateUserAttributes"
/**
 * A message Cognito delivered (from its default sender) to a user's email address or phone, kept
 * in the namespace's outbox so `GET /__admin/outbox` and the notifications harness can show it.
 */
export type CognitoMessage = {
  id: string
  /** The email address or E.164 phone number the message went to. */
  to: string
  createdAt: string
  channel: "email" | "sms"
  deliveryMedium: "EMAIL" | "SMS"
  attributeName: "email" | "phone_number"
  username: string
  trigger: CognitoMessageTrigger
  /** The verification code, or null for an AdminCreateUser invitation (it carries a password). */
  code: string | null
  from: string
  /** Email only. */
  subject: string | null
  body: string
}
export type TokenOrigin = { originJti: string; eventId: string }
export type CognitoSeedUser = Partial<CognitoUser> & { username: string; password: string }
/** How usernames and sign-in aliases match: Cognito's UsernameConfiguration and alias attributes. */
export type CognitoMatching = { caseSensitive: boolean; aliases: readonly string[] }

export class CognitoState {
  readonly users: Collection<CognitoUser>
  readonly sessions: Collection<CognitoSession>
  readonly appClients: Collection<CognitoAppClient>
  readonly groups: Collection<CognitoGroup>
  readonly hosted: Collection<HostedGrant>
  /** The account the next /oauth2/authorize picks without rendering the picker. */
  readonly nextAccount: Collection<{ username: string }>
  readonly outbox: OutboxStore<CognitoMessage>
  /** Only its sequence is used: message ids sort in send order, even within one millisecond. */
  private readonly messageIds: Collection<never>
  private readonly ids: IdSequence
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seeds: readonly CognitoSeedUser[],
    private readonly matching: CognitoMatching = { caseSensitive: false, aliases: ["email"] },
  ) {
    this.users = new Collection(sqlite, namespace, "cognito_users")
    this.sessions = new Collection(sqlite, namespace, "cognito_sessions")
    this.appClients = new Collection(sqlite, namespace, "cognito_app_clients")
    this.groups = new Collection(sqlite, namespace, "cognito_groups")
    this.hosted = new Collection(sqlite, namespace, "cognito_hosted_grants")
    this.nextAccount = new Collection(sqlite, namespace, "cognito_hosted_next_account")
    this.outbox = new OutboxStore<CognitoMessage>(sqlite, namespace, "cognito_outbox")
    this.messageIds = new Collection(sqlite, namespace, "cognito_message_ids")
    this.ids = new IdSequence(sqlite, namespace, "cognito")
    this.seed()
  }
  seed() {
    for (const input of this.seeds) if (!this.users.has(input.username)) this.put(input)
  }
  put(input: CognitoSeedUser): CognitoUser {
    const existing = this.users.get(input.username)
    const confirmationCode = input.confirmationCode ?? existing?.confirmationCode
    const resetCode = input.resetCode ?? existing?.resetCode
    const attributeCode = input.attributeCode ?? existing?.attributeCode
    const modifiedAt = input.modifiedAt ?? existing?.modifiedAt
    const user: CognitoUser = {
      username: input.username,
      password: input.password,
      sub: input.sub ?? existing?.sub ?? this.newSub(),
      attributes: input.attributes ?? existing?.attributes ?? [],
      confirmed: input.confirmed ?? existing?.confirmed ?? false,
      enabled: input.enabled ?? existing?.enabled ?? true,
      status: input.status ?? existing?.status ?? (input.confirmed ? "CONFIRMED" : "UNCONFIRMED"),
      createdAt: input.createdAt ?? existing?.createdAt ?? Date.now(),
      groups: input.groups ?? existing?.groups ?? [],
      identities: input.identities ?? existing?.identities ?? [],
      ...(confirmationCode !== undefined ? { confirmationCode } : {}),
      ...(resetCode !== undefined ? { resetCode } : {}),
      ...(attributeCode !== undefined ? { attributeCode } : {}),
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
    }
    this.users.insert(user.username, user)
    // Groups a seeded or stored user names exist in the pool, as if created beforehand.
    for (const groupName of user.groups)
      if (!this.groups.has(groupName))
        this.groups.insert(groupName, {
          groupName,
          createdAt: user.createdAt,
          modifiedAt: user.createdAt,
        })
    return user
  }
  /** A version-4-shaped user subject from the namespace's sequence. */
  newSub(): string {
    return this.ids.next("00000000-0000-4000-8000-", 12)
  }
  /** Folds a username or alias value for comparison under the pool's case sensitivity. */
  fold(value: string): string {
    return this.matching.caseSensitive ? value : value.toLowerCase()
  }
  /**
   * The user a Username parameter names: the username, then the sub, then a sign-in alias
   * (email, plus phone_number when it is a username attribute), under the pool's case rule.
   */
  find(name: string): CognitoUser | undefined {
    const direct = this.users.get(name)
    if (direct) return direct
    const key = this.fold(name)
    const users = this.users.list().map(({ value }) => value)
    return (
      users.find((user) => this.fold(user.username) === key) ??
      users.find((user) => user.sub === name) ??
      users.find((user) =>
        user.attributes.some(
          (attribute) =>
            this.matching.aliases.includes(attribute.Name) &&
            attribute.Value !== undefined &&
            this.fold(attribute.Value) === key,
        ),
      )
    )
  }
  /** Another user holding `value` in alias attribute `name`. */
  aliasOwner(name: string, value: string, except?: CognitoUser): CognitoUser | undefined {
    const key = this.fold(value)
    return this.users
      .list()
      .map(({ value: user }) => user)
      .find(
        (user) =>
          user.username !== except?.username &&
          user.attributes.some(
            (attribute) =>
              attribute.Name === name &&
              attribute.Value !== undefined &&
              this.fold(attribute.Value) === key,
          ),
      )
  }
  messageId(): string {
    return `msg-${String(this.messageIds.nextSequence()).padStart(10, "0")}`
  }
  token(prefix: string): string {
    return this.ids.next(prefix, 32)
  }
  /** A version-4-shaped UUID from the namespace's seeded sequence, so runs stay reproducible. */
  uuid(sequence: string): string {
    const hex = [...this.ids.next(`${sequence}:`, 32).slice(sequence.length + 1)]
      .map((char) => (char.charCodeAt(0) % 16).toString(16))
      .join("")
    const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}
