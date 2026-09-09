export type ServerConfigInput = {
  apiPort: number
  dbPort: number
  redisPort: number
  dataDir: string
  superAdminEmail?: string | undefined
  superAdminPassword?: string | undefined
}

export type MedplumDatabaseConfig = {
  host: string
  port: number
  dbname: string
  username: string
  password: string
}

export type MedplumRedisConfig = {
  host: string
  port: number
}

export type MedplumServerConfig = {
  port: number
  baseUrl: string
  appBaseUrl: string
  binaryStorage: string
  storageBaseUrl: string
  supportEmail: string
  emailProvider: "none"
  botLambdaRoleArn: ""
  botLambdaLayerName: string
  vmContextBotsEnabled: true
  defaultBotRuntimeVersion: "vmcontext"
  allowedOrigins: "*"
  introspectionEnabled: true
  rateLimitsEnabled: false
  database: MedplumDatabaseConfig
  redis: MedplumRedisConfig
  shutdownTimeoutMilliseconds: number
  defaultSuperAdminEmail?: string | undefined
  defaultSuperAdminPassword?: string | undefined
  defaultSuperAdminClientId?: string | undefined
  defaultSuperAdminClientSecret?: string | undefined
  superAdminSecurity: { blockAdmin: false }
}

export const SUPER_ADMIN_EMAIL = "admin@example.com"
export const SUPER_ADMIN_PASSWORD = "medplum_admin"
export const SUPER_ADMIN_CLIENT_ID = "6f3f0c17-8bd1-4a56-9d5a-6b21e5b0a101"
export const SUPER_ADMIN_CLIENT_SECRET = "mockingbird-local-secret"
const SHUTDOWN_TIMEOUT_MILLISECONDS = 5000
const HOST = "127.0.0.1"

export const buildServerConfig = (input: ServerConfigInput): MedplumServerConfig => {
  const { apiPort, dbPort, redisPort, dataDir } = input
  const config: MedplumServerConfig = {
    port: apiPort,
    baseUrl: `http://${HOST}:${apiPort}/`,
    appBaseUrl: `http://${HOST}:3000/`,
    binaryStorage: `file:${dataDir}/binary/`,
    storageBaseUrl: `http://${HOST}:${apiPort}/storage/`,
    supportEmail: "Medplum Mock <no-reply@example.com>",
    emailProvider: "none",
    botLambdaRoleArn: "",
    botLambdaLayerName: "medplum-bot-layer",
    vmContextBotsEnabled: true,
    defaultBotRuntimeVersion: "vmcontext",
    allowedOrigins: "*",
    introspectionEnabled: true,
    rateLimitsEnabled: false,
    database: {
      host: HOST,
      port: dbPort,
      dbname: "medplum",
      username: "postgres",
      password: "postgres",
    },
    redis: {
      host: HOST,
      port: redisPort,
    },
    shutdownTimeoutMilliseconds: SHUTDOWN_TIMEOUT_MILLISECONDS,
    defaultSuperAdminEmail: input.superAdminEmail ?? SUPER_ADMIN_EMAIL,
    defaultSuperAdminPassword: input.superAdminPassword ?? SUPER_ADMIN_PASSWORD,
    defaultSuperAdminClientId: SUPER_ADMIN_CLIENT_ID,
    defaultSuperAdminClientSecret: SUPER_ADMIN_CLIENT_SECRET,
    superAdminSecurity: {
      blockAdmin: false,
    },
  }
  return config
}
