/**
 * Runtime configuration, from environment variables only (twelve-factor). The names for
 * PostgreSQL, the object store, Vault and sign-in are the ones the chrisvouga.dev cloud guide
 * documents (https://www.chrisvouga.dev/llms-cloud.txt); OpenTelemetry uses the standard
 * `OTEL_*` names because the guide does not define any.
 *
 * Every problem is reported as a {@link Problem}: what is wrong, why it matters, and the exact
 * variable to set, so a person or an agent reading the boot log can fix it without the source.
 */

/** One thing that stops the server from starting, with what to do about it. */
export type Problem = {
  /** Stable machine-readable code, e.g. `missing_env`. */
  code: string
  what: string
  why: string
  fix: string
  /** `NAME=example` lines to add or change. Examples are placeholders, never real secrets. */
  env: string[]
}

export class StartupError extends Error {
  constructor(readonly problems: Problem[]) {
    super(formatProblems(problems))
    this.name = "StartupError"
  }
}

/** Human- and agent-readable report: numbered problems, each with why, fix and env lines. */
export function formatProblems(problems: Problem[]): string {
  const lines = [
    "",
    `mockingbird-fleet cannot start: ${problems.length} problem${problems.length === 1 ? "" : "s"} to fix`,
    "",
  ]
  for (const [index, problem] of problems.entries()) {
    lines.push(`${index + 1}. ${problem.what}`)
    lines.push(`   why: ${problem.why}`)
    lines.push(`   fix: ${problem.fix}`)
    for (const line of problem.env) lines.push(`   set: ${line}`)
    lines.push("")
  }
  lines.push(
    "Variables are read from the process environment only (docker run -e NAME=value, or env_file).",
    "Re-check without starting the server:  bun dist/main.js check",
    "Full variable reference: sites/fleet/README.md#configuration, or GET /llms.txt on a running server.",
    "",
  )
  return lines.join("\n")
}

/** Quotas an organization lives under. `0` means unlimited. */
export type Limits = {
  projectsPerOrg: number
  fleetsPerOrg: number
  emulatorsPerFleet: number
  membersPerOrg: number
  apiKeysPerOrg: number
  /** Largest stored (compressed) state of one emulator, in bytes. */
  stateBytes: number
  /** Emulator requests an organization's fleets may serve per calendar month (UTC). */
  requestsPerMonth: number
  /** Ceiling on any one fleet's request rate. */
  fleetRequestsPerMinute: number
}

export const LIMIT_KEYS = [
  "projectsPerOrg",
  "fleetsPerOrg",
  "emulatorsPerFleet",
  "membersPerOrg",
  "apiKeysPerOrg",
  "stateBytes",
  "requestsPerMonth",
  "fleetRequestsPerMinute",
] as const satisfies readonly (keyof Limits)[]

export type Config = {
  port: number
  /** Origin of the dashboard and the control API, e.g. https://mockingbird-fleet.chrisvouga.dev */
  publicUrl: string
  /** Origin fleets are served from. Defaults to `publicUrl`; a separate hostname isolates them. */
  fleetUrl: string
  databaseUrl: string | undefined
  databaseSchema: string
  s3:
    | {
        endpoint: string
        region: string
        accessKeyId: string
        secretAccessKey: string
        bucket: string
      }
    | undefined
  /** Key prefix inside the shared bucket. Never write outside it. */
  s3Prefix: string
  oidc: { issuer: string; clientId: string; redirectUri: string; scopes: string } | undefined
  devLogin: boolean
  /** SHA-256 of the operator token; the token itself is not kept. */
  operatorTokenHash: string | undefined
  otel: { endpoint: string; headers: Record<string, string>; serviceName: string } | undefined
  /** Loaded emulators kept in memory at once, and how long an idle one stays loaded. */
  maxInstances: number
  instanceIdleMs: number
  /** Defaults for every organization; an operator can override them per organization. */
  limits: Limits
  orgsPerUser: number
  rateLimits: {
    /** Control-API requests per minute, per credential (or per client address when anonymous). */
    apiPerMinute: number
    /** Sign-in attempts and rejected credentials per minute, per client address. */
    authPerMinute: number
    /** Emulator requests per minute from one client address, across all fleets. */
    clientPerMinute: number
  }
  /** Requests one fleet may have in flight at once, and how long one may run. */
  fleetMaxConcurrent: number
  fleetRequestTimeoutMs: number
  /** Reverse proxies in front of the server whose `X-Forwarded-For` entry is trusted. */
  trustedProxyHops: number
  /** Browser origins allowed to call the API with an API key (never with cookies). */
  corsOrigins: string[]
}

