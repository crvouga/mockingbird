import type { Socket } from "node:net";
import type { BindValue } from "../api/bind.ts";
import type { TextResultSet } from "../api/statement.ts";
import { PostgresError } from "../errors/error.ts";
import { typeOid } from "../types/value.ts";
import { type Cluster, LockWait, type Session } from "./cluster.ts";
import {
  type ByteReader,
  backend,
  type ErrorFields,
  type FieldDescription,
  FrameParser,
  type FrontendMessage,
  PROTOCOL_3_0,
  ProtocolError,
  utf8,
} from "./protocol.ts";
import { ScramServer } from "./scram.ts";
import { splitStatements } from "./split.ts";

/** One statement's outcome, before it is written to the wire. */
type Outcome = { empty: true } | { empty: false; result: TextResultSet; tag: string };

type Prepared = { name: string; sql: string; paramOids: number[] };
type Portal = {
  name: string;
  prepared: Prepared;
  params: BindValue[];
  resultFormats: number[];
  /** Set once executed (by Describe or Execute); rows are handed out from `cursor`. */
  outcome?: Outcome;
  cursor: number;
};

export type ServerFaults = {
  /** Destroy the socket of the next connection that runs a statement inside a transaction block. */
  dropConnection?: boolean;
  /** Hold the next statement this long before it runs. */
  delayStatementMs?: number;
  /** Fail the next COMMIT with this SQLSTATE (`40001` serialization failure) after rolling back. */
  failCommit?: string;
};

export type ServerLog = {
  pid: number;
  sql: string;
  durationMs: number;
  /** `ok`, or the SQLSTATE of the error. */
  status: string;
};

export type ConnectionOptions = {
  password?: string;
  serverVersion: string;
  parameters: Record<string, string>;
  faults: ServerFaults;
  onLog?: (entry: ServerLog) => void;
};

const TX_CONTROL = /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release)\b/i;
const COMMIT = /^(commit|end)\b/i;
const LISTEN = /^listen\s+("?)([A-Za-z_][\w$]*)\1\s*$/i;
const UNLISTEN = /^unlisten\s+(\*|"?[A-Za-z_][\w$]*"?)\s*$/i;
const NOTIFY = /^notify\s+("?)([A-Za-z_][\w$]*)\1\s*(?:,\s*'((?:[^']|'')*)')?\s*$/i;
const RETURNS_ROWS = /^(select|with|values|show|table|explain)\b/i;

const TYPLEN: Record<string, number> = {
  bool: 1,
  int2: 2,
  int4: 4,
  int8: 8,
  oid: 4,
  float4: 4,
  float8: 8,
  date: 4,
  time: 8,
  timestamp: 8,
  timestamptz: 8,
  uuid: 16,
};

const TEXT_TYPES = new Set(["text", "varchar", "bpchar", "name", "json", "xml", "unknown"]);
const PG_EPOCH_MS = 946_684_800_000;

const pgError = (category: "internal" | "syntax", message: string, code: string) =>
  new PostgresError(category, message, code);

/** ErrorResponse fields for an engine error, with what the message names (constraint, table, column). */
const errorFields = (error: unknown): ErrorFields => {
  if (error instanceof PostgresError) {
    const message = error.message;
    const fields: ErrorFields = { code: error.sqlState, message };
    const constraint = /constraint "([^"]+)"/.exec(message)?.[1];
    const table = /(?:relation|table) "([^"]+)"/.exec(message)?.[1];
    const column = /column "([^"]+)"/.exec(message)?.[1];
    if (constraint) fields.constraint = constraint;
    if (table) fields.table = table;
    if (column) fields.column = column;
    return fields;
  }
  if (error instanceof ProtocolError) return { code: "08P01", message: error.message, severity: "FATAL" };
  return { code: "XX000", message: error instanceof Error ? error.message : String(error) };
};

const commandTag = (result: TextResultSet): string => {
  const command = result.command;
  if (command === "INSERT") return `INSERT 0 ${result.rowCount}`;
  if (["SELECT", "UPDATE", "DELETE", "MOVE", "FETCH", "COPY", "MERGE"].includes(command))
    return `${command} ${result.rowCount}`;
  return command;
};

