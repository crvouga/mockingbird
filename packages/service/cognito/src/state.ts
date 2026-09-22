import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

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
  groups: string[]
  identities: Record<string, unknown>[]
  confirmationCode?: string
  resetCode?: string
}
export type CognitoSession = {
  username: string
  clientId: string
  expires: number
  revoked: boolean
  kind: "access" | "refresh" | "challenge"
}
export type CognitoSeedUser = Partial<CognitoUser> & { username: string; password: string }

export class CognitoState {
  readonly users: Collection<CognitoUser>
  readonly sessions: Collection<CognitoSession>
  private readonly ids: IdSequence
  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seeds: readonly CognitoSeedUser[],
  ) {
    this.users = new Collection(sqlite, namespace, "cognito_users")
    this.sessions = new Collection(sqlite, namespace, "cognito_sessions")
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
    const user: CognitoUser = {
      username: input.username,
      password: input.password,
      sub: input.sub ?? existing?.sub ?? this.ids.next("00000000-0000-4000-8000-", 12),
      attributes: input.attributes ?? existing?.attributes ?? [],
      confirmed: input.confirmed ?? existing?.confirmed ?? false,
      enabled: input.enabled ?? existing?.enabled ?? true,
      status: input.status ?? existing?.status ?? (input.confirmed ? "CONFIRMED" : "UNCONFIRMED"),
      createdAt: input.createdAt ?? existing?.createdAt ?? Date.now(),
      groups: input.groups ?? existing?.groups ?? [],
      identities: input.identities ?? existing?.identities ?? [],
      ...(confirmationCode !== undefined ? { confirmationCode } : {}),
      ...(resetCode !== undefined ? { resetCode } : {}),
    }
    this.users.insert(user.username, user)
    return user
  }
  find(name: string): CognitoUser | undefined {
    const direct = this.users.get(name)
    if (direct) return direct
    return this.users
      .list()
      .find(({ value }) =>
        value.attributes.some(
          (attribute) => attribute.Name === "email" && attribute.Value === name,
        ),
      )?.value
  }
  token(prefix: string): string {
    return this.ids.next(prefix, 32)
  }
}