type Env = Record<string, string | undefined>

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
const S3_NAMES = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",
] as const
const S3_EXAMPLE: Record<(typeof S3_NAMES)[number], string> = {
  S3_ENDPOINT:
    "https://<account-id>.r2.cloudflarestorage.com   (or https://s3.<region>.amazonaws.com, http://minio:9000)",
  S3_REGION: "auto   (R2 and MinIO: auto; AWS: the bucket's region, e.g. us-east-1)",
  S3_ACCESS_KEY_ID: "<access key id>",
  S3_SECRET_ACCESS_KEY: "<secret access key>",
  S3_BUCKET: "<an existing bucket name>",
}

/** Parse `key=value,key2=value2`, the OTLP header format. Values are percent-decoded. */
function headerList(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (value ?? "").split(",")) {
    const index = pair.indexOf("=")
    if (index > 0)
      out[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim())
  }
  return out
}

/**
 * Read the configuration. Throws one {@link StartupError} listing every missing or invalid
 * variable at once, so a failed boot is fixed in one pass, not one variable per restart.
 */
export function loadConfig(env: Env): Config {
  const problems: Problem[] = []
  const invalid = (name: string, rule: string, example: string) =>
    problems.push({
      code: "invalid_env",
      what: `${name} is invalid: ${rule}`,
      why: `The value given for ${name} cannot be used, and guessing a replacement could point the server at the wrong place.`,
      fix: `Correct ${name}, or remove it to use the default.`,
      env: [`${name}=${example}`],
    })

  const origin = (name: string, value: string, example: string): string => {
    try {
      const url = new URL(value)
      if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))
        return url.origin
    } catch {}
    invalid(name, "it must be an absolute https URL (http is allowed only for localhost)", example)
    return "http://localhost"
  }
  const integer = (name: string, fallback: number, min: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === "") return fallback
    const value = Number(raw)
    if (Number.isSafeInteger(value) && value >= min) return value
    invalid(name, `it must be a whole number of at least ${min}`, String(fallback))
    return fallback
  }

  const port = integer("PORT", 8080, 1)
  const publicUrl = origin(
    "PUBLIC_URL",
    env.PUBLIC_URL ?? `http://localhost:${port}`,
    "https://fleet.example.com",
  )
  const fleetUrl = origin("FLEET_URL", env.FLEET_URL ?? publicUrl, "https://fleets.example.com")
  const local = LOOPBACK.has(new URL(publicUrl).hostname)
  const loopbackOnly = `PUBLIC_URL is ${publicUrl}, which is not a loopback address, so this is treated as a real deployment`

  const databaseSchema = env.DATABASE_SCHEMA ?? "mockingbird_fleet"
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseSchema))
    invalid(
      "DATABASE_SCHEMA",
      "it must be a lowercase PostgreSQL identifier (letters, digits, underscores)",
      "mockingbird_fleet",
    )
  if (!env.DATABASE_URL && !local)
    problems.push({
      code: "missing_env",
      what: "DATABASE_URL is not set",
      why: `Accounts, organizations, fleets and API keys are stored in PostgreSQL. ${loopbackOnly}; the in-memory database exists for localhost development only.`,
      fix: "Point DATABASE_URL at any PostgreSQL 13+ database. The server creates and uses only the schema named by DATABASE_SCHEMA (default mockingbird_fleet).",
      env: ["DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>"],
    })

  const s3Missing = S3_NAMES.filter((name) => !env[name])
  let s3: Config["s3"]
  if (s3Missing.length === 0)
    s3 = {
      endpoint: env.S3_ENDPOINT as string,
      region: env.S3_REGION as string,
      accessKeyId: env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
      bucket: env.S3_BUCKET as string,
    }
  else if (s3Missing.length < S3_NAMES.length || !local)
    problems.push({
      code: "missing_env",
      what: `${s3Missing.join(", ")} ${s3Missing.length === 1 ? "is" : "are"} not set`,
      why:
        s3Missing.length < S3_NAMES.length
          ? "Some object-store variables are set and others are not. All five are needed together; a partial configuration is refused so state is never written somewhere unintended."
          : `Emulator state is stored in an S3-compatible object store. ${loopbackOnly}; the in-memory store exists for localhost development only.`,
      fix: "Set all five variables for any S3-compatible store that supports conditional writes (Cloudflare R2, AWS S3, MinIO). The bucket must already exist.",
      env: s3Missing.map((name) => `${name}=${S3_EXAMPLE[name]}`),
    })
  if (s3) {
    try {
      const endpoint = new URL(s3.endpoint)
      if (endpoint.username || endpoint.password) throw new Error("credentials")
    } catch {
      invalid(
        "S3_ENDPOINT",
        "it must be an absolute URL without embedded credentials",
        "https://<account-id>.r2.cloudflarestorage.com",
      )
    }
  }

  const s3Prefix = `${(env.S3_PREFIX ?? "mockingbird-fleet").replace(/^\/+|\/+$/g, "")}/`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\/$/.test(s3Prefix))
    invalid(
      "S3_PREFIX",
      "it must be a non-empty key prefix made of letters, digits, dots, dashes and slashes, with no `..`",
      "mockingbird-fleet",
    )

  let oidc: Config["oidc"]
  if (env.OIDC_ISSUER || env.OIDC_CLIENT_ID) {
    if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID)
      problems.push({
        code: "missing_env",
        what: `${env.OIDC_ISSUER ? "OIDC_CLIENT_ID" : "OIDC_ISSUER"} is not set, but ${env.OIDC_ISSUER ? "OIDC_ISSUER" : "OIDC_CLIENT_ID"} is`,
        why: "OpenID Connect sign-in needs both the provider's issuer URL and this app's client id.",
        fix: "Set both, or remove both to turn OpenID Connect sign-in off.",
        env: [
          "OIDC_ISSUER=https://<your-identity-provider>/<realm>",
          "OIDC_CLIENT_ID=<public client id registered with redirect URI <PUBLIC_URL>/auth/callback>",
        ],
      })
    else
      oidc = {
        issuer: env.OIDC_ISSUER,
        clientId: env.OIDC_CLIENT_ID,
        redirectUri: env.OIDC_REDIRECT_URI ?? `${publicUrl}/auth/callback`,
        scopes: env.OIDC_SCOPES ?? "openid email profile",
      }
  }

  const devLogin = env.AUTH_DEV_LOGIN === "1"
  if (devLogin && !local)
    problems.push({
      code: "unsafe_env",
      what: "AUTH_DEV_LOGIN=1 is set on a non-loopback PUBLIC_URL",
      why: `Dev login lets anyone sign in as any email address with no password. ${loopbackOnly}.`,
      fix: "Remove AUTH_DEV_LOGIN, and use OPERATOR_TOKEN or OIDC_ISSUER + OIDC_CLIENT_ID for sign-in.",
      env: ["AUTH_DEV_LOGIN=   (unset it)"],
    })

  let operatorTokenHash: string | undefined
  if (env.OPERATOR_TOKEN) {
    if (env.OPERATOR_TOKEN.length < 32)
      invalid(
        "OPERATOR_TOKEN",
        "it must be at least 32 characters, because it grants full control of every organization",
        "<output of: openssl rand -hex 32>",
      )
    else operatorTokenHash = new Bun.CryptoHasher("sha256").update(env.OPERATOR_TOKEN).digest("hex")
  }

  if (
    !oidc &&
    !devLogin &&
    !env.OPERATOR_TOKEN &&
    problems.every((p) => !p.what.startsWith("OIDC_"))
  )
    problems.push({
      code: "missing_env",
      what: "No way to sign in is configured",
      why: "Without one nobody could ever create an account, so the server refuses to start in a state that looks healthy but is unusable.",
      fix: "Pick one. Simplest for self-hosting: set OPERATOR_TOKEN, then create your first user with `POST /api/v1/admin/users` (it returns a personal token to sign in with). For single sign-on: set OIDC_ISSUER and OIDC_CLIENT_ID for any OpenID Connect provider (public client, PKCE).",
      env: [
        "OPERATOR_TOKEN=<output of: openssl rand -hex 32>",
        "OIDC_ISSUER=https://<your-identity-provider>/<realm>   (alternative, together with OIDC_CLIENT_ID)",
      ],
    })

  const corsOrigins = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  for (const value of corsOrigins) {
    let valid = false
    try {
      valid = new URL(value).origin === value
    } catch {}
    if (!valid)
      invalid(
        "CORS_ORIGINS",
        `"${value}" is not an origin (scheme and host only, no path, no wildcard)`,
        "https://app.example.com,https://admin.example.com",
      )
  }

  const config: Config = {
    port,
    publicUrl,
    fleetUrl,
    databaseUrl: env.DATABASE_URL,
    databaseSchema,
    s3,
    s3Prefix,
    oidc,
    devLogin,
    operatorTokenHash,
    otel: env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? {
          endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, ""),
          headers: headerList(env.OTEL_EXPORTER_OTLP_HEADERS),
          serviceName: env.OTEL_SERVICE_NAME ?? "mockingbird-fleet",
        }
      : undefined,
    maxInstances: integer("FLEET_MAX_INSTANCES", 64, 1),
    instanceIdleMs: integer("FLEET_INSTANCE_IDLE_MS", 600_000, 1000),
    limits: {
      projectsPerOrg: integer("LIMIT_PROJECTS_PER_ORG", 20, 0),
      fleetsPerOrg: integer("LIMIT_FLEETS_PER_ORG", 50, 0),
      emulatorsPerFleet: integer("LIMIT_EMULATORS_PER_FLEET", 50, 0),
      membersPerOrg: integer("LIMIT_MEMBERS_PER_ORG", 50, 0),
      apiKeysPerOrg: integer("LIMIT_API_KEYS_PER_ORG", 50, 0),
      stateBytes: integer("LIMIT_STATE_BYTES", 16 * 1024 * 1024, 0),
      requestsPerMonth: integer("LIMIT_REQUESTS_PER_MONTH", 1_000_000, 0),
      fleetRequestsPerMinute: integer("LIMIT_FLEET_REQUESTS_PER_MINUTE", 3000, 0),
    },
    orgsPerUser: integer("LIMIT_ORGS_PER_USER", 5, 0),
    rateLimits: {
      apiPerMinute: integer("RATE_LIMIT_API_PER_MINUTE", 600, 0),
      authPerMinute: integer("RATE_LIMIT_AUTH_PER_MINUTE", 20, 0),
      clientPerMinute: integer("RATE_LIMIT_CLIENT_PER_MINUTE", 1200, 0),
    },
    fleetMaxConcurrent: integer("FLEET_MAX_CONCURRENT_REQUESTS", 64, 1),
    fleetRequestTimeoutMs: integer("FLEET_REQUEST_TIMEOUT_MS", 30_000, 100),
    trustedProxyHops: integer("TRUSTED_PROXY_HOPS", 0, 0),
    corsOrigins,
  }
  if (problems.length > 0) throw new StartupError(problems)
  return config
}

