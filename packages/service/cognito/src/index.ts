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
import {
  type CognitoAppClient,
  type CognitoAttribute,
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
const publicUser = (user: CognitoUser) => ({
  Username: user.username,
  Attributes: [{ Name: "sub", Value: user.sub }, ...user.attributes],
  UserCreateDate: user.createdAt / 1000,
  UserLastModifiedDate: user.createdAt / 1000,
  Enabled: user.enabled,
  UserStatus: user.status,
})

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
  constructor(options: CognitoAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? COGNITO_NAMESPACE
    this.now = options.now ?? Date.now
    this.poolId = options.poolId ?? "us-east-1_mockingbird"
    this.defaultClientId = options.clientId ?? "mockingbird-client"
    this.configuredClients = structuredClone(options.appClients ?? [])
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
    this.state = new CognitoState(this.sqlite, this.namespace, options.users ?? [])
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
  private passwordValid(value: unknown) {
    return (
      typeof value === "string" &&
      value.length >= 8 &&
      /[A-Z]/.test(value) &&
      /[a-z]/.test(value) &&
      /\d/.test(value)
    )
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
    if (target.startsWith("Admin") && !request.headers.get("authorization"))
      return this.error(
        "UnrecognizedClientException",
        "The security token included in the request is invalid.",
      )
    const clientId = typeof body.ClientId === "string" ? body.ClientId : this.defaultClientId
    const username = body.Username
    if (target === "SignUp") {
      if (typeof username !== "string" || !this.passwordValid(body.Password))
        return this.error("InvalidPasswordException", "Password did not conform with policy")
      if (this.state.find(username))
        return this.error(
          "UsernameExistsException",
          "An account with the given username already exists.",
        )
      const user = this.state.put({
        username,
        password: body.Password as string,
        createdAt: this.now(),
        attributes: Array.isArray(body.UserAttributes)
          ? (body.UserAttributes as CognitoAttribute[])
          : [],
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
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      if (target === "ConfirmSignUp" && body.ConfirmationCode !== user.confirmationCode)
        return this.error(
          "CodeMismatchException",
          "Invalid verification code provided, please try again.",
        )
      this.state.put({ ...user, confirmed: true, status: "CONFIRMED" })
      return this.response({})
    }
    if (target === "ResendConfirmationCode") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      const updated = this.state.put({ ...user, confirmationCode: "123456" })
      return this.response({
        CodeDeliveryDetails: this.sendCode(updated, "ResendConfirmationCode", "123456"),
      })
    }
    if (target === "InitiateAuth") {
      const flow = body.AuthFlow
      const parameters = (body.AuthParameters ?? {}) as Record<string, unknown>
      if (flow === "REFRESH_TOKEN_AUTH") {
        const session =
          typeof parameters.REFRESH_TOKEN === "string"
            ? this.state.sessions.get(parameters.REFRESH_TOKEN)
            : undefined
        const user = session && this.state.find(session.username)
        if (
          session?.kind !== "refresh" ||
          session.clientId !== clientId ||
          session.revoked ||
          session.expires <= this.now() ||
          !user
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
      const user = this.requireUser(parameters.USERNAME)
      if (
        !user ||
        user.status === "EXTERNAL_PROVIDER" ||
        user.password !== parameters.PASSWORD ||
        !user.enabled
      )
        return this.error("NotAuthorizedException", "Incorrect username or password.")
      if (!user.confirmed) return this.error("UserNotConfirmedException", "User is not confirmed.")
      if (user.status === "FORCE_CHANGE_PASSWORD") {
        const session = this.state.token("challenge-")
        this.state.sessions.insert(session, {
          username: user.username,
          clientId,
          expires: this.now() + 300_000,
          revoked: false,
          kind: "challenge",
        })
        return this.response({
          ChallengeName: "NEW_PASSWORD_REQUIRED",
          ChallengeParameters: { USER_ID_FOR_SRP: user.username, requiredAttributes: "[]" },
          Session: session,
        })
      }
      return this.response({ AuthenticationResult: await this.tokens(request, user, clientId) })
    }
    if (target === "RespondToAuthChallenge") {
      const session =
        typeof body.Session === "string" ? this.state.sessions.get(body.Session) : undefined
      const responses = (body.ChallengeResponses ?? {}) as Record<string, unknown>
      const user = session?.kind === "challenge" ? this.state.find(session.username) : undefined
      if (!session || session.revoked || session.expires <= this.now() || !user)
        return this.error("NotAuthorizedException", "Invalid session for the user")
      if (!this.passwordValid(responses.NEW_PASSWORD))
        return this.error("InvalidPasswordException", "Password did not conform with policy")
      const updated = this.state.put({
        ...user,
        password: responses.NEW_PASSWORD as string,
        confirmed: true,
        status: "CONFIRMED",
      })
      this.state.sessions.update(body.Session as string, { ...session, revoked: true })
      return this.response({
        AuthenticationResult: await this.tokens(request, updated, session.clientId),
      })
    }
    if (target === "ForgotPassword") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      const updated = this.state.put({ ...user, resetCode: "654321" })
      return this.response({
        CodeDeliveryDetails: this.sendCode(updated, "ForgotPassword", "654321"),
      })
    }
    if (target === "ConfirmForgotPassword") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      if (body.ConfirmationCode !== user.resetCode)
        return this.error(
          "CodeMismatchException",
          "Invalid verification code provided, please try again.",
        )
      if (!this.passwordValid(body.Password))
        return this.error("InvalidPasswordException", "Password did not conform with policy")
      const { resetCode: _resetCode, ...withoutCode } = user
      this.state.users.insert(user.username, { ...withoutCode, password: body.Password as string })
      return this.response({})
    }
    if (target === "AdminCreateUser") {
      if (typeof username !== "string")
        return this.error("InvalidParameterException", "Username is required")
      if (this.state.find(username))
        return this.error("UsernameExistsException", "User account already exists")
      const temporary =
        typeof body.TemporaryPassword === "string" ? body.TemporaryPassword : "Mockingbird1"
      const user = this.state.put({
        username,
        password: temporary,
        createdAt: this.now(),
        attributes: Array.isArray(body.UserAttributes)
          ? (body.UserAttributes as CognitoAttribute[])
          : [],
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
      this.state.put({
        ...user,
        password: body.Password as string,
        confirmed: body.Permanent === true,
        status: body.Permanent === true ? "CONFIRMED" : "FORCE_CHANGE_PASSWORD",
      })
      return this.response({})
    }
    if (target === "AdminGetUser") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      return this.response(publicUser(user))
    }
    if (target === "AdminUpdateUserAttributes") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      const incoming = Array.isArray(body.UserAttributes)
        ? (body.UserAttributes as CognitoAttribute[])
        : []
      const names = new Set(incoming.map((value) => value.Name))
      this.state.put({
        ...user,
        attributes: [...user.attributes.filter((value) => !names.has(value.Name)), ...incoming],
      })
      return this.response({})
    }
    if (target === "ListUsers") {
      const limit = typeof body.Limit === "number" ? Math.max(1, Math.min(60, body.Limit)) : 60
      const offset =
        typeof body.PaginationToken === "string"
          ? Number.parseInt(atob(body.PaginationToken), 10)
          : 0
      const users = this.state.users.list({ order: "oldest" }).map(({ value }) => value)
      const page = users.slice(offset, offset + limit).map(publicUser)
      return this.response({
        Users: page,
        ...(offset + limit < users.length ? { PaginationToken: btoa(String(offset + limit)) } : {}),
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
      this.state.put({ ...user, password: body.ProposedPassword as string })
      return this.response({})
    }
    if (["AdminAddUserToGroup", "AdminRemoveUserFromGroup"].includes(target)) {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      const group = typeof body.GroupName === "string" ? body.GroupName : ""
      const groups =
        target === "AdminAddUserToGroup"
          ? [...new Set([...user.groups, group])]
          : user.groups.filter((value) => value !== group)
      this.state.put({ ...user, groups })
      return this.response({})
    }
    if (target === "AdminLinkProviderForUser") {
      const destination = (body.DestinationUser ?? {}) as Record<string, unknown>
      const source = (body.SourceUser ?? {}) as Record<string, unknown>
      const user = this.requireUser(destination.ProviderAttributeValue)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      this.state.put({ ...user, identities: [...user.identities, source] })
      return this.response({})
    }
    if (target === "AdminUserGlobalSignOut") {
      const user = this.requireUser(username)
      if (!user) return this.error("UserNotFoundException", "User does not exist.")
      for (const row of this.state.sessions.list({
        where: (session) => session.username === user.username,
      }))
        this.state.sessions.update(row.id, { ...row.value, revoked: true })
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
