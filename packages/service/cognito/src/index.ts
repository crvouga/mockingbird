import { type APIOptions, bootSqlite, sigV4AccessKeyId } from "@crvouga/mockingbird-service"
import { clearNamespace } from "@crvouga/mockingbird-sqlite"
import { CognitoSigner } from "./crypto.js"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
import {
  type CognitoAttribute,
  type CognitoSeedUser,
  CognitoState,
  type CognitoUser,
} from "./state.js"

export type { CognitoRuntime, CognitoRuntimeOptions } from "./runtime.js"
export { COGNITO_PRESETS, createRuntime } from "./runtime.js"
export type { CognitoAttribute, CognitoSeedUser, CognitoUser } from "./state.js"
export { document, operationIds, supportedOperationIds }
export const COGNITO_NAMESPACE = "cognito"
export const accessKeyCredential = sigV4AccessKeyId

export type CognitoAPIOptions = APIOptions & {
  poolId?: string
  clientId?: string
  region?: string
  users?: readonly CognitoSeedUser[]
}
const headers = (requestId: string) => ({
  "content-type": "application/x-amz-json-1.1",
  "x-amzn-requestid": requestId,
  "cache-control": "no-store",
})
const attr = (user: CognitoUser, name: string) =>
  user.attributes.find((value) => value.Name === name)?.Value
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
  private signer = new CognitoSigner()
  private previous: CognitoSigner[] = []
  private readonly sqlite
  private readonly namespace: string
  private readonly now: () => number
  private readonly poolId: string
  private readonly defaultClientId: string
  constructor(options: CognitoAPIOptions = {}) {
    this.sqlite = bootSqlite(options.sqlite)
    this.namespace = options.namespace ?? COGNITO_NAMESPACE
    this.now = options.now ?? Date.now
    this.poolId = options.poolId ?? "us-east-1_mockingbird"
    this.defaultClientId = options.clientId ?? "mockingbird-client"
    this.state = new CognitoState(this.sqlite, this.namespace, options.users ?? [])
  }
  async reset() {
    clearNamespace(this.sqlite, this.namespace)
    this.state.seed()
  }
  rotateSigningKey(retainPrevious = true) {
    this.previous = retainPrevious ? [this.signer, ...this.previous].slice(0, 2) : []
    this.signer = new CognitoSigner(`cognito-${this.now()}`)
    return { kid: this.signer.kid }
  }
  private issuer(request: Request, poolId = this.poolId) {
    return `${new URL(request.url).origin}/${encodeURIComponent(poolId)}`
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
  ) {
    const now = Math.floor(this.now() / 1000)
    const issuer = this.issuer(request)
    const common = {
      iss: issuer,
      sub: user.sub,
      auth_time: now,
      iat: now,
      exp: now + 3600,
      username: user.username,
      email: attr(user, "email"),
      email_verified: attr(user, "email_verified") === "true",
      ...(user.groups.length ? { "cognito:groups": user.groups } : {}),
      ...(user.identities.length ? { identities: user.identities } : {}),
    }
    const access = await this.signer.sign({
      ...common,
      client_id: clientId,
      token_use: "access",
      scope: "aws.cognito.signin.user.admin",
    })
    const id = await this.signer.sign({ ...common, aud: clientId, token_use: "id" })
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
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      })
    }
    const jwks = /^\/([^/]+)\/\.well-known\/jwks\.json$/.exec(url.pathname)
    if (request.method === "GET" && jwks)
      return Response.json({
        keys: (
          await Promise.all([this.signer, ...this.previous].map((signer) => signer.jwks()))
        ).flatMap((set) => set.keys),
      })
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
        CodeDeliveryDetails: {
          Destination: attr(user, "email") ?? username,
          DeliveryMedium: "EMAIL",
          AttributeName: "email",
        },
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
      this.state.put({ ...user, confirmationCode: "123456" })
      return this.response({
        CodeDeliveryDetails: {
          Destination: attr(user, "email") ?? user.username,
          DeliveryMedium: "EMAIL",
          AttributeName: "email",
        },
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
          session.revoked ||
          session.expires <= this.now() ||
          !user
        )
          return this.error("NotAuthorizedException", "Invalid Refresh Token")
        return this.response({
          AuthenticationResult: await this.tokens(request, user, session.clientId, false),
        })
      }
      const user = this.requireUser(parameters.USERNAME)
      if (!user || user.password !== parameters.PASSWORD || !user.enabled)
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
      this.state.put({ ...user, resetCode: "654321" })
      return this.response({
        CodeDeliveryDetails: {
          Destination: attr(user, "email") ?? user.username,
          DeliveryMedium: "EMAIL",
          AttributeName: "email",
        },
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
  private userForAccess(value: unknown) {
    const session = typeof value === "string" ? this.state.sessions.get(value) : undefined
    return session?.kind === "access" && !session.revoked && session.expires > this.now()
      ? this.state.find(session.username)
      : undefined
  }
}
