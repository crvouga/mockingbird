/**
 * `bun run mock:serve`: the env-configured way to run `mockingbird-junction serve`.
 *
 *   PORT, HOST                              listen address (default 127.0.0.1:8787)
 *   MOCKINGBIRD_JUNCTION_CORPUS             corpus file (default: the shipped corpus)
 *   MOCKINGBIRD_JUNCTION_WEBHOOK_URL        deliver signed webhooks here
 *   MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET     the receiver's whsec_… secret
 *   MOCKINGBIRD_JUNCTION_WEBHOOK_SCOPE      sent as x-mockingbird-scope
 *
 * Extra arguments pass through: `bun run mock:serve -- --geo synthetic --log json`.
 */
const env = process.env
const flags: [string, string | undefined][] = [
  ["--port", env.PORT],
  ["--host", env.HOST],
  ["--corpus", env.MOCKINGBIRD_JUNCTION_CORPUS],
  ["--webhook-url", env.MOCKINGBIRD_JUNCTION_WEBHOOK_URL],
  ["--webhook-scope", env.MOCKINGBIRD_JUNCTION_WEBHOOK_SCOPE],
]
const args = flags.flatMap(([flag, value]) => (value ? [flag, value] : []))
process.argv = [
  process.argv[0] ?? "bun",
  "mockingbird-junction",
  "serve",
  ...args,
  ...process.argv.slice(2),
]
await import("../src/cli.js")
