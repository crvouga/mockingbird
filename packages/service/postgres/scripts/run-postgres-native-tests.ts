/**
 * Start a real PostgreSQL 18.3 (embedded-postgres) and run the differential
 * suite against it. Prefer an already-running server when
 * `POSTGRES_MEM_ORACLE_URL` is set (Docker Compose / CI service / local install).
 *
 * Usage: `bun run test:postgres-native`
 */
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { SUPPORTED_ORACLE_VERSIONS } from "../tests/harness/oracle-versions.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate an ephemeral port"));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

/** Strip build suffixes so "18.3 (Debian …)" → "18.3". */
function normalizeServerVersion(raw: string): string {
  const token = raw.trim().split(/\s+/u)[0] ?? raw.trim();
  const m = /^(\d+\.\d+)/u.exec(token);
  return m?.[1] ?? token;
}

async function assertOracleVersion(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ v: string }>("SELECT current_setting('server_version') AS v");
    const version = normalizeServerVersion(String(res.rows[0]?.v ?? ""));
    if (!(SUPPORTED_ORACLE_VERSIONS as readonly string[]).includes(version)) {
      throw new Error(
        `Native oracle server_version ${JSON.stringify(version)} is not in allow-list ` +
          `${JSON.stringify(SUPPORTED_ORACLE_VERSIONS)}. Pin PostgreSQL 18.3 (or 18.1).`,
      );
    }
    console.log(`native oracle server_version=${version}`);
  } finally {
    await client.end();
  }
}

function runTests(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["test", "--max-concurrency=1", "tests/contract", "tests/fuzz", "tests/harness"], {
      env,
      stdio: "inherit",
      cwd: join(import.meta.dir, ".."),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`tests killed by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const existingUrl = process.env.POSTGRES_MEM_ORACLE_URL?.trim();
  let embedded: EmbeddedPostgres | null = null;
  let databaseDir: string | null = null;
  let url = existingUrl ?? "";

  try {
    if (!existingUrl) {
      databaseDir = await mkdtemp(join(tmpdir(), "postgres-mem-oracle-"));
      const port = await freePort();
      const user = "postgres";
      const password = "postgres";
      embedded = new EmbeddedPostgres({
        databaseDir,
        user,
        password,
        port,
        persistent: false,
        // Match PGlite / postgres-mem: RESET timezone must restore UTC, not the host TZ.
        postgresFlags: ["-c", "timezone=UTC"],
        onLog: () => {
          // quiet: binaries are chatty on start
        },
        onError: (message) => {
          console.error("[embedded-postgres]", message);
        },
      });
      console.log(`starting embedded PostgreSQL 18.3 on 127.0.0.1:${port} …`);
      await embedded.initialise();
      await embedded.start();
      url = `postgres://${user}:${password}@127.0.0.1:${port}/postgres`;
    } else {
      console.log("using existing POSTGRES_MEM_ORACLE_URL");
    }

    await assertOracleVersion(url);

    const code = await runTests({
      ...process.env,
      POSTGRES_MEM_ORACLE: "server",
      POSTGRES_MEM_ORACLE_URL: url,
    });
    process.exitCode = code === 0 ? 0 : code || 1;
  } finally {
    if (embedded) {
      try {
        await embedded.stop();
      } catch (error) {
        console.error("failed to stop embedded postgres:", error);
      }
    }
    if (databaseDir) {
      await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Force a hard exit so a non-zero exitCode cannot be swallowed after async teardown.
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