/** Binary result encoding for the types clients ask for in binary; null when only text is offered. */
const binaryValue = (type: string, text: string): Uint8Array | null => {
  const dv = (n: number) => {
    const b = new Uint8Array(n);
    return { b, v: new DataView(b.buffer) };
  };
  switch (type) {
    case "bool":
      return new Uint8Array([text === "t" ? 1 : 0]);
    case "int2": {
      const { b, v } = dv(2);
      v.setInt16(0, Number(text));
      return b;
    }
    case "int4":
    case "oid": {
      const { b, v } = dv(4);
      v.setInt32(0, Number(text));
      return b;
    }
    case "int8": {
      const { b, v } = dv(8);
      v.setBigInt64(0, BigInt(text));
      return b;
    }
    case "float4": {
      const { b, v } = dv(4);
      v.setFloat32(0, Number(text));
      return b;
    }
    case "float8": {
      const { b, v } = dv(8);
      v.setFloat64(0, Number(text));
      return b;
    }
    case "bytea": {
      const hex = text.startsWith("\\x") ? text.slice(2) : null;
      if (hex === null || hex.length % 2 !== 0) return null;
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    case "uuid": {
      const hex = text.replaceAll("-", "");
      if (hex.length !== 32) return null;
      const out = new Uint8Array(16);
      for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    default:
      return TEXT_TYPES.has(type) ? utf8.encode(text) : null;
  }
};

const binaryEncodable = (type: string): boolean =>
  TEXT_TYPES.has(type) || ["bool", "int2", "int4", "oid", "int8", "float4", "float8", "bytea", "uuid"].includes(type);

/** A bound parameter as the engine takes it: text binds as an untyped literal, binary by its OID. */
const decodeParam = (oid: number, format: number, bytes: Uint8Array | null): BindValue => {
  if (bytes === null) return null;
  if (format === 0) return utf8.decode(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (oid) {
    case 16:
      return bytes[0] !== 0;
    case 21:
      return view.getInt16(0);
    case 23:
    case 26:
      return view.getInt32(0);
    case 20:
      return view.getBigInt64(0);
    case 700:
      return view.getFloat32(0);
    case 701:
      return view.getFloat64(0);
    case 17:
      return new Uint8Array(bytes);
    case 2950: {
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    case 1114:
    case 1184:
      return new Date(Number(view.getBigInt64(0) / 1000n) + PG_EPOCH_MS);
    case 1082: {
      const date = new Date(PG_EPOCH_MS + view.getInt32(0) * 86_400_000);
      return date.toISOString().slice(0, 10);
    }
    case 0:
    case 19:
    case 25:
    case 114:
    case 1042:
    case 1043:
    case 3802:
      return utf8.decode(bytes);
    default:
      throw pgError("internal", `binary parameter format is not supported for type oid ${oid}`, "0A000");
  }
};

/**
 * One client connection: the protocol state machine over the shared {@link Cluster}.
 * Statements run one at a time per connection; between connections the cluster decides.
 */
export class Connection implements Session {
  readonly pid: number;
  readonly secret: number;
  waitingForTurn: Session["waitingForTurn"] = null;
  waitingForLock: string | null = null;
  pendingNotifies: { channel: string; payload: string }[] = [];

  private readonly frames = new FrameParser();
  private readonly inbox: FrontendMessage[] = [];
  private pumping = false;
  private started = false;
  private scram: ScramServer | null = null;
  private user = "postgres";
  /** After an error inside a transaction block: `25P02` until ROLLBACK (`E` in ReadyForQuery). */
  private aborted = false;
  /** A query is in flight (a CancelRequest applies to it). */
  private busy = false;
  private cancelled = false;
  /** Extended protocol: an error was sent, so messages are ignored until Sync. */
  private skipUntilSync = false;
  private readonly prepared = new Map<string, Prepared>();
  private readonly portals = new Map<string, Portal>();
  private readonly notifications: Uint8Array[] = [];
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly cluster: Cluster,
    private readonly options: ConnectionOptions,
  ) {
    this.pid = cluster.newPid();
    this.secret = Math.floor(Math.random() * 0x7fffffff);
    cluster.sessions.set(this.pid, this);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.dispose());
    socket.on("error", () => this.dispose());
  }

  private receive(chunk: Buffer): void {
    let messages: FrontendMessage[];
    try {
      messages = this.frames.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (error) {
      this.write(backend.errorResponse(errorFields(error)));
      this.socket.end();
      return;
    }
    this.inbox.push(...messages);
    if (!this.pumping) void this.pump();
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.inbox.length > 0 && !this.closed) {
        const next = this.inbox.shift() as FrontendMessage;
        await this.handle(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private write(bytes: Uint8Array): void {
    if (!this.closed) this.socket.write(bytes);
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cluster.drop(this);
  }

  /** Terminate from the server side (close, or the drop-connection fault). */
  destroy(): void {
    this.socket.destroy();
    this.dispose();
  }

  queueNotification(pid: number, channel: string, payload: string): void {
    this.notifications.push(backend.notificationResponse(pid, channel, payload));
    if (!this.busy) this.flushNotifications();
  }

  private flushNotifications(): void {
    for (const bytes of this.notifications.splice(0)) this.write(bytes);
  }

  /** A CancelRequest with this connection's key: the query in flight fails with `57014`. */
  cancel(): void {
    if (!this.busy) return;
    this.cancelled = true;
    const error = pgError("internal", "canceling statement due to user request", "57014");
    if (this.waitingForTurn) this.waitingForTurn.reject(error);
    if (this.lockWaiter) this.lockWaiter(error);
  }

  private lockWaiter: ((error: Error) => void) | null = null;

  // --- startup ------------------------------------------------------------------------------

  private async handle(message: FrontendMessage): Promise<void> {
    if (message.kind === "ssl" || message.kind === "gssenc") {
      this.write(backend.no());
      return;
    }
    if (message.kind === "cancel") {
      const target = this.cluster.sessions.get(message.pid) as Connection | undefined;
      if (target && target.secret === message.key) target.cancel();
      this.socket.end();
      return;
    }
    if (message.kind === "startup") {
      this.startup(message.protocol, message.parameters);
      return;
    }
    if (!this.started) {
      if (message.type === "p") {
        this.authenticate(message.body);
        return;
      }
      this.fatal("08P01", "expected startup or password message");
      return;
    }
    if (this.skipUntilSync && message.type !== "S" && message.type !== "X") return;
    try {
      switch (message.type) {
        case "Q":
          await this.query(message.body.cstring());
          return;
        case "P":
          await this.parse(message.body);
          return;
        case "B":
          this.bind(message.body);
          return;
        case "D":
          await this.describe(message.body);
          return;
        case "E":
          await this.executePortal(message.body);
          return;
        case "C":
          this.close(message.body);
          return;
        case "H":
          return;
        case "S":
          this.sync();
          return;
        case "X":
          this.socket.end();
          this.dispose();
          return;
        default:
          this.fatal("08P01", `unsupported frontend message type ${JSON.stringify(message.type)}`);
      }
    } catch (error) {
      this.write(backend.errorResponse(errorFields(error)));
      this.skipUntilSync = true;
    }
  }

  private fatal(code: string, message: string): void {
    this.write(backend.errorResponse({ severity: "FATAL", code, message }));
    this.socket.end();
    this.dispose();
  }

  private startup(protocol: number, parameters: Record<string, string>): void {
    if (protocol >> 16 !== PROTOCOL_3_0 >> 16) {
      this.fatal("0A000", `unsupported frontend protocol ${protocol >> 16}.${protocol & 0xffff}: server supports 3.0`);
      return;
    }
    this.user = parameters.user ?? "postgres";
    if (this.options.password !== undefined) {
      this.scram = new ScramServer(this.options.password);
      this.write(backend.authenticationSASL(["SCRAM-SHA-256"]));
      return;
    }
    this.ready(parameters);
  }

  private authenticate(body: ByteReader): void {
    if (!this.scram) {
      this.fatal("08P01", "unexpected password message");
      return;
    }
    if (!this.scramStarted) {
      const mechanism = body.cstring();
      const length = body.i32();
      const clientFirst = utf8.decode(body.take(length));
      const serverFirst = mechanism === "SCRAM-SHA-256" ? this.scram.first(clientFirst) : null;
      if (serverFirst === null) {
        this.fatal("28000", `SASL authentication with ${mechanism} is not supported or malformed`);
        return;
      }
      this.scramStarted = true;
      this.write(backend.authenticationSASLContinue(serverFirst));
      return;
    }
    const serverFinal = this.scram.final(utf8.decode(body.rest()));
    if (serverFinal === null) {
      this.fatal("28P01", `password authentication failed for user "${this.user}"`);
      return;
    }
    this.write(backend.authenticationSASLFinal(serverFinal));
    this.ready(this.startupParameters);
  }

  private scramStarted = false;
  private startupParameters: Record<string, string> = {};

  private ready(parameters: Record<string, string>): void {
    this.startupParameters = parameters;
    if (this.scram && !this.scramStarted) return;
    this.started = true;
    this.write(backend.authenticationOk());
    const status: Record<string, string> = {
      server_version: this.options.serverVersion,
      server_encoding: "UTF8",
      client_encoding: "UTF8",
      application_name: parameters.application_name ?? "",
      DateStyle: "ISO, MDY",
      IntervalStyle: "postgres",
      TimeZone: "UTC",
      integer_datetimes: "on",
      standard_conforming_strings: "on",
      is_superuser: "on",
      session_authorization: this.user,
      default_transaction_read_only: "off",
      in_hot_standby: "off",
      scram_iterations: "4096",
      ...this.options.parameters,
    };
    for (const [name, value] of Object.entries(status)) this.write(backend.parameterStatus(name, value));
    this.write(backend.backendKeyData(this.pid, this.secret));
    this.write(backend.readyForQuery("I"));
  }

  // --- execution ----------------------------------------------------------------------------

  private get inTransaction(): boolean {
    return this.cluster.turnHolder === this && this.cluster.db.transactions.inTransaction;
  }

  private status(): "I" | "T" | "E" {
    if (this.aborted) return "E";
    return this.inTransaction ? "T" : "I";
  }

  private readyForQuery(): void {
    this.busy = false;
    this.cancelled = false;
    this.write(backend.readyForQuery(this.status()));
    this.flushNotifications();
  }

  /** Run one statement against the engine, honoring the turn, locks, aborted state and faults. */
  private async execute(sql: string, params: BindValue[] = []): Promise<Outcome> {
    const text = sql.trim();
    if (text === "") return { empty: true };
    const started = performance.now();
    try {
      const outcome = await this.executeInner(text, params);
      this.options.onLog?.({ pid: this.pid, sql: text, durationMs: performance.now() - started, status: "ok" });
      return outcome;
    } catch (error) {
      if (this.inTransaction) this.aborted = true;
      const status = error instanceof PostgresError ? error.sqlState : "XX000";
      this.options.onLog?.({ pid: this.pid, sql: text, durationMs: performance.now() - started, status });
      throw error;
    }
  }

  private async executeInner(text: string, params: BindValue[]): Promise<Outcome> {
    const control = TX_CONTROL.test(text);
    if (this.aborted && !control) {
      throw pgError(
        "internal",
        "current transaction is aborted, commands ignored until end of transaction block",
        "25P02",
      );
    }
    const listen = LISTEN.exec(text);
    if (listen) return this.listen(listen[2] as string);
    const unlisten = UNLISTEN.exec(text);
    if (unlisten) return this.unlisten((unlisten[1] as string).replaceAll('"', ""));
    const notify = NOTIFY.exec(text);
    if (notify) {
      this.pendingNotifies.push({ channel: notify[2] as string, payload: (notify[3] ?? "").replaceAll("''", "'") });
      if (!this.inTransaction) this.flushNotifies();
      return command("NOTIFY");
    }
    const db = this.cluster.db;
    for (;;) {
      if (this.cancelled) throw pgError("internal", "canceling statement due to user request", "57014");
      await this.cluster.acquireTurn(this);
      const faults = this.options.faults;
      if (faults.delayStatementMs !== undefined) {
        const ms = faults.delayStatementMs;
        faults.delayStatementMs = undefined;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      if (faults.dropConnection && db.transactions.inTransaction) {
        faults.dropConnection = undefined;
        this.destroy();
        throw new ConnectionDropped();
      }
      try {
        const outcome = this.runStatement(text, params, control);
        this.afterStatement();
        return outcome;
      } catch (error) {
        if (error instanceof LockWait) {
          const key = error.key;
          if (!db.transactions.inTransaction) this.cluster.releaseTurn(this);
          await this.waitForLock(key);
          continue;
        }
        this.afterStatement();
        throw error;
      }
    }
  }

  private waitForLock(key: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.lockWaiter = (error) => {
        this.lockWaiter = null;
        this.waitingForLock = null;
        reject(error);
      };
      this.cluster.waitLock(this, key).then(
        () => {
          this.lockWaiter = null;
          resolve();
        },
        (error: Error) => {
          this.lockWaiter = null;
          reject(error);
        },
      );
    });
  }

  /** The engine call itself: statement-atomic, and transaction control handled as the server sees it. */
  private runStatement(text: string, params: BindValue[], control: boolean): Outcome {
    const db = this.cluster.db;
    const tx = db.transactions;
    const faults = this.options.faults;
    if (control && COMMIT.test(text)) {
      if (this.aborted) {
        tx.rollback();
        this.aborted = false;
        return command("ROLLBACK");
      }
      if (faults.failCommit !== undefined) {
        const code = faults.failCommit;
        faults.failCommit = undefined;
        tx.rollback();
        throw pgError("internal", "could not serialize access due to concurrent update", code);
      }
    }
    if (control && this.aborted && /^(rollback|abort)\b/i.test(text) && !/\bto\b/i.test(text)) {
      tx.rollback();
      this.aborted = false;
      return command("ROLLBACK");
    }
    const run = () => {
      const result = this.cluster.as(this, () => db.prepare(text).textResult(...params));
      return { empty: false as const, result, tag: commandTag(result) };
    };
    if (control) return run();
    if (tx.inTransaction) {
      const name = `__wire_${this.pid}`;
      tx.savepoint(name);
      try {
        const outcome = run();
        tx.releaseSavepoint(name);
        return outcome;
      } catch (error) {
        tx.rollbackToSavepoint(name);
        tx.releaseSavepoint(name);
        throw error;
      }
    }
    return db.transaction(run);
  }

  /** Release the turn and transaction-scoped locks once no block is open; deliver NOTIFYs at commit. */
  private afterStatement(): void {
    if (this.cluster.db.transactions.inTransaction) return;
    this.cluster.unlockAll(this, true);
    this.cluster.releaseTurn(this);
    this.flushNotifies();
  }

  private flushNotifies(): void {
    for (const { channel, payload } of this.pendingNotifies.splice(0)) this.cluster.notify(this, channel, payload);
  }

  private listen(channel: string): Outcome {
    const set = this.cluster.listeners.get(channel) ?? new Set<Session>();
    set.add(this);
    this.cluster.listeners.set(channel, set);
    return command("LISTEN");
  }

  private unlisten(channel: string): Outcome {
    if (channel === "*") for (const set of this.cluster.listeners.values()) set.delete(this);
    else this.cluster.listeners.get(channel)?.delete(this);
    return command("UNLISTEN");
  }

  // --- simple query -------------------------------------------------------------------------

  private async query(script: string): Promise<void> {
    this.busy = true;
    const statements = splitStatements(script);
    if (statements.length === 0) {
      this.write(backend.emptyQueryResponse());
      this.readyForQuery();
      return;
    }
    // Several statements in one message run as one implicit transaction block, unless the
    // script manages transactions itself or one is already open.
    const implicit = statements.length > 1 && !this.inTransaction && !statements.some((s) => TX_CONTROL.test(s));
    let failed = false;
    try {
      if (implicit) await this.execute("BEGIN");
      for (const statement of statements) {
        const outcome = await this.execute(statement);
        this.sendOutcome(outcome, [], { rowDescription: true });
      }
      if (implicit) await this.execute("COMMIT");
    } catch (error) {
      if (error instanceof ConnectionDropped) return;
      failed = true;
      this.write(backend.errorResponse(errorFields(error)));
      if (implicit && this.inTransaction) {
        await this.execute("ROLLBACK").catch(() => undefined);
      }
    }
    if (failed && this.inTransaction) this.aborted = true;
    this.readyForQuery();
  }

  private sendOutcome(
    outcome: Outcome,
    resultFormats: number[],
    opts: { rowDescription: boolean; from?: number; limit?: number } = { rowDescription: false },
  ): "done" | "suspended" {
    const from = opts.from ?? 0;
    const limit = opts.limit ?? 0;
    if (outcome.empty) {
      this.write(backend.emptyQueryResponse());
      return "done";
    }
    const { result } = outcome;
    if (from === 0 && result.columns.length > 0 && opts.rowDescription) {
      this.write(backend.rowDescription(this.fields(result, resultFormats)));
    }
    const formats = this.columnFormats(result, resultFormats);
    const end = limit > 0 ? Math.min(result.rows.length, from + limit) : result.rows.length;
    for (let i = from; i < end; i++) {
      const row = result.rows[i] as (string | null)[];
      this.write(
        backend.dataRow(
          row.map((value, c) => {
            if (value === null) return null;
            const type = result.columnTypes[c] as string;
            return formats[c] === 1 ? (binaryValue(type, value) ?? utf8.encode(value)) : utf8.encode(value);
          }),
        ),
      );
    }
    if (limit > 0 && end < result.rows.length) {
      this.write(backend.portalSuspended());
      return "suspended";
    }
    this.write(backend.commandComplete(outcome.tag));
    return "done";
  }

  private columnFormats(result: TextResultSet, requested: number[]): (0 | 1)[] {
    return result.columnTypes.map((type, i) => {
      const want = requested.length === 0 ? 0 : requested.length === 1 ? requested[0] : requested[i];
      return want === 1 && binaryEncodable(type) ? 1 : 0;
    });
  }

  private fields(result: TextResultSet, requested: number[]): FieldDescription[] {
    const formats = this.columnFormats(result, requested);
    return result.columns.map((name, i) => {
      const type = result.columnTypes[i] as string;
      return { name, typeOid: typeOid(type), typeLen: TYPLEN[type] ?? -1, format: formats[i] as 0 | 1 };
    });
  }

  // --- extended query -----------------------------------------------------------------------

  private async parse(body: ByteReader): Promise<void> {
    const name = body.cstring();
    const sql = body.cstring();
    const count = body.i16();
    const paramOids: number[] = [];
    for (let i = 0; i < count; i++) paramOids.push(body.i32());
    const text = sql.trim();
    if (text !== "" && !LISTEN.test(text) && !UNLISTEN.test(text) && !NOTIFY.test(text) && !TX_CONTROL.test(text)) {
      // Syntax is checked now (a parse error belongs to Parse), the statement runs at Execute.
      this.cluster.db.prepare(text);
    }
    if (name !== "" && this.prepared.has(name)) {
      throw pgError("internal", `prepared statement "${name}" already exists`, "42P05");
    }
    this.prepared.set(name, { name, sql: text, paramOids });
    this.write(backend.parseComplete());
  }

  private bind(body: ByteReader): void {
    const portalName = body.cstring();
    const statementName = body.cstring();
    const prepared = this.prepared.get(statementName);
    if (!prepared) throw pgError("internal", `prepared statement "${statementName}" does not exist`, "26000");
    const formatCount = body.i16();
    const paramFormats: number[] = [];
    for (let i = 0; i < formatCount; i++) paramFormats.push(body.i16());
    const paramCount = body.i16();
    const params: BindValue[] = [];
    for (let i = 0; i < paramCount; i++) {
      const length = body.i32();
      const bytes = length === -1 ? null : body.take(length);
      const format = paramFormats.length === 0 ? 0 : paramFormats.length === 1 ? paramFormats[0] : paramFormats[i];
      params.push(decodeParam(prepared.paramOids[i] ?? 0, format ?? 0, bytes));
    }
    const resultCount = body.i16();
    const resultFormats: number[] = [];
    for (let i = 0; i < resultCount; i++) resultFormats.push(body.i16());
    if (portalName !== "" && this.portals.has(portalName)) {
      throw pgError("internal", `portal "${portalName}" already exists`, "42P03");
    }
    this.portals.set(portalName, { name: portalName, prepared, params, resultFormats, cursor: 0 });
    this.write(backend.bindComplete());
  }

  private async describe(body: ByteReader): Promise<void> {
    const kind = String.fromCharCode(body.u8());
    const name = body.cstring();
    if (kind === "S") {
      const prepared = this.prepared.get(name);
      if (!prepared) throw pgError("internal", `prepared statement "${name}" does not exist`, "26000");
      this.write(backend.parameterDescription(prepared.paramOids.map((oid) => (oid === 0 ? 25 : oid))));
      const shape = await this.shapeOf(prepared);
      this.write(shape ? backend.rowDescription(this.fields(shape, [])) : backend.noData());
      return;
    }
    const portal = this.portals.get(name);
    if (!portal) throw pgError("internal", `portal "${name}" does not exist`, "34000");
    this.busy = true;
    portal.outcome ??= await this.execute(portal.prepared.sql, portal.params);
    const outcome = portal.outcome;
    if (outcome.empty || outcome.result.columns.length === 0) this.write(backend.noData());
    else this.write(backend.rowDescription(this.fields(outcome.result, portal.resultFormats)));
  }

  /**
   * The row shape of a statement that returns rows, for Describe on a statement: a trial run with
   * null parameters inside a transaction that is rolled back. Anything else (or a trial that
   * fails) is described as returning no data.
   */
  private async shapeOf(prepared: Prepared): Promise<TextResultSet | null> {
    if (!RETURNS_ROWS.test(prepared.sql)) return null;
    const db = this.cluster.db;
    await this.cluster.acquireTurn(this);
    try {
      const params = prepared.paramOids.map(() => null);
      if (db.transactions.inTransaction) {
        const name = `__describe_${this.pid}`;
        db.transactions.savepoint(name);
        try {
          return this.cluster.as(this, () => db.prepare(prepared.sql).textResult(...params));
        } finally {
          db.transactions.rollbackToSavepoint(name);
          db.transactions.releaseSavepoint(name);
        }
      }
      db.transactions.begin();
      try {
        return this.cluster.as(this, () => db.prepare(prepared.sql).textResult(...params));
      } finally {
        db.transactions.rollback();
      }
    } catch {
      return null;
    } finally {
      if (!db.transactions.inTransaction) this.cluster.releaseTurn(this);
    }
  }

  private async executePortal(body: ByteReader): Promise<void> {
    const name = body.cstring();
    const maxRows = body.i32();
    const portal = this.portals.get(name);
    if (!portal) throw pgError("internal", `portal "${name}" does not exist`, "34000");
    this.busy = true;
    try {
      portal.outcome ??= await this.execute(portal.prepared.sql, portal.params);
    } catch (error) {
      if (error instanceof ConnectionDropped) return;
      throw error;
    }
    const state = this.sendOutcome(portal.outcome, portal.resultFormats, {
      rowDescription: false,
      from: portal.cursor,
      limit: maxRows,
    });
    if (state === "suspended") portal.cursor += maxRows;
    else portal.cursor = portal.outcome.empty ? 0 : portal.outcome.result.rows.length;
  }

  private close(body: ByteReader): void {
    const kind = String.fromCharCode(body.u8());
    const name = body.cstring();
    if (kind === "S") {
      this.prepared.delete(name);
      for (const [portalName, portal] of [...this.portals])
        if (portal.prepared.name === name) this.portals.delete(portalName);
    } else this.portals.delete(name);
    this.write(backend.closeComplete());
  }

  private sync(): void {
    this.skipUntilSync = false;
    if (!this.inTransaction) this.portals.clear();
    this.readyForQuery();
  }
}

const command = (tag: string): Outcome => ({
  empty: false,
  result: { columns: [], columnTypes: [], rows: [], rowCount: 0, command: tag },
  tag,
});

class ConnectionDropped extends Error {
  constructor() {
    super("connection dropped by fault");
    this.name = "ConnectionDropped";
  }
}
