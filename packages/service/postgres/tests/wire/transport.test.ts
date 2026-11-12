import { afterEach, describe, expect, test } from "bun:test";
import { Duplex, duplexPair } from "node:stream";
import { build } from "esbuild";
import pg from "pg";
import { Database } from "../../src/index.ts";
import { createWireServer, type WireServer } from "../../src/wire/transport.ts";

// Real node-postgres over in-memory byte streams: no port, no node:net. The server side gets web
// streams (the browser / worker shape); pg gets a Duplex through its documented `stream` option.

/** A client Duplex over a pair of web streams, with the socket methods pg calls. */
class MemorySocket extends Duplex {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>) {
    super();
    this.writer = writable.getWriter();
    void (async () => {
      const reader = readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.push(Buffer.from(value));
      }
      this.push(null);
    })().catch((error) => this.destroy(error));
  }

  connect(): this {
    queueMicrotask(() => this.emit("connect"));
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.writer.write(new Uint8Array(chunk)).then(() => done(), done);
  }
  override _final(done: (error?: Error | null) => void): void {
    this.writer.close().then(() => done(), done);
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.writer.abort().catch(() => undefined);
    done(error);
  }
}

let server: WireServer;
const accepted: Promise<void>[] = [];

/** Connect a pg client to `server` through one in-memory connection. */
const connect = async (options: pg.ClientConfig = {}): Promise<{ client: pg.Client; closed: Promise<void> }> => {
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const closed = server.accept({ readable: toServer.readable, writable: toClient.writable });
  accepted.push(closed);
  const client = new pg.Client({
    user: "postgres",
    database: "postgres",
    ...options,
    stream: () => new MemorySocket(toClient.readable, toServer.writable) as never,
  });
  // A test that closes the server first sees the client report the hang-up; that is expected.
  client.on("error", () => undefined);
  await client.connect();
  return { client, closed };
};

afterEach(async () => {
  await server?.close();
  await Promise.all(accepted.splice(0));
});

describe("createWireServer over injected web streams", () => {
  test("pg authenticates with SCRAM-SHA-256 and runs simple and extended queries", async () => {
    server = await createWireServer({ password: "secret", database: new Database({ now: "system" }) });
    const { client } = await connect({ user: "postgres", password: "secret", database: "postgres" });
    await client.query("CREATE TABLE notes (id int PRIMARY KEY, body text)");
    await client.query("INSERT INTO notes VALUES ($1, $2)", [1, "hello"]);
    const result = await client.query("SELECT body FROM notes WHERE id = $1", [1]);
    expect(result.rows).toEqual([{ body: "hello" }]);
    expect(server.connections).toBe(1);
    await client.end();
  });

  test("a wrong password fails SCRAM with 28P01", async () => {
    server = await createWireServer({ password: "secret" });
    const toServer = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    accepted.push(server.accept({ readable: toServer.readable, writable: toClient.writable }));
    const client = new pg.Client({
      user: "postgres",
      database: "postgres",
      password: "wrong",
      stream: () => new MemorySocket(toClient.readable, toServer.writable) as never,
    });
    await expect(client.connect()).rejects.toMatchObject({ code: "28P01" });
  });

  test("two streams take turns: read-committed visibility and LISTEN/NOTIFY", async () => {
    server = await createWireServer();
    const a = await connect();
    const b = await connect();
    await a.client.query("CREATE TABLE t (n int)");
    const notified = new Promise<pg.Notification>((resolve) => b.client.once("notification", resolve));
    await b.client.query("LISTEN events");
    await a.client.query("BEGIN");
    await a.client.query("INSERT INTO t VALUES (1)");
    const count = "SELECT count(*)::int AS n FROM t";
    expect((await b.client.query(count)).rows).toEqual([{ n: 0 }]);
    await a.client.query("NOTIFY events, 'inserted'");
    await a.client.query("COMMIT");
    expect((await b.client.query(count)).rows).toEqual([{ n: 1 }]);
    expect((await notified).payload).toBe("inserted");
    await a.client.end();
    await b.client.end();
  });

  test("closing a stream disposes the session: rollback, locks released, accept() resolves", async () => {
    server = await createWireServer();
    const a = await connect();
    const b = await connect();
    await a.client.query("CREATE TABLE t (n int)");
    await a.client.query("BEGIN");
    await a.client.query("INSERT INTO t VALUES (1)");
    await a.client.query("SELECT pg_advisory_lock(7)");
    (a.client as unknown as { connection: { stream: Duplex } }).connection.stream.destroy();
    await a.closed;
    expect(server.connections).toBe(1);
    const lock = await b.client.query("SELECT pg_try_advisory_lock(7) AS ok");
    expect(lock.rows).toEqual([{ ok: true }]);
    const rows = await b.client.query("SELECT count(*)::int AS n FROM t");
    expect(rows.rows).toEqual([{ n: 0 }]);
    await b.client.end();
  });

  test("close() ends every accepted connection", async () => {
    server = await createWireServer();
    const a = await connect();
    a.client.on("error", () => undefined);
    await server.close();
    await a.closed;
    expect(server.connections).toBe(0);
  });
});

describe("createWireServer over a Node Duplex", () => {
  test("accept() takes a Duplex as net.createServer hands one over", async () => {
    server = await createWireServer();
    const [serverSide, clientSide] = duplexPair();
    accepted.push(server.accept(serverSide));
    const socket = Object.assign(clientSide, {
      connect() {
        queueMicrotask(() => clientSide.emit("connect"));
        return clientSide;
      },
      setNoDelay: () => clientSide,
      setKeepAlive: () => clientSide,
    });
    const client = new pg.Client({ user: "postgres", database: "postgres", stream: () => socket as never });
    await client.connect();
    expect((await client.query("SELECT 41 + 1 AS n")).rows).toEqual([{ n: 42 }]);
    await client.end();
  });
});

describe("createWireServer options", () => {
  test("a directory path for durable storage is refused: the file store lives in /wire", async () => {
    await expect(createWireServer({ durable: { storage: "/tmp/x" } })).rejects.toThrow(/DurableStorage/);
  });
});

describe("the /transport entry", () => {
  test("bundles for the browser: no node: built-in is reached", async () => {
    const result = await build({
      entryPoints: [new URL("../../src/wire/transport.ts", import.meta.url).pathname],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
      metafile: true,
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.filter((path) => path.startsWith("node:"))).toEqual([]);
    expect(result.outputFiles[0]?.text).not.toMatch(/\bBuffer\.|["']node:/);
  });
});
