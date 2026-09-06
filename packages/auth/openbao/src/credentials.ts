import { type FetchLike, OpenBaoClient, OpenBaoError } from "./client.js"

export const DEFAULT_OPENBAO_ADDRESS = "https://vault.chrisvouga.dev"
export const DEFAULT_JWT_MOUNT = "jwt"
export const DEFAULT_JWT_ROLE = "mockingbird-parity"

export type Env = Record<string, string | undefined>

/** One provider's credential contract: which secret fields it needs and their env overrides. */
export type CredentialSpec<Field extends string> = {
  /** Lower-case provider slug, e.g. `stripe`. Drives env var and secret path defaults. */
  provider: string
  /** Secret field name -> env var that may supply it directly (skipping OpenBao). */
  fields: Record<Field, string>
  /** Default KV v2 API path when `MOCKINGBIRD_OPENBAO_PATH_<PROVIDER>` is unset. */
  defaultPath?: string
}

export type LoadCredentialsOptions = {
  env: Env
  fetch?: FetchLike
  /** Reads `~/.vault-token` (or equivalent) when no token env var is set. Injected: no fs here. */
  readTokenFile?: () => Promise<string | undefined>
}

export type LoadedCredentials<Field extends string> = {
  values: Record<Field, string>
  /** `env` when every field came from the environment, otherwise `openbao`. */
  source: "env" | "openbao"
  /** Every secret string worth scrubbing from logs, including any OpenBao token that was used. */
  secrets: readonly string[]
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialError"
  }
}

const first = (env: Env, names: readonly string[]) => {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value.trim() !== "") return value.trim()
  }
  return undefined
}

const envPathName = (provider: string) =>
  `MOCKINGBIRD_OPENBAO_PATH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`

/** Resolve every field from env vars alone, or `undefined` if any is missing. */
export const credentialsFromEnv = <Field extends string>(
  spec: CredentialSpec<Field>,
  env: Env,
): Record<Field, string> | undefined => {
  const out: Partial<Record<Field, string>> = {}
  for (const field of Object.keys(spec.fields) as Field[]) {
    const value = first(env, [spec.fields[field]])
    if (value === undefined) return undefined
    out[field] = value
  }
  return out as Record<Field, string>
}

/**
 * Load a provider's credentials. Order:
 *   1. every field present in the environment (`MOCKINGBIRD_<PROVIDER>_*`);
 *   2. OpenBao at `MOCKINGBIRD_OPENBAO_ADDR` / `BAO_ADDR` / `VAULT_ADDR` (default
 *      {@link DEFAULT_OPENBAO_ADDRESS}) authenticated by, in order, an explicit token
 *      (`MOCKINGBIRD_OPENBAO_TOKEN` / `BAO_TOKEN` / `VAULT_TOKEN`), a JWT
 *      (`MOCKINGBIRD_OPENBAO_JWT`, exchanged via `MOCKINGBIRD_OPENBAO_JWT_ROLE` at
 *      `MOCKINGBIRD_OPENBAO_JWT_MOUNT`), or the token file the caller injects.
 * `MOCKINGBIRD_CREDENTIALS=env|openbao` forces one source.
 *
 * Every failure names the provider, the expected secret fields, the environment variables
 * that can supply them, and the exact OpenBao endpoint and secret path it read (or would
 * read), so a missing secret is actionable at a glance.
 */
export const loadCredentials = async <Field extends string>(
  spec: CredentialSpec<Field>,
  options: LoadCredentialsOptions,
): Promise<LoadedCredentials<Field>> => {
  const { env } = options
  const mode = first(env, ["MOCKINGBIRD_CREDENTIALS"]) ?? "auto"
  if (mode !== "auto" && mode !== "env" && mode !== "openbao")
    throw new CredentialError(`MOCKINGBIRD_CREDENTIALS must be env, openbao, or auto; got ${mode}`)

  const fields = Object.keys(spec.fields) as Field[]
  const envPairs = fields.map((field) => `${spec.fields[field]} (secret field "${field}")`)
  const secretFields = fields.map((field) => `"${field}"`).join(", ")
  const envVars = fields.map((field) => spec.fields[field]).join(", ")

  if (mode !== "openbao") {
    const fromEnv = credentialsFromEnv(spec, env)
    if (fromEnv) return { values: fromEnv, source: "env", secrets: Object.values<string>(fromEnv) }
    if (mode === "env")
      throw new CredentialError(
        `MOCKINGBIRD_CREDENTIALS=env but not all credentials are set in the environment; set ${envPairs.join(", ")}`,
      )
  }
  const address =
    first(env, ["MOCKINGBIRD_OPENBAO_ADDR", "BAO_ADDR", "VAULT_ADDR"]) ?? DEFAULT_OPENBAO_ADDRESS
  const client = new OpenBaoClient({ address, ...(options.fetch ? { fetch: options.fetch } : {}) })
  const path = first(env, [envPathName(spec.provider)]) ?? spec.defaultPath ?? `secret/data/secret`
  const url = `${address}/v1/${path}`
  let token = first(env, ["MOCKINGBIRD_OPENBAO_TOKEN", "BAO_TOKEN", "VAULT_TOKEN"])
  let revoke = false
  if (token === undefined) {
    const jwt = first(env, ["MOCKINGBIRD_OPENBAO_JWT"])
    if (jwt !== undefined) {
      const login = await client.loginWithJwt({
        jwt,
        role: first(env, ["MOCKINGBIRD_OPENBAO_JWT_ROLE"]) ?? DEFAULT_JWT_ROLE,
        mount: first(env, ["MOCKINGBIRD_OPENBAO_JWT_MOUNT"]) ?? DEFAULT_JWT_MOUNT,
      })
      token = login.token
      revoke = true
    }
  }
  if (token === undefined && options.readTokenFile) {
    const fromFile = await options.readTokenFile()
    if (fromFile !== undefined && fromFile.trim() !== "") token = fromFile.trim()
  }
  if (token === undefined)
    throw new CredentialError(
      `no credentials for ${spec.provider}: set ${envPairs.join(", ")} or store ${secretFields} at ${url} (path via ${envPathName(spec.provider)}, auth via bao login / MOCKINGBIRD_OPENBAO_TOKEN / MOCKINGBIRD_OPENBAO_JWT)`,
    )

  try {
    const data = await client.readKv2(token, path)
    const out: Partial<Record<Field, string>> = {}
    for (const field of fields) {
      const value = data[field]
      if (value === undefined || value === "")
        throw new CredentialError(
          `OpenBao secret at ${url} (provider "${spec.provider}") is missing field "${field}"; add it there or set ${spec.fields[field]} in the environment`,
        )
      out[field] = value
    }
    const values = out as Record<Field, string>
    return { values, source: "openbao", secrets: [...Object.values<string>(values), token] }
  } catch (error) {
    if (error instanceof OpenBaoError)
      error.message = `${error.message}; reading ${spec.provider} credentials from ${url} failed, the secret should contain ${secretFields} or set ${envVars} in the environment`
    throw error
  } finally {
    if (revoke) await client.revokeSelf(token)
  }
}
