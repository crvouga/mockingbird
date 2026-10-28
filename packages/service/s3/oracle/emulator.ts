/** Boot the emulator exactly as the oracle harness drives it: over real HTTP, strict SigV4 auth. */
import { createServer } from "../src/server.js"
import type { Target } from "./client.js"

export const ORACLE_CREDENTIALS = { accessKey: "mockingbird", secretKey: "mockingbird-secret" }
export const ORACLE_REGION = "us-east-1"

export const startEmulator = async () => {
  const server = await createServer({
    credentials: { [ORACLE_CREDENTIALS.accessKey]: ORACLE_CREDENTIALS.secretKey },
    authentication: "strict",
    region: ORACLE_REGION,
    virtualHosts: [],
  })
  const target: Target = { endpoint: server.url, region: ORACLE_REGION, ...ORACLE_CREDENTIALS }
  return { target, close: () => server.close() }
}

/** MinIO, from the environment (`.env.local` or CI), defaulting to a local `minio server`. */
export const oracleTarget = (env: Record<string, string | undefined> = process.env): Target => ({
  endpoint: env.S3_ORACLE_ENDPOINT ?? "http://127.0.0.1:9000",
  accessKey: env.S3_ORACLE_ACCESS_KEY ?? ORACLE_CREDENTIALS.accessKey,
  secretKey: env.S3_ORACLE_SECRET_KEY ?? ORACLE_CREDENTIALS.secretKey,
  region: env.S3_ORACLE_REGION ?? ORACLE_REGION,
})
