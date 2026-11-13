import { randomBytes } from "node:crypto"
import type { Config, Problem } from "./config.js"
import { type ObjectStore, ObjectStoreError } from "./objects.js"
import type { Database } from "./store/schema.js"

/**
 * Checks run once at boot, before the server reports ready. Each proves a dependency actually
 * works with the given credentials and, when it does not, says which variable to change. A
 * dependency that is merely slow later does not crash the server; a misconfiguration never
 * lets it start looking healthy.
 */

const text = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Connect, then create or upgrade the schema. */
export async function checkDatabase(
  db: Database,
  config: Pick<Config, "databaseSchema">,
): Promise<Problem | undefined> {
  const env = ["DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>"]
  try {
    await db.ping()
  } catch (error) {
    const message = text(error)
    const info = error as { code?: string; errno?: string }
    const code = `${info.code ?? ""} ${info.errno ?? ""} ${message}`
    // Codes observed from the driver: 28P01 bad password, 3D000 unknown database,
    // ERR_POSTGRES_CONNECTION_REFUSED for a closed port and for a hostname that does not resolve,
    // ERR_POSTGRES_TLS_NOT_AVAILABLE when sslmode asks for TLS the server does not offer.
    const [what, fix] = /28P01|28000|password authentication/i.test(code)
      ? [
          "PostgreSQL rejected the username or password in DATABASE_URL",
          "Correct the user and password in DATABASE_URL. Special characters in a password must be percent-encoded (@ → %40, : → %3A, / → %2F).",
        ]
      : /3D000|database .* does not exist/i.test(code)
        ? [
            "The database named in DATABASE_URL does not exist",
            "Create the database (createdb <name>), or fix the name at the end of DATABASE_URL.",
          ]
        : /TLS|SSL|certificate/i.test(code)
          ? [
              "The TLS handshake with PostgreSQL failed",
              "Match the server's TLS setting in DATABASE_URL: append ?sslmode=require for a managed database, or ?sslmode=disable for a local one without TLS.",
            ]
          : /CONNECTION_REFUSED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|CONNECTION_CLOSED|timed? ?out|ETIMEDOUT/i.test(
                code,
              )
            ? [
                "PostgreSQL did not accept a connection at the host and port in DATABASE_URL",
                "Check that the hostname resolves, the port is right, PostgreSQL is running, and this container can reach it. Inside Docker, `localhost` is the container itself: use the database's service name (e.g. postgres) or host.docker.internal.",
              ]
            : [
                "PostgreSQL could not be reached with DATABASE_URL",
                "Check DATABASE_URL: it must be a postgres:// URL this container can connect to.",
              ]
    return {
      code: "database_unreachable",
      what,
      why: `The server stores accounts, organizations, fleets and API keys in PostgreSQL and cannot run without it. The driver reported: ${message}`,
      fix,
      env,
    }
  }
  try {
    await db.migrate()
  } catch (error) {
    const message = text(error)
    const denied = /42501|permission denied/i.test(
      `${(error as { errno?: string }).errno} ${message}`,
    )
    return {
      code: "database_migration_failed",
      what: denied
        ? `The database user may not create or change tables in schema "${config.databaseSchema}"`
        : `Creating the tables in schema "${config.databaseSchema}" failed`,
      why: `The server keeps all of its tables in one schema and creates them itself at boot. PostgreSQL reported: ${message}`,
      fix: denied
        ? `Grant the user in DATABASE_URL rights on the schema: CREATE SCHEMA IF NOT EXISTS ${config.databaseSchema} AUTHORIZATION <user>;  (or set DATABASE_SCHEMA to a schema that user owns).`
        : "Check that the user in DATABASE_URL can create tables, and that no other application uses this schema. To start clean on a database you own: DROP SCHEMA <schema> CASCADE.",
      env: ["DATABASE_SCHEMA=mockingbird_fleet", ...env],
    }
  }
  return undefined
}

/**
 * Write, read back, overwrite conditionally and delete one probe object under the configured
 * prefix. Proves the credentials, the bucket, and that the store honours conditional writes,
 * which `strict` durability and multi-replica safety both depend on. Only this probe's own object
 * is removed: replicas starting together probe concurrently, and deleting another replica's probe
 * would let its conditional overwrite succeed and fail its startup.
 */