/**
 * The documented Vault runtime contract: when `VAULT_ADDR` and `VAULT_TOKEN` are set, read the
 * KV v2 document `secret/<VAULT_PROJECT>/<VAULT_CONFIG>` once at boot and use its fields for any
 * variable the environment does not already set. Hosted deployments inject the same keys as env
 * vars, so they skip this. A sealed Vault (503) or a rate limit (429) is retried with backoff.
 */
export async function withVaultSecrets(
  env: Env,
  io: { fetch: typeof fetch; sleep(ms: number): Promise<void> } = {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<Env> {
  if (!env.VAULT_ADDR && !env.VAULT_TOKEN) return env
  const project = env.VAULT_PROJECT ?? "personal"
  const config = env.VAULT_CONFIG ?? "prd"
  const path = `secret/${project}/${config}`
  const failure = (what: string, why: string, fix: string) =>
    new StartupError([
      {
        code: "vault_unavailable",
        what,
        why,
        fix,
        env: [
          "VAULT_ADDR=https://<vault-host>",
          "VAULT_TOKEN=<read token for the path above>",
          "(or remove both and set DATABASE_URL, S3_* and the rest directly)",
        ],
      },
    ])
  if (!env.VAULT_ADDR || !env.VAULT_TOKEN)
    throw failure(
      `${env.VAULT_ADDR ? "VAULT_TOKEN" : "VAULT_ADDR"} is not set, but ${env.VAULT_ADDR ? "VAULT_ADDR" : "VAULT_TOKEN"} is`,
      "Reading secrets from Vault needs both the address and a token.",
      "Set both, or remove both to read every variable from the environment.",
    )
  const url = `${env.VAULT_ADDR.replace(/\/+$/, "")}/v1/secret/data/${encodeURIComponent(project)}/${encodeURIComponent(config)}`
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await io.fetch(url, {
        headers: { "X-Vault-Token": env.VAULT_TOKEN },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw failure(
        `Vault at ${env.VAULT_ADDR} could not be reached (${(error as Error).message})`,
        `Secrets were to be read from ${path}.`,
        "Check VAULT_ADDR and that this container can reach it.",
      )
    }
    if (response.ok) {
      const body = (await response.json()) as { data?: { data?: Record<string, unknown> } }
      const secrets: Env = {}
      for (const [key, value] of Object.entries(body.data?.data ?? {}))
        if (typeof value === "string") secrets[key] = value
      return { ...secrets, ...env }
    }
    await response.body?.cancel()
    if (![429, 503].includes(response.status) || attempt >= 5)
      throw failure(
        `Vault read of ${path} failed with HTTP ${response.status}`,
        response.status === 403
          ? "The token is expired or its policy does not allow reading this path."
          : response.status === 404
            ? "Nothing is stored at this path."
            : response.status === 503
              ? "Vault is sealed or restarting and did not recover after six attempts."
              : "Vault refused the request.",
        "Check VAULT_TOKEN, VAULT_PROJECT (default personal) and VAULT_CONFIG (default prd).",
      )
    const retryAfter = Number(response.headers.get("retry-after"))
    await io.sleep(retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt)
  }
}
