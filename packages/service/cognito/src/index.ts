import { requestBaseUrl } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  bootSqlite,
  Collection,
  sigV4AccessKeyId,
} from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { CognitoSigner, type CognitoSigningKey } from "./crypto.js"
import { redactedUser } from "./fixtures.js"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  basicCredentials,
  errorPage,
  pickerPage,
  providerType,
  redirectTo,
  S256_ONLY,
  SYSTEM_SCOPES,
  s256,
  TOKEN_CORS,
  tokenJson,
} from "./hosted-ui.js"
import { poolName, type SrpChallenge, serverB, startSrp, verifySrp } from "./srp.js"
import {
  type CognitoAppClient,
  type CognitoAttribute,
  type CognitoGroup,
  type CognitoMessage,
  type CognitoMessageTrigger,
  type CognitoSeedUser,
  CognitoState,
  type CognitoUser,
  type TokenOrigin,
} from "./state.js"

export type { CognitoFixtures } from "./fixtures.js"
export type { CognitoRuntime, CognitoRuntimeOptions } from "./runtime.js"
export { COGNITO_PRESETS, createRuntime } from "./runtime.js"
export type {
  CognitoAppClient,
  CognitoAttribute,
  CognitoGroup,
  CognitoMessage,
  CognitoMessageTrigger,
  CognitoSeedUser,
  CognitoUser,
} from "./state.js"
export { document, operationIds, supportedOperationIds }
export const COGNITO_NAMESPACE = "cognito"
export const accessKeyCredential = sigV4AccessKeyId

export type CognitoAPIOptions = APIOptions & {
  poolId?: string
  clientId?: string
  region?: string
  users?: readonly CognitoSeedUser[]
  /** App clients for the hosted UI; the default client is registered with no callback URLs. */
  appClients?: readonly CognitoAppClient[]
  baseUrl?: string
  publicNamespace?: string
  adminPrefix?: string
  /**
   * The pool's UsernameAttributes: users sign up with an email address or phone number, and
   * Cognito generates the username (the sub). Omitted, any username is accepted.
   */
  usernameAttributes?: readonly ("email" | "phone_number")[]
  /** UsernameConfiguration.CaseSensitive; false (the default) matches usernames and aliases case-insensitively. */
  usernameCaseSensitive?: boolean
}
const headers = (requestId: string) => ({
  "content-type": "application/x-amz-json-1.1",
  "x-amzn-requestid": requestId,
  "cache-control": "no-store",
})
const attr = (user: CognitoUser, name: string) =>
  user.attributes.find((value) => value.Name === name)?.Value
// Cognito signs ID and access tokens with different keys, so each token type has its own ring.
const KEY_RINGS = { id: "ring", access: "access-ring" } as const
type KeyRing = (typeof KEY_RINGS)[keyof typeof KEY_RINGS]
/** Cognito's default sender and message templates (no custom VerificationMessageTemplate). */
export const COGNITO_DEFAULT_SENDER = "no-reply@verificationemail.com"
const SMS_SENDER = "Cognito"
const VERIFICATION_SUBJECT = "Your verification code"
const verificationMessage = (code: string) => `Your verification code is ${code}.`
const INVITATION_SUBJECT = "Your temporary password"
const invitationMessage = (username: string, password: string) =>
  `Your username is ${username} and temporary password is ${password}.`
type Medium = "EMAIL" | "SMS"
const ATTRIBUTE_FOR: Record<Medium, "email" | "phone_number"> = {
  EMAIL: "email",
  SMS: "phone_number",
}
/** Where a verification code goes: the email address if the user has one, else the phone. */
const verificationMedium = (user: CognitoUser): Medium | null =>
  attr(user, "email") ? "EMAIL" : attr(user, "phone_number") ? "SMS" : null
const codeDeliveryDetails = (user: CognitoUser) => {
  const medium = verificationMedium(user)
  if (!medium)
    return { Destination: user.username, DeliveryMedium: "EMAIL", AttributeName: "email" }
  return {
    Destination: attr(user, ATTRIBUTE_FOR[medium]),
    DeliveryMedium: medium,
    AttributeName: ATTRIBUTE_FOR[medium],
  }
}
/** A user as ListUsers and AdminCreateUser return it; AttributesToGet narrows the attributes. */
const publicUser = (user: CognitoUser, attributesToGet?: unknown) => {
  const attributes = [{ Name: "sub", Value: user.sub }, ...user.attributes]
  return {
    Username: user.username,
    Attributes: Array.isArray(attributesToGet)
      ? attributes.filter((attribute) => attributesToGet.includes(attribute.Name))
      : attributes,
    UserCreateDate: user.createdAt / 1000,
    UserLastModifiedDate: (user.modifiedAt ?? user.createdAt) / 1000,
    Enabled: user.enabled,
    UserStatus: user.status,
  }
}
const attributesOf = (body: Record<string, unknown>) =>
  Array.isArray(body.UserAttributes) ? (body.UserAttributes as CognitoAttribute[]) : []
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+\d{4,15}$/
/** Attributes a user verifies with a code: changing one through UpdateUserAttributes sends one. */
const VERIFIABLE = new Set(["email", "phone_number"])
/** Operations IAM-authorized like the Admin* ones, though their names do not say so. */
const IAM_OPERATIONS = new Set([
  "ListUsers",
  "ListUsersInGroup",
  "CreateGroup",
  "GetGroup",
  "ListGroups",
  "DeleteGroup",
  "DescribeUserPool",
  "DescribeUserPoolClient",
])
/** ListUsers' searchable attributes (custom attributes are not searchable). */
const SEARCHABLE = new Set([
  "username",
  "email",
  "phone_number",
  "name",
  "given_name",
  "family_name",
  "preferred_username",
  "cognito:user_status",
  "status",
  "sub",
])
const AUTH_FLOWS = [
  "USER_SRP_AUTH",
  "REFRESH_TOKEN_AUTH",
  "REFRESH_TOKEN",
  "CUSTOM_AUTH",
  "ADMIN_NO_SRP_AUTH",
  "USER_PASSWORD_AUTH",
  "ADMIN_USER_PASSWORD_AUTH",
  "USER_AUTH",
]
/** Real Cognito flows the emulator does not model; they answer an explicit error. */
const UNSUPPORTED_FLOWS = ["CUSTOM_AUTH", "USER_AUTH"]
const PAGE_TOKEN = /^mockingbird-page:(\d+)$/
/**
 * One page of at most `limit` (0 to 60; 0 or absent means 60) items after `token`, or the
 * InvalidParameterException message for a bad limit or a token this emulator did not issue.
 */
function paginate<T>(
  items: T[],
  limit: unknown,
  token: unknown,
): { items: T[]; next?: string } | { error: string } {
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit)))
    return {
      error: `Value '${String(limit)}' at 'limit' failed to satisfy constraint: Member must be an integer`,
    }
  if (typeof limit === "number" && (limit < 0 || limit > 60))
    return {
      error: `1 validation error detected: Value '${limit}' at 'limit' failed to satisfy constraint: Member must have value ${limit < 0 ? "greater than or equal to 0" : "less than or equal to 60"}`,
    }
  let offset = 0
  if (token !== undefined) {
    let decoded = ""
    try {
      decoded = typeof token === "string" ? atob(token) : ""
    } catch {}
    const match = PAGE_TOKEN.exec(decoded)
    offset = match ? Number(match[1]) : Number.NaN
    if (!Number.isSafeInteger(offset) || offset > items.length)
      return { error: "Invalid pagination token." }
  }
  const size = typeof limit === "number" && limit > 0 ? limit : 60
  const end = offset + size
  return {
    items: items.slice(offset, end),
    ...(end < items.length ? { next: btoa(`mockingbird-page:${end}`) } : {}),
  }
}