export async function checkObjectStore(
  objects: ObjectStore,
  config: Pick<Config, "s3" | "s3Prefix">,
): Promise<Problem | undefined> {
  if (!config.s3) return undefined
  const { s3 } = config
  const key = `preflight/${randomBytes(8).toString("hex")}.txt`
  const problem = (code: string, what: string, fix: string, env: string[], detail?: string) => ({
    code,
    what,
    why: `Emulator state is stored at ${s3.endpoint}, bucket "${s3.bucket}", under "${config.s3Prefix}". A write and read of a probe object there did not work${detail ? `: ${detail}` : ""}.`,
    fix,
    env,
  })
  try {
    const created = await objects.put(key, new TextEncoder().encode("probe"), null)
    if (created === undefined)
      return problem(
        "object_store_unexpected",
        "The object store reported a brand-new probe object as already existing",
        "Check that S3_ENDPOINT points at an S3-compatible API and not a web page, proxy or CDN.",
        ["S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com"],
      )
    const second = await objects.put(key, new TextEncoder().encode("overwrite"), null)
    if (second !== undefined) {
      await objects.deletePrefix(key)
      return problem(
        "object_store_no_conditional_writes",
        "The object store ignores conditional writes (If-None-Match / If-Match on PutObject)",
        "Use a store that implements conditional PutObject: Cloudflare R2, AWS S3, or MinIO from 2024 onward. Without it two replicas can silently overwrite each other's state, so the server will not start.",
        ["S3_ENDPOINT=<endpoint of a store with conditional writes>"],
      )
    }
    const read = await objects.get(key)
    await objects.deletePrefix(key)
    if (read.status !== "found")
      return problem(
        "object_store_unexpected",
        "An object just written to the object store could not be read back",
        "Check that S3_ENDPOINT is a single consistent S3 endpoint, not a load balancer over unrelated stores.",
        ["S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com"],
      )
  } catch (error) {
    if (error instanceof ObjectStoreError) {
      const detail = error.message
      if (error.s3Code === "NoSuchBucket" || (error.status === 404 && error.operation !== "GET"))
        return problem(
          "object_store_no_bucket",
          `Bucket "${s3.bucket}" does not exist at ${s3.endpoint}`,
          "Create the bucket, or set S3_BUCKET to one that exists. The server never creates buckets.",
          ["S3_BUCKET=<an existing bucket name>"],
          detail,
        )
      if (error.s3Code === "SignatureDoesNotMatch")
        return problem(
          "object_store_bad_signature",
          "The object store rejected the request signature",
          "S3_SECRET_ACCESS_KEY does not match S3_ACCESS_KEY_ID, or S3_REGION is wrong (Cloudflare R2 and MinIO: auto or us-east-1; AWS: the bucket's own region). Also confirm S3_ENDPOINT has no bucket name or path in it.",
          ["S3_SECRET_ACCESS_KEY=<secret access key>", "S3_REGION=auto"],
          detail,
        )
      if ([401, 403].includes(error.status))
        return problem(
          "object_store_denied",
          `The object store denied ${error.operation} on bucket "${s3.bucket}"`,
          `Check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, and that the key may read, write, list and delete objects under "${config.s3Prefix}" in this bucket.`,
          ["S3_ACCESS_KEY_ID=<access key id>", "S3_SECRET_ACCESS_KEY=<secret access key>"],
          detail,
        )
      return problem(
        "object_store_error",
        `The object store answered ${error.operation} with HTTP ${error.status}`,
        "Check that S3_ENDPOINT is the S3 API endpoint of your store (not its web console), with no bucket name in the URL.",
        ["S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com"],
        detail,
      )
    }
    return problem(
      "object_store_unreachable",
      `The object store at ${s3.endpoint} could not be reached`,
      "Check S3_ENDPOINT and that this container can reach it. Inside Docker, `localhost` is the container itself: use the store's service name (e.g. http://minio:9000) or host.docker.internal.",
      ["S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com"],
      text(error),
    )
  }
  return undefined
}

/** Run every check, collecting all problems so one restart fixes them all. */
export async function preflight(
  db: Database,
  objects: ObjectStore,
  config: Pick<Config, "databaseSchema" | "s3" | "s3Prefix">,
): Promise<Problem[]> {
  const found = await Promise.all([checkDatabase(db, config), checkObjectStore(objects, config)])
  return found.filter((problem): problem is Problem => problem !== undefined)
}
