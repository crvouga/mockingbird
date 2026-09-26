#!/usr/bin/env node
/**
 * `mockingbird-postgres serve --port <n>`: start the wire-protocol server (see ./index.ts).
 *
 *   mockingbird-postgres serve                 # a free port on 127.0.0.1, printed as a URL
 *   mockingbird-postgres serve --port 55432 --host 0.0.0.0 --password secret --log
 *
 * The connection string it prints works with `pg`, `postgres.js`, JDBC and `psql`.
 */
import { type ServeOptions, serve } from "./index.ts";

const usage = `mockingbird-postgres serve [--port <n>] [--host <h>] [--password <p>] [--server-version <v>] [--log]`;

const args = process.argv.slice(2);
if (args[0] !== "serve") {
  console.error(usage);
  process.exit(args[0] === "--help" || args[0] === "-h" ? 0 : 2);
}

const options: ServeOptions = {};
let log = false;
for (let i = 1; i < args.length; i++) {
  const flag = args[i];
  const value = args[i + 1];
  const need = (): string => {
    if (value === undefined) {
      console.error(`${flag} requires a value`);
      process.exit(2);
    }
    i++;
    return value;
  };
  switch (flag) {
    case "--port":
      options.port = Number(need());
      break;
    case "--host":
      options.host = need();
      break;
    case "--password":
      options.password = need();
      break;
    case "--server-version":
      options.serverVersion = need();
      break;
    case "--log":
      log = true;
      break;
    default:
      console.error(`unknown option ${flag}\n${usage}`);
      process.exit(2);
  }
}

if (log) {
  options.onLog = (entry) =>
    console.error(
      `[pid ${entry.pid}] ${entry.status} ${entry.durationMs.toFixed(1)}ms  ${entry.sql.replace(/\s+/g, " ").slice(0, 200)}`,
    );
}

const server = await serve(options);
const auth = options.password ? `postgres:${options.password}@` : "postgres@";
console.log(`mockingbird-postgres listening on postgres://${auth}${server.host}:${server.port}/postgres`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