export class CognitoAPI {
  readonly state: CognitoState
  private readonly signingKeys: Collection<CognitoSigningKey[]>
  private readonly initializingKeys = new Map<KeyRing, Promise<CognitoSigningKey[]>>()
  private readonly publicNamespace: string
  private readonly adminPrefix: string
  private readonly baseUrl: string | undefined
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly poolId: string
  private readonly defaultClientId: string
  private readonly configuredClients: readonly CognitoAppClient[]
  private readonly region: string
  private readonly usernameAttributes: readonly ("email" | "phone_number")[]
  private readonly caseSensitive: boolean
  /** Attributes that sign a user in, and so must be unique: email, plus any username attribute. */
  private readonly aliases: readonly string[]
  constructor(options: CognitoAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? COGNITO_NAMESPACE
    this.now = options.now ?? Date.now
    this.poolId = options.poolId ?? "us-east-1_mockingbird"
    this.defaultClientId = options.clientId ?? "mockingbird-client"
    this.configuredClients = structuredClone(options.appClients ?? [])
    this.region = options.region ?? this.poolId.split("_")[0] ?? "us-east-1"
    this.usernameAttributes = [...new Set(options.usernameAttributes ?? [])]
    this.caseSensitive = options.usernameCaseSensitive === true
    this.aliases = [...new Set(["email", ...this.usernameAttributes])]
    this.publicNamespace = options.publicNamespace ?? "default"
    this.adminPrefix = options.adminPrefix ?? "/__admin"
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "")
    if (this.baseUrl) {
      const url = new URL(this.baseUrl)
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("baseUrl must be HTTP(S) without credentials, query or fragment")
    }
    this.signingKeys = new Collection(this.sqlite, this.namespace, "cognito_signing_keys")
    this.state = new CognitoState(this.sqlite, this.namespace, options.users ?? [], {
      caseSensitive: this.caseSensitive,
      aliases: this.aliases,
    })
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.state.seed()
  }
  private async keyRing(name: KeyRing): Promise<CognitoSigningKey[]> {
    const stored = this.signingKeys.get(name)
    if (stored) return stored
    // Concurrent first requests share initialization. Subsequent requests always read storage,
    // so portable restore and time travel cannot leave an obsolete in-memory signer behind.
    // A ring missing from an older archive (the access ring) is created on first use.
    let pending = this.initializingKeys.get(name)
    if (!pending) {
      pending = new CognitoSigner()
        .export()
        .then((key) => {
          const ring = this.signingKeys.get(name) ?? [key]
          this.signingKeys.insert(name, ring)
          return ring
        })
        .finally(() => this.initializingKeys.delete(name))
      this.initializingKeys.set(name, pending)
    }
    return pending
  }
  async rotateSigningKey(retainPrevious = true) {
    const rotate = async (name: KeyRing) => {
      await this.keyRing(name)
      const key = await new CognitoSigner().export()
      const retained = retainPrevious ? (this.signingKeys.get(name) ?? []).slice(0, 2) : []
      this.signingKeys.insert(name, [key, ...retained])
      return key.kid
    }
    return { kid: await rotate(KEY_RINGS.id), accessKid: await rotate(KEY_RINGS.access) }
  }
  /**
   * Signs each token with its type's current key (picked by `token_use`) and stamps a fresh
   * `jti` plus the sign-in's `origin_jti` and `event_id`.
   */
  private async tokenSigner(origin: TokenOrigin) {
    const signers = {
      id: new CognitoSigner((await this.keyRing(KEY_RINGS.id))[0]),
      access: new CognitoSigner((await this.keyRing(KEY_RINGS.access))[0]),
    }
    return {
      sign: (claims: Record<string, unknown> & { token_use: "id" | "access" }) =>
        signers[claims.token_use].sign({
          ...claims,
          jti: this.state.uuid("jti"),
          origin_jti: origin.originJti,
          event_id: origin.eventId,
        }),
    }
  }
  /** The public origin plus namespace prefix: the hosted-UI domain in this emulator. */
  private publicBase(request: Request) {
    const prefix =
      this.publicNamespace === "default"
        ? ""
        : `${this.adminPrefix}/ns/${encodeURIComponent(this.publicNamespace)}`
    return `${this.baseUrl ?? requestBaseUrl(request)}${prefix}`
  }
  private issuer(request: Request, poolId = this.poolId) {
    return `${this.publicBase(request)}/${encodeURIComponent(poolId)}`
  }
  /** Admin-registered clients win over configured ones; the default client always exists. */
  appClient(clientId: unknown): CognitoAppClient | undefined {
    if (typeof clientId !== "string" || !clientId) return undefined
    return (
      this.state.appClients.get(clientId) ??
      this.configuredClients.find((client) => client.clientId === clientId) ??
      (clientId === this.defaultClientId ? { clientId, callbackUrls: [] } : undefined)
    )
  }
  appClients(): CognitoAppClient[] {
    const clients = new Map<string, CognitoAppClient>()
    clients.set(this.defaultClientId, { clientId: this.defaultClientId, callbackUrls: [] })
    for (const client of this.configuredClients) clients.set(client.clientId, client)
    for (const { value } of this.state.appClients.list({ order: "oldest" }))
      clients.set(value.clientId, value)
    return [...clients.values()]
  }
  /** Records the message Cognito would send `user` over `medium`; no-op without that attribute. */
  private deliver(
    user: CognitoUser,
    medium: Medium,
    trigger: CognitoMessageTrigger,
    content: { code: string | null; subject: string; body: string },
  ): CognitoMessage | undefined {
    const attributeName = ATTRIBUTE_FOR[medium]
    const to = attr(user, attributeName)
    if (!to) return undefined
    const email = medium === "EMAIL"
    return this.state.outbox.record({
      id: this.state.messageId(),
      to,
      createdAt: new Date(this.now()).toISOString(),
      channel: email ? "email" : "sms",
      deliveryMedium: medium,
      attributeName,
      username: user.username,
      trigger,
      code: content.code,
      from: email ? COGNITO_DEFAULT_SENDER : SMS_SENDER,
      subject: email ? content.subject : null,
      body: content.body,
    })
  }
  private sendCode(user: CognitoUser, trigger: CognitoMessageTrigger, code: string) {
    const medium = verificationMedium(user)
    if (medium)
      this.deliver(user, medium, trigger, {
        code,
        subject: VERIFICATION_SUBJECT,
        body: verificationMessage(code),
      })
    return codeDeliveryDetails(user)
  }
  /**
   * AdminCreateUser's invitation: the temporary password over each DesiredDeliveryMediums the
   * user has an attribute for. Without DesiredDeliveryMediums Cognito defaults to SMS; a user
   * with no phone_number gets it by email instead (best guess, not oracle-verified).
   */
  private invite(user: CognitoUser, password: string, desired: unknown) {
    const requested = Array.isArray(desired)
      ? desired.filter((m): m is Medium => m === "EMAIL" || m === "SMS")
      : []
    const fallback: Medium[] = attr(user, "phone_number") ? ["SMS"] : ["EMAIL"]
    for (const medium of requested.length ? requested : fallback)
      this.deliver(user, medium, "AdminCreateUser", {
        code: null,
        subject: INVITATION_SUBJECT,
        body: invitationMessage(user.username, password),
      })
  }
  private requestId() {
    return this.state.token("req-")
  }
  private response(body: unknown, status = 200, requestId = this.requestId()) {
    return new Response(JSON.stringify(body), { status, headers: headers(requestId) })
  }
  private error(type: string, message: string, status = 400) {
    return this.response({ __type: type, message }, status)
  }
  private requireUser(username: unknown) {
    return typeof username === "string" ? this.state.find(username) : undefined
  }
  /** Stores `changes` and moves UserLastModifiedDate. */
  private save(user: CognitoUser, changes: Partial<CognitoUser>) {
    return this.state.put({ ...user, ...changes, modifiedAt: this.now() })
  }
  private revokeAll(username: string) {
    for (const row of this.state.sessions.list({
      where: (session) => session.username === username,
    }))
      this.state.sessions.update(row.id, { ...row.value, revoked: true })
  }
  private passwordValid(value: unknown) {
    return (
      typeof value === "string" &&
      value.length >= 8 &&
      /[A-Z]/.test(value) &&
      /[a-z]/.test(value) &&
      /\d/.test(value)
    )
  }
  /** The first invalid attribute's error, or undefined: email format, then alias uniqueness. */
  private attributeError(attributes: CognitoAttribute[], user?: CognitoUser) {
    for (const { Name, Value } of attributes) {
      if (Name === "email" && Value !== undefined && !EMAIL.test(Value))
        return this.error("InvalidParameterException", "Invalid email address format.")
      if (Name === "phone_number" && Value !== undefined && !PHONE.test(Value))
        return this.error("InvalidParameterException", "Invalid phone number format.")
    }
    if (!user) return undefined
    for (const { Name, Value } of attributes)
      if (this.aliases.includes(Name) && Value && this.state.aliasOwner(Name, Value, user))
        return this.error(
          "AliasExistsException",
          `An account with the given ${Name === "email" ? "email" : "phone_number"} already exists.`,
        )
    return undefined
  }
  /**
   * SignUp and AdminCreateUser: validates the username and attributes, and in a pool whose
   * usernameAttributes include email or phone_number turns the alias into a generated username
   * (the sub) plus that attribute, as Cognito does.
   */
  private newUser(
    username: unknown,
    attributes: CognitoAttribute[],
  ): Response | { username: string; sub?: string; attributes: CognitoAttribute[] } {
    if (typeof username !== "string" || !username)
      return this.error("InvalidParameterException", "Username is required")
    const invalid = this.attributeError(attributes)
    if (invalid) return invalid
    let created: { username: string; sub?: string; attributes: CognitoAttribute[] } = {
      username,
      attributes,
    }
    if (this.usernameAttributes.length) {
      const name = this.usernameAttributes.find((attribute) =>
        (attribute === "email" ? EMAIL : PHONE).test(username),
      )
      if (!name)
        return this.error(
          "InvalidParameterException",
          this.usernameAttributes.length > 1
            ? "Username should be either an email or a phone number."
            : this.usernameAttributes[0] === "email"
              ? "Username should be an email."
              : "Username should be a phone number.",
        )
      const sub = this.state.newSub()
      created = {
        username: sub,
        sub,
        attributes: [
          ...attributes.filter((attribute) => attribute.Name !== name),
          { Name: name, Value: username },
        ],
      }
    }
    if (this.state.find(username))
      return this.error(
        "UsernameExistsException",
        this.usernameAttributes.length
          ? "An account with the given email already exists."
          : "An account with the given username already exists.",
      )
    for (const { Name, Value } of created.attributes)
      if (this.aliases.includes(Name) && Value && this.state.aliasOwner(Name, Value))
        return this.error(
          "UsernameExistsException",
          `An account with the given ${Name} already exists.`,
        )
    return created
  }
  /** With PreventUserExistenceErrors, the delivery Cognito pretends to make for an unknown user. */
  private simulatedDelivery(username: unknown) {
    const name = typeof username === "string" ? username : ""
    const [local = "", domain = ""] = name.split("@")
    return {
      CodeDeliveryDetails: {
        Destination: domain ? `${local.slice(0, 1)}***@${domain.slice(0, 1)}***` : "***",
        DeliveryMedium: "EMAIL",
        AttributeName: "email",
      },
    }
  }
  private preventsExistenceErrors(clientId: string) {
    return this.appClient(clientId)?.preventUserExistenceErrors === true
  }
  private challenge(
    user: CognitoUser,
    clientId: string,
    name: "NEW_PASSWORD_REQUIRED" | "PASSWORD_VERIFIER",
    srp?: SrpChallenge,
  ) {
    const session = this.state.token("challenge-")
    this.state.sessions.insert(session, {
      username: user.username,
      clientId,
      expires: this.now() + 300_000,
      revoked: false,
      kind: "challenge",
      challenge: name,
      ...(srp ? { srp } : {}),
    })
    return session
  }
  /**
   * After the password checks out: a disabled, reset-required or unconfirmed user is refused,
   * a FORCE_CHANGE_PASSWORD user gets NEW_PASSWORD_REQUIRED, anyone else gets tokens.
   */
  private async signedIn(request: Request, user: CognitoUser, clientId: string) {
    if (!user.enabled) return this.error("NotAuthorizedException", "User is disabled.")
    if (user.status === "RESET_REQUIRED")
      return this.error("PasswordResetRequiredException", "Password reset required for the user")
    if (user.status === "FORCE_CHANGE_PASSWORD")
      return this.response({
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ChallengeParameters: {
          USER_ID_FOR_SRP: user.username,
          requiredAttributes: "[]",
          userAttributes: JSON.stringify(
            Object.fromEntries(user.attributes.map(({ Name, Value }) => [Name, Value ?? ""])),
          ),
        },
        Session: this.challenge(user, clientId, "NEW_PASSWORD_REQUIRED"),
      })
    if (!user.confirmed) return this.error("UserNotConfirmedException", "User is not confirmed.")
    return this.response({ AuthenticationResult: await this.tokens(request, user, clientId) })
  }
  private async passwordAuth(
    request: Request,
    parameters: Record<string, unknown>,
    clientId: string,
  ) {
    const user = this.requireUser(parameters.USERNAME)
    if (!user || user.status === "EXTERNAL_PROVIDER" || user.password !== parameters.PASSWORD)
      return this.error("NotAuthorizedException", "Incorrect username or password.")
    return this.signedIn(request, user, clientId)
  }
  /** InitiateAuth USER_SRP_AUTH: the PASSWORD_VERIFIER challenge for the client's SRP_A. */
  private async srpAuth(parameters: Record<string, unknown>, clientId: string) {
    const user = this.requireUser(parameters.USERNAME)
    if (!user || user.status === "EXTERNAL_PROVIDER")
      return this.error("NotAuthorizedException", "Incorrect username or password.")
    const srp = await startSrp(parameters.SRP_A, this.state.token("srp-"))
    if (!srp) return this.error("InvalidParameterException", "Invalid SRP_A value.")
    const srpB = await serverB(srp, poolName(this.poolId), user.username, user.password)
    return this.response({
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: {
        SALT: srp.salt,
        SECRET_BLOCK: srp.secretBlock,
        SRP_B: srpB.toString(16),
        USERNAME: user.username,
        USER_ID_FOR_SRP: user.username,
      },
      Session: this.challenge(user, clientId, "PASSWORD_VERIFIER", srp),
    })
  }
  private async refreshAuth(request: Request, token: unknown, clientId: string) {
    const session = typeof token === "string" ? this.state.sessions.get(token) : undefined
    const user = session && this.state.find(session.username)
    if (
      session?.kind !== "refresh" ||
      session.clientId !== clientId ||
      session.revoked ||
      session.expires <= this.now() ||
      !user?.enabled
    )
      return this.error("NotAuthorizedException", "Invalid Refresh Token")
    return this.response({
      AuthenticationResult: await this.tokens(
        request,
        user,
        session.clientId,
        false,
        session.origin,
        session.authTime,
        session.scope !== undefined ? { scope: session.scope } : {},
      ),
    })
  }
  /** InitiateAuth and AdminInitiateAuth: each modelled flow, and an explicit error otherwise. */
  private async initiateAuth(
    request: Request,
    body: Record<string, unknown>,
    clientId: string,
    admin: boolean,
  ) {
    const flow = body.AuthFlow
    const parameters = (body.AuthParameters ?? {}) as Record<string, unknown>
    if (flow === "REFRESH_TOKEN_AUTH" || flow === "REFRESH_TOKEN")
      return this.refreshAuth(request, parameters.REFRESH_TOKEN, clientId)
    if (flow === "USER_SRP_AUTH") return this.srpAuth(parameters, clientId)
    const password = admin
      ? ["ADMIN_USER_PASSWORD_AUTH", "ADMIN_NO_SRP_AUTH"]
      : ["USER_PASSWORD_AUTH"]
    if (password.includes(flow as string)) return this.passwordAuth(request, parameters, clientId)
    // Cognito's answer for a flow that belongs to the other operation.
    const other = admin ? ["USER_PASSWORD_AUTH"] : ["ADMIN_USER_PASSWORD_AUTH", "ADMIN_NO_SRP_AUTH"]
    if (other.includes(flow as string))
      return this.error("InvalidParameterException", "Initiate Auth method not supported.")
    if (UNSUPPORTED_FLOWS.includes(flow as string))
      return this.error(
        "InvalidParameterException",
        `AuthFlow ${flow} is not supported by the Mockingbird Cognito emulator.`,
      )
    return this.error(
      "InvalidParameterException",
      `1 validation error detected: Value '${String(flow)}' at 'authFlow' failed to satisfy constraint: Member must satisfy enum value set: [${AUTH_FLOWS.join(", ")}]`,
    )
  }
  /** RespondToAuthChallenge and AdminRespondToAuthChallenge. */
  private async respondToChallenge(request: Request, body: Record<string, unknown>) {
    const id = typeof body.Session === "string" ? body.Session : undefined
    const session = id ? this.state.sessions.get(id) : undefined
    const responses = (body.ChallengeResponses ?? {}) as Record<string, unknown>
    const user = session?.kind === "challenge" ? this.state.find(session.username) : undefined
    if (!id || !session || session.revoked || session.expires <= this.now() || !user)
      return this.error("NotAuthorizedException", "Invalid session for the user")
    const challenge = session.challenge ?? "NEW_PASSWORD_REQUIRED"
    if (typeof body.ChallengeName === "string" && body.ChallengeName !== challenge)
      return this.error("InvalidParameterException", "Invalid challenge name for the session.")
    if (challenge === "PASSWORD_VERIFIER") {
      this.state.sessions.update(id, { ...session, revoked: true })
      const verified =
        session.srp &&
        (await verifySrp(session.srp, poolName(this.poolId), user.username, user.password, {
          secretBlock: responses.PASSWORD_CLAIM_SECRET_BLOCK,
          timestamp: responses.TIMESTAMP,
          signature: responses.PASSWORD_CLAIM_SIGNATURE,
        }))
      if (!verified) return this.error("NotAuthorizedException", "Incorrect username or password.")
      return this.signedIn(request, user, session.clientId)
    }
    if (!this.passwordValid(responses.NEW_PASSWORD))
      return this.error("InvalidPasswordException", "Password did not conform with policy")
    const updated = this.save(user, {
      password: responses.NEW_PASSWORD as string,
      confirmed: true,
      status: "CONFIRMED",
    })
    this.state.sessions.update(id, { ...session, revoked: true })
    return this.response({
      AuthenticationResult: await this.tokens(request, updated, session.clientId),
    })
  }
  /** ListUsers' Filter as a predicate, or the InvalidParameterException message. */
  private filter(value: unknown): ((user: CognitoUser) => boolean) | string {
    if (value === undefined || value === "") return () => true
    const match =
      typeof value === "string"
        ? /^\s*([\w:]+)\s*(\^?=)\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(value)
        : null
    if (!match) return "Error while parsing filter."
    const [, name = "", operator, raw = ""] = match
    if (!SEARCHABLE.has(name)) return `Invalid search attribute: ${name}`
    const wanted = raw.replace(/\\(.)/g, "$1")
    const read = (user: CognitoUser) =>
      name === "username"
        ? this.state.fold(user.username)
        : name === "sub"
          ? user.sub
          : name === "cognito:user_status"
            ? user.status
            : name === "status"
              ? user.enabled
                ? "Enabled"
                : "Disabled"
              : attr(user, name)
    const target = name === "username" ? this.state.fold(wanted) : wanted
    return (user) => {
      const actual = read(user)
      if (actual === undefined) return false
      return operator === "=" ? actual === target : actual.startsWith(target)
    }
  }
  private group(group: CognitoGroup) {
    return {
      GroupName: group.groupName,
      UserPoolId: this.poolId,
      ...(group.description !== undefined ? { Description: group.description } : {}),
      ...(group.roleArn !== undefined ? { RoleArn: group.roleArn } : {}),
      ...(group.precedence !== undefined ? { Precedence: group.precedence } : {}),
      CreationDate: group.createdAt / 1000,
      LastModifiedDate: group.modifiedAt / 1000,
    }
  }
  private userPool() {
    const users = this.state.users.list().length
    return {
      Id: this.poolId,
      Name: poolName(this.poolId),
      Arn: `arn:aws:cognito-idp:${this.region}:000000000000:userpool/${this.poolId}`,
      ...(this.usernameAttributes.length ? { UsernameAttributes: this.usernameAttributes } : {}),
      UsernameConfiguration: { CaseSensitive: this.caseSensitive },
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        },
      },
      MfaConfiguration: "OFF",
      EstimatedNumberOfUsers: users,
    }
  }
  private userPoolClient(client: CognitoAppClient) {
    return {
      UserPoolId: this.poolId,
      ClientName: client.clientId,
      ClientId: client.clientId,
      ...(client.clientSecret !== undefined ? { ClientSecret: client.clientSecret } : {}),
      ExplicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
      CallbackURLs: client.callbackUrls,
      ...(client.identityProviders ? { SupportedIdentityProviders: client.identityProviders } : {}),
      AllowedOAuthScopes: client.scopes ?? SYSTEM_SCOPES,
      PreventUserExistenceErrors: client.preventUserExistenceErrors ? "ENABLED" : "LEGACY",
    }
  }
  private async tokens(
    request: Request,
    user: CognitoUser,
    clientId: string,
    includeRefresh = true,
    origin: TokenOrigin = {
      originJti: this.state.uuid("origin_jti"),
      eventId: this.state.uuid("event_id"),
    },
    authTime?: number,
    oauth: { scope?: string; nonce?: string } = {},
  ) {
    const now = Math.floor(this.now() / 1000)
    const issuer = this.issuer(request)
    const identities = redactedUser(user).identities
    const common = {
      iss: issuer,
      sub: user.sub,
      auth_time: authTime ?? now,
      iat: now,
      exp: now + 3600,
      ...(user.groups.length ? { "cognito:groups": user.groups } : {}),
    }
    const signer = await this.tokenSigner(origin)
    // Keep user attributes in the ID token and username in the access token.
    const access = await signer.sign({
      ...common,
      username: user.username,
      client_id: clientId,
      token_use: "access",
      scope: oauth.scope ?? "aws.cognito.signin.user.admin",
    })
    const id = await signer.sign({
      ...common,
      "cognito:username": user.username,
      email: attr(user, "email"),
      email_verified: attr(user, "email_verified") === "true",
      ...(identities.length ? { identities } : {}),
      ...(oauth.nonce !== undefined ? { nonce: oauth.nonce } : {}),
      aud: clientId,
      token_use: "id",
    })
    this.state.sessions.insert(access, {
      username: user.username,
      clientId,
      expires: (now + 3600) * 1000,
      revoked: false,
      kind: "access",
      origin,
    })
    let refresh: string | undefined
    if (includeRefresh) {
      refresh = this.state.token("refresh-")
      this.state.sessions.insert(refresh, {
        username: user.username,
        clientId,
        expires: (now + 2_592_000) * 1000,
        revoked: false,
        kind: "refresh",
        origin,
        authTime: now,
        ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}),
      })
    }
    return {
      AccessToken: access,
      IdToken: id,
      ...(refresh ? { RefreshToken: refresh } : {}),
      ExpiresIn: 3600,
      TokenType: "Bearer",
    }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const discovery = /^\/([^/]+)\/\.well-known\/openid-configuration$/.exec(url.pathname)
    if (request.method === "GET" && discovery) {
      const issuer = this.issuer(request, decodeURIComponent(discovery[1] as string))
      return Response.json({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        authorization_endpoint: `${this.publicBase(request)}/oauth2/authorize`,
        token_endpoint: `${this.publicBase(request)}/oauth2/token`,
        response_types_supported: ["code"],
        scopes_supported: SYSTEM_SCOPES,
        code_challenge_methods_supported: S256_ONLY,
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      })
    }
    const jwks = /^\/([^/]+)\/\.well-known\/jwks\.json$/.exec(url.pathname)
    if (request.method === "GET" && jwks)
      return Response.json({
        keys: (
          await Promise.all(
            [...(await this.keyRing(KEY_RINGS.id)), ...(await this.keyRing(KEY_RINGS.access))].map(
              (key) => new CognitoSigner(key).jwks(),
            ),
          )
        ).flatMap((set) => set.keys),
      })
    const hosted = await this.hosted(request, url)
    if (hosted) return hosted
    if (request.method !== "POST" || url.pathname !== "/")
      return this.error("ResourceNotFoundException", "Not found", 404)
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return this.error("SerializationException", "Could not parse request body")
    }
    const target = request.headers.get("x-amz-target")?.split(".").at(-1) ?? ""
    if (
      (target.startsWith("Admin") || IAM_OPERATIONS.has(target)) &&
      !request.headers.get("authorization")
    )
      return this.error(
        "UnrecognizedClientException",
        "The security token included in the request is invalid.",
      )
    // A missing UserPoolId or ClientId falls back to the configured pool and default client.
    if (typeof body.UserPoolId === "string" && body.UserPoolId !== this.poolId)
      return this.error("ResourceNotFoundException", `User pool ${body.UserPoolId} does not exist.`)
    if (typeof body.ClientId === "string" && !this.appClient(body.ClientId))
      return this.error(
        "ResourceNotFoundException",
        `User pool client ${body.ClientId} does not exist.`,
      )
    const clientId = typeof body.ClientId === "string" ? body.ClientId : this.defaultClientId
    const username = body.Username
    if (target === "SignUp") {
      if (typeof username !== "string" || !this.passwordValid(body.Password))
        return this.error("InvalidPasswordException", "Password did not conform with policy")
      const created = this.newUser(username, attributesOf(body))
      if (created instanceof Response) return created
      const user = this.state.put({
        ...created,
        password: body.Password as string,
        createdAt: this.now(),
        confirmationCode: "123456",
      })
      return this.response({
        UserSub: user.sub,
        UserConfirmed: false,
        CodeDeliveryDetails: this.sendCode(user, "SignUp", "123456"),
      })
    }
    if (target === "ConfirmSignUp" || target === "AdminConfirmSignUp") {
      const user = this.requireUser(username)
      if (!user)
        return target === "ConfirmSignUp" && this.preventsExistenceErrors(clientId)
          ? this.error(
              "CodeMismatchException",
              "Invalid verification code provided, please try again.",
            )
          : this.error("UserNotFoundException", "User does not exist.")
      if (user.status !== "UNCONFIRMED")
        return this.error(
          "NotAuthorizedException",
          `User cannot be confirmed. Current status is ${user.status}`,
        )
      if (target === "ConfirmSignUp" && body.ConfirmationCode !== user.confirmationCode)
        return this.error(
          "CodeMismatchException",
          "Invalid verification code provided, please try again.",
        )
      this.save(user, { confirmed: true, status: "CONFIRMED" })
      return this.response({})
    }
    if (target === "ResendConfirmationCode") {
      const user = this.requireUser(username)
      if (!user)
        return this.preventsExistenceErrors(clientId)
          ? this.response(this.simulatedDelivery(username))
          : this.error("UserNotFoundException", "User does not exist.")
      if (user.status !== "UNCONFIRMED")
        return this.error("InvalidParameterException", "User is already confirmed.")
      const updated = this.state.put({ ...user, confirmationCode: "123456" })
      return this.response({
        CodeDeliveryDetails: this.sendCode(updated, "ResendConfirmationCode", "123456"),
      })
    }
    if (target === "InitiateAuth" || target === "AdminInitiateAuth")
      return this.initiateAuth(request, body, clientId, target === "AdminInitiateAuth")
    if (target === "RespondToAuthChallenge" || target === "AdminRespondToAuthChallenge")
      return this.respondToChallenge(request, body)
    if (target === "GetTokensFromRefreshToken")
      return this.refreshAuth(request, body.RefreshToken, clientId)
    if (target === "ForgotPassword") {
      const user = this.requireUser(username)
      if (!user)
        return this.preventsExistenceErrors(clientId)
          ? this.response(this.simulatedDelivery(username))
          : this.error("UserNotFoundException", "User does not exist.")
      const updated = this.state.put({ ...user, resetCode: "654321" })
      return this.response({
        CodeDeliveryDetails: this.sendCode(updated, "ForgotPassword", "654321"),
      })
    }
    if (target === "ConfirmForgotPassword") {
      const user = this.requireUser(username)
      if (!user && this.preventsExistenceErrors(clientId))
        return this.error(
          "CodeMismatchException",
          "Invalid verification code provided, please try again.",
        )
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      if (body.ConfirmationCode !== user.resetCode)
        return this.error(
          "CodeMismatchException",
          "Invalid verification code provided, please try again.",
        )
      if (!this.passwordValid(body.Password))
        return this.error("InvalidPasswordException", "Password did not conform with policy")
      const { resetCode: _resetCode, ...withoutCode } = user
      this.state.users.insert(user.username, {
        ...withoutCode,
        password: body.Password as string,
        modifiedAt: this.now(),
        // AdminResetUserPassword's RESET_REQUIRED ends with the new password.
        ...(user.status === "RESET_REQUIRED" ? { status: "CONFIRMED", confirmed: true } : {}),
      })
      return this.response({})
    }
    if (target === "AdminCreateUser") {
      const created = this.newUser(username, attributesOf(body))
      if (created instanceof Response) return created
      const temporary =
        typeof body.TemporaryPassword === "string" ? body.TemporaryPassword : "Mockingbird1"
      const user = this.state.put({
        ...created,
        password: temporary,
        createdAt: this.now(),
        status: "FORCE_CHANGE_PASSWORD",
      })
      if (body.MessageAction !== "SUPPRESS")
        this.invite(user, temporary, body.DesiredDeliveryMediums)
      return this.response({ User: publicUser(user) })
    }
    if (target === "AdminSetUserPassword") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      if (!this.passwordValid(body.Password))
        return this.error("InvalidPasswordException", "Password did not conform with policy")
      this.save(user, {
        password: body.Password as string,
        confirmed: body.Permanent === true,
        status: body.Permanent === true ? "CONFIRMED" : "FORCE_CHANGE_PASSWORD",
      })
      return this.response({})
    }
    if (target === "AdminGetUser") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      const { Attributes, ...rest } = publicUser(user)
      return this.response({ ...rest, UserAttributes: Attributes })
    }
    if (target === "AdminUpdateUserAttributes" || target === "UpdateUserAttributes") {
      const self = target === "UpdateUserAttributes"
      const user = self ? this.userForAccess(body.AccessToken) : this.requireUser(username)
      if (!user)
        return self
          ? this.error("NotAuthorizedException", "Access Token has been revoked")
          : this.error("UserNotFoundException", "User does not exist.")
      const incoming = attributesOf(body)
      const invalid = this.attributeError(incoming, user)
      if (invalid) return invalid
      const names = new Set(incoming.map((value) => value.Name))
      // A user who changes their own email must verify it again (Cognito's default).
      const changed = self
        ? incoming.find(
            ({ Name, Value }) =>
              VERIFIABLE.has(Name) && Value !== undefined && Value !== attr(user, Name),
          )
        : undefined
      const unverified = changed
        ? [{ Name: `${changed.Name}_verified`, Value: "false" }].filter(
            ({ Name }) => !names.has(Name),
          )
        : []
      const updated = this.save(user, {
        attributes: [
          ...user.attributes.filter(
            (value) => !names.has(value.Name) && !unverified.some((u) => u.Name === value.Name),
          ),
          ...incoming,
          ...unverified,
        ],
        ...(changed ? { attributeCode: "123456" } : {}),
      })
      if (!changed) return this.response(self ? { CodeDeliveryDetailsList: [] } : {})
      const medium: Medium = changed.Name === "email" ? "EMAIL" : "SMS"
      this.deliver(updated, medium, "UpdateUserAttributes", {
        code: "123456",
        subject: VERIFICATION_SUBJECT,
        body: verificationMessage("123456"),
      })
      return this.response({
        CodeDeliveryDetailsList: [
          { Destination: changed.Value, DeliveryMedium: medium, AttributeName: changed.Name },
        ],
      })
    }
    if (target === "VerifyUserAttribute") {
      const user = this.userForAccess(body.AccessToken)
      if (!user) return this.error("NotAuthorizedException", "Access Token has been revoked")
      const name = body.AttributeName
      if (typeof name !== "string" || !VERIFIABLE.has(name))
        return this.error("InvalidParameterException", "Invalid attribute name.")
      if (!user.attributeCode || body.Code !== user.attributeCode)
        return this.error(
          "CodeMismatchException",
          "Invalid verification code provided, please try again.",
        )
      const { attributeCode: _code, ...rest } = user
      this.state.users.insert(user.username, {
        ...rest,
        modifiedAt: this.now(),
        attributes: [
          ...user.attributes.filter((value) => value.Name !== `${name}_verified`),
          { Name: `${name}_verified`, Value: "true" },
        ],
      })
      return this.response({})
    }
    if (target === "AdminDeleteUserAttributes") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      const names = Array.isArray(body.UserAttributeNames) ? body.UserAttributeNames : []
      this.save(user, {
        attributes: user.attributes.filter((value) => !names.includes(value.Name)),
      })
      return this.response({})
    }
    if (target === "ListUsers") {
      const matches = this.filter(body.Filter)
      if (typeof matches === "string") return this.error("InvalidParameterException", matches)
      const users = this.state.users
        .list({ order: "oldest" })
        .map(({ value }) => value)
        .filter(matches)
      const page = paginate(users, body.Limit, body.PaginationToken)
      if ("error" in page) return this.error("InvalidParameterException", page.error)
      return this.response({
        Users: page.items.map((user) => publicUser(user, body.AttributesToGet)),
        ...(page.next ? { PaginationToken: page.next } : {}),
      })
    }
    if (["AdminDeleteUser", "DeleteUser"].includes(target)) {
      const user =
        target === "DeleteUser" ? this.userForAccess(body.AccessToken) : this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      this.state.users.delete(user.username)
      return this.response({})
    }
    if (target === "GetUser") {
      const user = this.userForAccess(body.AccessToken)
      if (!user) return this.error("NotAuthorizedException", "Access Token has been revoked")
      return this.response({
        Username: user.username,
        UserAttributes: [{ Name: "sub", Value: user.sub }, ...user.attributes],
      })
    }
    if (target === "ChangePassword") {
      const user = this.userForAccess(body.AccessToken)
      if (!user || user.password !== body.PreviousPassword)
        return this.error("NotAuthorizedException", "Incorrect username or password.")
      if (!this.passwordValid(body.ProposedPassword))
        return this.error("InvalidPasswordException", "Password did not conform with policy")
      this.save(user, { password: body.ProposedPassword as string })
      return this.response({})
    }
    if (target === "GlobalSignOut") {
      const user = this.userForAccess(body.AccessToken)
      if (!user) return this.error("NotAuthorizedException", "Access Token has been revoked")
      this.revokeAll(user.username)
      return this.response({})
    }
    if (target === "RevokeToken") {
      const token = typeof body.Token === "string" ? body.Token : ""
      const session = this.state.sessions.get(token)
      if (session?.kind === "access")
        return this.error("UnsupportedTokenTypeException", "Unsupported token type")
      // As in RFC 7009, an unknown or already revoked token is not an error.
      if (session?.kind !== "refresh") return this.response({})
      if (session.clientId !== clientId)
        return this.error("UnauthorizedException", "Invalid client for the refresh token")
      this.state.sessions.update(token, { ...session, revoked: true })
      const originJti = session.origin?.originJti
      if (originJti)
        for (const row of this.state.sessions.list({
          where: (other) => other.kind === "access" && other.origin?.originJti === originJti,
        }))
          this.state.sessions.update(row.id, { ...row.value, revoked: true })
      return this.response({})
    }
    if (target === "AdminResetUserPassword") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      const updated = this.save(user, { status: "RESET_REQUIRED", resetCode: "654321" })
      this.sendCode(updated, "ForgotPassword", "654321")
      return this.response({})
    }
    if (target === "AdminDisableUser" || target === "AdminEnableUser") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      this.save(user, { enabled: target === "AdminEnableUser" })
      // Disabling a user revokes its tokens (AdminDisableUser API reference).
      if (target === "AdminDisableUser") this.revokeAll(user.username)
      return this.response({})
    }
    if (target === "CreateGroup") {
      const name = body.GroupName
      if (typeof name !== "string" || !name)
        return this.error("InvalidParameterException", "GroupName is required")
      if (this.state.groups.has(name))
        return this.error("GroupExistsException", `A group with the name ${name} already exists.`)
      const now = this.now()
      const group: CognitoGroup = {
        groupName: name,
        ...(typeof body.Description === "string" ? { description: body.Description } : {}),
        ...(typeof body.Precedence === "number" ? { precedence: body.Precedence } : {}),
        ...(typeof body.RoleArn === "string" ? { roleArn: body.RoleArn } : {}),
        createdAt: now,
        modifiedAt: now,
      }
      this.state.groups.insert(name, group)
      return this.response({ Group: this.group(group) })
    }
    const groupName = typeof body.GroupName === "string" ? body.GroupName : ""
    const group = this.state.groups.get(groupName)
    if (target === "GetGroup") {
      if (!group) return this.error("ResourceNotFoundException", "Group not found.")
      return this.response({ Group: this.group(group) })
    }
    if (target === "DeleteGroup") {
      if (!group) return this.error("ResourceNotFoundException", "Group not found.")
      for (const { value } of this.state.users.list())
        if (value.groups.includes(groupName))
          this.save(value, { groups: value.groups.filter((name) => name !== groupName) })
      this.state.groups.delete(groupName)
      return this.response({})
    }
    if (target === "ListGroups") {
      const groups = this.state.groups.list({ order: "oldest" }).map(({ value }) => value)
      const page = paginate(groups, body.Limit, body.NextToken)
      if ("error" in page) return this.error("InvalidParameterException", page.error)
      return this.response({
        Groups: page.items.map((value) => this.group(value)),
        ...(page.next ? { NextToken: page.next } : {}),
      })
    }
    if (target === "ListUsersInGroup") {
      if (!group) return this.error("ResourceNotFoundException", "Group not found.")
      const users = this.state.users
        .list({ order: "oldest" })
        .map(({ value }) => value)
        .filter((user) => user.groups.includes(groupName))
      const page = paginate(users, body.Limit, body.NextToken)
      if ("error" in page) return this.error("InvalidParameterException", page.error)
      return this.response({
        Users: page.items.map((user) => publicUser(user)),
        ...(page.next ? { NextToken: page.next } : {}),
      })
    }
    if (target === "AdminListGroupsForUser") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      const groups = user.groups.flatMap((name) => this.state.groups.get(name) ?? [])
      const page = paginate(groups, body.Limit, body.NextToken)
      if ("error" in page) return this.error("InvalidParameterException", page.error)
      return this.response({
        Groups: page.items.map((value) => this.group(value)),
        ...(page.next ? { NextToken: page.next } : {}),
      })
    }
    if (["AdminAddUserToGroup", "AdminRemoveUserFromGroup"].includes(target)) {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      if (!group) return this.error("ResourceNotFoundException", "Group not found.")
      const groups =
        target === "AdminAddUserToGroup"
          ? [...new Set([...user.groups, groupName])]
          : user.groups.filter((value) => value !== groupName)
      this.save(user, { groups })
      return this.response({})
    }
    if (target === "DescribeUserPool") return this.response({ UserPool: this.userPool() })
    if (target === "DescribeUserPoolClient")
      return this.response({
        UserPoolClient: this.userPoolClient(this.appClient(clientId) as CognitoAppClient),
      })
    if (target === "AdminLinkProviderForUser") {
      const destination = (body.DestinationUser ?? {}) as Record<string, unknown>
      const source = (body.SourceUser ?? {}) as Record<string, unknown>
      const user = this.requireUser(destination.ProviderAttributeValue)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      this.save(user, { identities: [...user.identities, source] })
      return this.response({})
    }
    if (target === "AdminUserGlobalSignOut") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      this.revokeAll(user.username)
      return this.response({})
    }
    return this.error("UnknownOperationException", `Unknown operation ${target}`)
  }
  /** Users the hosted-UI picker offers: the pool's own (not federated) accounts. */
  pickableUsers(): CognitoUser[] {
    return this.state.users
      .list({ order: "oldest" })
      .map(({ value }) => value)
      .filter((user) => user.status !== "EXTERNAL_PROVIDER")
  }
  /**
   * Hosted UI: /oauth2/authorize, /oauth2/idpresponse, /oauth2/token and /error. Returns
   * undefined for every other route.
   */
  private async hosted(request: Request, url: URL): Promise<Response | undefined> {
    const path = url.pathname
    if (path === "/oauth2/authorize" && request.method === "GET")
      return this.authorize(request, url)
    if (path === "/oauth2/idpresponse" && request.method === "POST") {
      const form = new URLSearchParams(await request.text())
      return this.idpResponse(form.get("transaction"), form.get("username"), form.get("action"))
    }
    if (path === "/oauth2/token" && request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          ...TOKEN_CORS,
          "access-control-allow-headers":
            request.headers.get("access-control-request-headers") ?? "authorization, content-type",
        },
      })
    if (path === "/oauth2/token" && request.method === "POST") return this.token(request)
    if (path === "/error" && request.method === "GET")
      return errorPage(
        url.searchParams.get("error") ?? "unknown_error",
        url.searchParams.get("error_description") ?? "",
      )
    return undefined
  }
  private authorize(request: Request, url: URL): Response | Promise<Response> {
    const p = url.searchParams
    const base = this.publicBase(request)
    const client = this.appClient(p.get("client_id"))
    // Without a valid client and registered callback URL there is nowhere safe to send an
    // error, so the hosted UI's own /error page answers.
    if (!client)
      return redirectTo(`${base}/error`, {
        error: "invalid_client",
        client_id: p.get("client_id") ?? "",
      })
    const redirectUri = p.get("redirect_uri") ?? ""
    if (!client.callbackUrls.includes(redirectUri))
      return redirectTo(`${base}/error`, { error: "redirect_mismatch", client_id: client.clientId })
    const state = p.get("state") ?? undefined
    const fail = (error: string, description?: string) =>
      redirectTo(redirectUri, { error, error_description: description, state })
    const responseType = p.get("response_type")
    if (!responseType) return fail("invalid_request")
    if (responseType === "token")
      return fail("unauthorized_client", "The implicit grant is not modelled by this emulator")
    if (responseType !== "code") return fail("unsupported_response_type")
    const challenge = p.get("code_challenge") ?? undefined
    const method = p.get("code_challenge_method") ?? undefined
    if (
      (challenge === undefined) !== (method === undefined) ||
      (method !== undefined && method !== "S256")
    )
      return fail("invalid_request")
    if (p.has("idp_identifier") && !p.has("identity_provider"))
      return fail(
        "invalid_request",
        "idp_identifier is not modelled by this emulator; use identity_provider",
      )
    const provider = p.get("identity_provider") ?? "COGNITO"
    if (client.identityProviders && !client.identityProviders.includes(provider))
      return fail("invalid_request", "Login option is not available. Please try another one")
    // Requested scopes the client does not allow are ignored; none requested means all allowed.
    const allowed = client.scopes ?? SYSTEM_SCOPES
    const requested = (p.get("scope") ?? "").split(/[\s+]+/).filter(Boolean)
    const scope = (requested.length ? requested.filter((s) => allowed.includes(s)) : allowed).join(
      " ",
    )
    const transaction = this.state.token("txn-")
    const nonce = p.get("nonce") ?? undefined
    this.state.hosted.insert(transaction, {
      kind: "transaction",
      clientId: client.clientId,
      redirectUri,
      ...(state !== undefined ? { state } : {}),
      scope,
      provider,
      ...(challenge !== undefined ? { challenge } : {}),
      ...(nonce !== undefined ? { nonce } : {}),
      expires: this.now() + 600_000,
    })
    const next = this.state.nextAccount.get("next")
    if (next) {
      this.state.nextAccount.delete("next")
      return this.idpResponse(transaction, next.username, null)
    }
    return pickerPage(base, transaction, provider, this.pickableUsers())
  }
  private async idpResponse(
    transactionId: string | null,
    username: string | null,
    action: string | null,
  ): Promise<Response> {
    const grant = transactionId ? this.state.hosted.get(transactionId) : undefined
    if (grant?.kind !== "transaction" || grant.expires <= this.now())
      return errorPage("invalid_request", "The sign-in session expired or does not exist")
    this.state.hosted.delete(transactionId as string)
    const back = (params: Record<string, string | undefined>) =>
      redirectTo(grant.redirectUri, { ...params, state: grant.state })
    if (action === "cancel") return back({ error: "access_denied" })
    const picked = username ? this.state.users.get(username) : undefined
    if (!picked || picked.status === "EXTERNAL_PROVIDER")
      return errorPage("invalid_request", "Unknown account")
    const user = grant.provider === "COGNITO" ? picked : this.federate(grant.provider, picked)
    if (!user.enabled)
      return back({ error: "invalid_request", error_description: "User is disabled." })
    if (grant.provider === "COGNITO" && !user.confirmed)
      return back({ error: "invalid_request", error_description: "User is not confirmed." })
    const code = this.state.uuid("code")
    const { kind: _kind, state: _state, ...rest } = grant
    this.state.hosted.insert(code, {
      ...rest,
      kind: "code",
      username: user.username,
      // Authorization codes are valid for five minutes (authorization-endpoint docs).
      expires: this.now() + 300_000,
    })
    return back({ code })
  }
  /**
   * The user a federated sign-in lands on. The picked pool account stands in for the provider
   * account: its provider subject is the subject it is already linked under, else its `sub`.
   * A native user linked with AdminLinkProviderForUser to that subject signs in as itself;
   * otherwise Cognito's `<Provider>_<subject>` user is created on first sign-in.
   */
  private federate(provider: string, picked: CognitoUser): CognitoUser {
    const names = (identity: Record<string, unknown>) => ({
      provider: identity.providerName ?? identity.ProviderName,
      subject: identity.userId ?? identity.ProviderAttributeValue,
    })
    const own = picked.identities.map(names).find((identity) => identity.provider === provider)
    const subject = typeof own?.subject === "string" ? own.subject : picked.sub
    const linked = this.pickableUsers().find((user) =>
      user.identities.some((identity) => {
        const n = names(identity)
        return n.provider === provider && n.subject === subject
      }),
    )
    if (linked) return linked
    const username = `${provider}_${subject}`
    const existing = this.state.users.get(username)
    if (existing) return existing
    return this.state.put({
      username,
      // Federated users cannot sign in with a password; USER_PASSWORD_AUTH rejects them.
      password: "",
      createdAt: this.now(),
      attributes: picked.attributes.filter((attribute) => attribute.Name !== "sub"),
      confirmed: true,
      status: "EXTERNAL_PROVIDER",
      identities: [
        {
          userId: subject,
          providerName: provider,
          providerType: providerType(provider),
          issuer: null,
          primary: "true",
          dateCreated: String(this.now()),
        },
      ],
    })
  }
  private async token(request: Request): Promise<Response> {
    const fail = (error: string, description?: string) =>
      tokenJson({ error, ...(description ? { error_description: description } : {}) }, 400)
    const form = new URLSearchParams(await request.text())
    const basic = basicCredentials(request.headers.get("authorization"))
    const bodyId = form.get("client_id")
    if (basic && bodyId && basic.id !== bodyId) return fail("invalid_client")
    const client = this.appClient(basic?.id ?? bodyId)
    if (!client) return fail("invalid_client")
    if (client.clientSecret !== undefined) {
      const secret = basic?.secret ?? form.get("client_secret")
      if (secret !== client.clientSecret) return fail("invalid_client")
    }
    const grantType = form.get("grant_type")
    if (grantType === "authorization_code") {
      const code = form.get("code")
      if (!code) return fail("invalid_request")
      const grant = this.state.hosted.get(code)
      if (grant?.kind !== "code") return fail("invalid_grant")
      // A code is single use: any redemption attempt consumes it.
      this.state.hosted.delete(code)
      if (grant.expires <= this.now() || grant.clientId !== client.clientId)
        return fail("invalid_grant")
      const redirectUri = form.get("redirect_uri")
      if (!redirectUri) return fail("invalid_request")
      if (redirectUri !== grant.redirectUri) return fail("unauthorized_client", "invalid_redirect")
      if (grant.challenge !== undefined) {
        const verifier = form.get("code_verifier")
        if (!verifier || (await s256(verifier)) !== grant.challenge) return fail("invalid_grant")
      }
      const user = grant.username ? this.state.users.get(grant.username) : undefined
      if (!user?.enabled) return fail("invalid_grant")
      const tokens = await this.tokens(request, user, client.clientId, true, undefined, undefined, {
        scope: grant.scope,
        ...(grant.nonce !== undefined ? { nonce: grant.nonce } : {}),
      })
      return tokenJson({
        access_token: tokens.AccessToken,
        ...(grant.scope.split(" ").includes("openid") ? { id_token: tokens.IdToken } : {}),
        refresh_token: tokens.RefreshToken,
        token_type: "Bearer",
        expires_in: tokens.ExpiresIn,
      })
    }
    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token")
      if (!refreshToken) return fail("invalid_request")
      const session = this.state.sessions.get(refreshToken)
      const user = session && this.state.users.get(session.username)
      if (
        session?.kind !== "refresh" ||
        session.clientId !== client.clientId ||
        session.revoked ||
        session.expires <= this.now() ||
        !user ||
        !user.enabled
      )
        return fail("invalid_grant")
      const scope = session.scope ?? "aws.cognito.signin.user.admin"
      const tokens = await this.tokens(
        request,
        user,
        client.clientId,
        false,
        session.origin,
        session.authTime,
        { scope },
      )
      return tokenJson({
        access_token: tokens.AccessToken,
        // Refreshes of API sign-ins (no stored scope) carry an ID token, as InitiateAuth does.
        ...(session.scope === undefined || scope.split(" ").includes("openid")
          ? { id_token: tokens.IdToken }
          : {}),
        token_type: "Bearer",
        expires_in: tokens.ExpiresIn,
      })
    }
    if (grantType === "client_credentials")
      return fail("unsupported_grant_type", "client_credentials is not modelled by this emulator")
    return fail(grantType ? "unsupported_grant_type" : "invalid_request")
  }
  private userForAccess(value: unknown) {
    const session = typeof value === "string" ? this.state.sessions.get(value) : undefined
    return session?.kind === "access" && !session.revoked && session.expires > this.now()
      ? this.state.find(session.username)
      : undefined
  }
}
