import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";
import { type PostgresServer, serve } from "../../src/wire/index.ts";
import {
  deriveScramCredentials,
  ScramCredentialStore,
  type ScramCredentials,
  ScramServer,
} from "../../src/wire/scram.ts";

// Issue #708: SCRAM verifiers are derived once per role (like pg_authid), and `auth: "trust"`
// skips the password exchange.

/** A SCRAM-SHA-256 client (node:crypto, independent of the server's pure implementation). */
const handshake = (server: ScramServer, password: string): string | null => {
  const clientNonce = randomBytes(18).toString("base64");
  const clientFirstBare = `n=*,r=${clientNonce}`;
  const serverFirst = server.first(`n,,${clientFirstBare}`);
  if (serverFirst === null) throw new Error("server rejected client-first");
  const fields = Object.fromEntries(serverFirst.split(",").map((part) => [part[0], part.slice(2)]));
  const salted = pbkdf2Sync(password, Buffer.from(fields.s!, "base64"), Number(fields.i), 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const withoutProof = `c=biws,r=${fields.r}`;
  const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
  const signature = createHmac("sha256", storedKey).update(authMessage).digest();
  const proof = Buffer.from(clientKey.map((byte, i) => byte ^ signature[i]!));
  const serverFinal = server.final(`${withoutProof},p=${proof.toString("base64")}`);
  if (serverFinal === null) return null;
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  expect(serverFinal).toBe(`v=${createHmac("sha256", serverKey).update(authMessage).digest("base64")}`);
  return serverFinal;
};

/** A store whose PBKDF2 step is counted. */
const countingStore = (): { store: ScramCredentialStore; derived: string[] } => {
  const derived: string[] = [];
  const store = new ScramCredentialStore((password, salt, iterations): ScramCredentials => {
    derived.push(password);
    return deriveScramCredentials(password, salt, iterations);
  });
  return { store, derived };
};

describe("ScramCredentialStore", () => {
  test("N handshakes for one role derive the verifier once and reuse its salt", () => {
    const { store, derived } = countingStore();
    const salts = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const server = new ScramServer("secret", "app", store);
      expect(handshake(server, "secret")).not.toBeNull();
      salts.add(store.credentials("app", "secret").salt.join(","));
    }
    expect(derived).toEqual(["secret"]);
    expect(salts.size).toBe(1);
  });

  test("each role gets its own salt and verifier", () => {
    const { store, derived } = countingStore();
    expect(handshake(new ScramServer("secret", "a", store), "secret")).not.toBeNull();
    expect(handshake(new ScramServer("secret", "b", store), "secret")).not.toBeNull();
    expect(handshake(new ScramServer("secret", "a", store), "secret")).not.toBeNull();
    expect(derived).toHaveLength(2);
    expect(store.credentials("a", "secret").salt).not.toEqual(store.credentials("b", "secret").salt);
  });

  test("a wrong password is rejected against the cached verifier", () => {
    const { store } = countingStore();
    expect(handshake(new ScramServer("secret", "app", store), "secret")).not.toBeNull();
    expect(handshake(new ScramServer("secret", "app", store), "wrong")).toBeNull();
  });

  test("a changed password derives a new verifier; the stale one is not reused", () => {
    const { store, derived } = countingStore();
    expect(handshake(new ScramServer("old", "app", store), "old")).not.toBeNull();
    const before = store.credentials("app", "old");
    expect(handshake(new ScramServer("new", "app", store), "old")).toBeNull();
    expect(handshake(new ScramServer("new", "app", store), "new")).not.toBeNull();
    const after = store.credentials("app", "new");
    expect(derived).toEqual(["old", "new"]);
    expect(after.storedKey).not.toEqual(before.storedKey);
    expect(after.salt).not.toEqual(before.salt);
  });

  test("without a store each ScramServer derives its own verifier (previous behaviour)", () => {
    expect(handshake(new ScramServer("secret"), "secret")).not.toBeNull();
    expect(handshake(new ScramServer("secret"), "nope")).toBeNull();
  });
});

describe("serve() authentication", () => {
  let server: PostgresServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const client = (password?: string): pg.Client =>
    new pg.Client({
      host: server!.host,
      port: server!.port,
      user: "postgres",
      database: "postgres",
      ...(password !== undefined ? { password } : {}),
    });

  test("many SCRAM connections for one role all authenticate", async () => {
    server = await serve({ port: 0, password: "secret" });
    const clients = Array.from({ length: 10 }, () => client("secret"));
    await Promise.all(clients.map((c) => c.connect()));
    const rows = await Promise.all(clients.map((c) => c.query("SELECT 1 AS ok")));
    expect(rows.map((r) => r.rows[0].ok)).toEqual(Array(10).fill(1));
    await Promise.all(clients.map((c) => c.end()));
  });

  test("a wrong password still fails with 28P01 after the verifier is cached", async () => {
    server = await serve({ port: 0, password: "secret" });
    const good = client("secret");
    await good.connect();
    await good.end();
    const bad = client("wrong");
    bad.on("error", () => undefined);
    await expect(bad.connect()).rejects.toMatchObject({ code: "28P01" });
  });

  test('auth: "trust" accepts any password or none, even with password set', async () => {
    server = await serve({ port: 0, password: "secret", auth: "trust" });
    for (const password of [undefined, "", "wrong", "secret"]) {
      const c = client(password);
      await c.connect();
      expect((await c.query("SELECT current_user AS u")).rows).toEqual([{ u: "postgres" }]);
      await c.end();
    }
  });

  test('auth: "scram-sha-256" without a password is a configuration error', async () => {
    await expect(serve({ port: 0, auth: "scram-sha-256" })).rejects.toThrow(/needs a password/);
  });
});
