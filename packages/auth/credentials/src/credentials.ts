export type Env = Record<string, string | undefined>

/** One provider's credential contract: which secret fields it needs and their env vars. */
export type CredentialSpec<Field extends string> = {
  /** Lower-case provider slug, e.g. `stripe`. Used only in error messages. */
  provider: string
  /** Secret field name -> env var that supplies it. */
  fields: Record<Field, string>
}

export type LoadCredentialsOptions = {
  env: Env
}

export type LoadedCredentials<Field extends string> = {
  values: Record<Field, string>
  /** Every secret string worth scrubbing from logs. */
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
 * Load a provider's credentials from the environment (`.env.local` locally, or GitHub
 * Actions secrets exposed as env vars in a workflow step). Every failure names the
 * provider and the environment variables that can supply it, so a missing secret is
 * actionable at a glance.
 */
export const loadCredentials = async <Field extends string>(
  spec: CredentialSpec<Field>,
  options: LoadCredentialsOptions,
): Promise<LoadedCredentials<Field>> => {
  const fromEnv = credentialsFromEnv(spec, options.env)
  if (fromEnv === undefined) {
    const fields = Object.keys(spec.fields) as Field[]
    const envPairs = fields.map((field) => `${spec.fields[field]} (secret field "${field}")`)
    throw new CredentialError(
      `no credentials for ${spec.provider}: set ${envPairs.join(", ")} in the environment (e.g. .env.local)`,
    )
  }
  return { values: fromEnv, secrets: Object.values<string>(fromEnv) }
}
