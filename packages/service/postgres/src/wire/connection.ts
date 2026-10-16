import type { Socket } from "node:net";
import { type BindValue, bindValueToTyped } from "../api/bind.ts";
import type { Database } from "../api/database.ts";
import type { TextResultSet } from "../api/statement.ts";
import type { CopyStmt, Expr } from "../ast/nodes.ts";
import { isPostgresError, PostgresError } from "../errors/error.ts";
import { leavesInvalidIndexOnFailure, refusedInTransactionBlock } from "../executor/maintenance.ts";
import { inferColumnName } from "../executor/relation.ts";
import { executeCopyFromData } from "../executor/session.ts";
import { EngineCtx } from "../expressions/context.ts";
import { parse as parseSql } from "../parser/index.ts";
import { setDatabaseCatalogContext } from "../runtime/database-context.ts";
import { datumText, typeOid, UTC_OUTPUT } from "../types/value.ts";
import { type Cluster, LockWait, type Session } from "./cluster.ts";
import { type DurableCommit, storageFailure } from "./durable.ts";
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
import { applyStartupSettings, StartupError, startupSettings } from "./startup.ts";

/** One statement's outcome, before it is written to the wire. */
type Outcome = { empty: true } | { empty: false; result: TextResultSet; tag: string };

type Prepared = { name: string; sql: string; paramOids: number[] };
type LoggedStatement =
  | { kind: "sql"; sql: string; params: BindValue[] }
  | { kind: "copy"; stmt: CopyStmt; data: string };
type TransactionWorkspace = {
  statements: LoggedStatement[];
  savepoints: Array<{ name: string; statementCount: number }>;
};
type Portal = {
  name: string;
  prepared: Prepared;
  params: BindValue[];
  resultFormats: number[];
  /** Set once executed (by Describe or Execute); rows are handed out from `cursor`. */
  outcome?: Outcome;
  cursor: number;
};

type CopyIn = {
  stmt: CopyStmt;
  sql: string;
  database: Database;
  workspace: boolean;
  /** Durable mode, outside a transaction block: takes the committed COPY back out of memory. */
  undo: (() => void) | null;
  buffer: string;
  decoder: TextDecoder;
  rowCount: number;
  headerPending: boolean;
  loggedData: string;
};

export type ServerFaults = {
  /** Destroy the socket of the next connection that runs a statement inside a transaction block. */
  dropConnection?: boolean;
  /** Hold the next statement this long before it runs. */
  delayStatementMs?: number;
  /** Fail the next COMMIT with this SQLSTATE (`40001` serialization failure) after rolling back. */
  failCommit?: string;
  /**
   * Interrupt the next `CREATE INDEX CONCURRENTLY` / `REINDEX ... CONCURRENTLY` with this SQLSTATE
   * (`57014` canceled, `40P01` deadlock). The index it was building stays in the catalog, invalid.
   */
  failConcurrentIndexBuild?: string;
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
  /**
   * When set, a startup packet that names a different database is fatal `3D000`.
   * Unset accepts any database name.
   */
  database?: string;
};

const TX_CONTROL = /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release)\b/i;
const COMMIT = /^(commit|end)\b/i;
const LISTEN = /^listen\s+("?)([A-Za-z_][\w$]*)\1\s*$/i;
const UNLISTEN = /^unlisten\s+(\*|"?[A-Za-z_][\w$]*"?)\s*$/i;
const NOTIFY = /^notify\s+("?)([A-Za-z_][\w$]*)\1\s*(?:,\s*'((?:[^']|'')*)')?\s*$/i;
const RETURNS_ROWS = /^(select|with|values|show|table|explain)\b/i;
const CLUSTER_DDL = /^(create|drop|alter)\s+database\b/i;
const IDENT = '(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))';
const CREATE_DATABASE = new RegExp(
  `^create\\s+database\\s+${IDENT}(?:\\s+with)?(?:\\s+template\\s*(?:=\\s*)?${IDENT})?\\s*$`,
  "i",
);
const DROP_DATABASE = new RegExp(
  `^drop\\s+database\\s+(if\\s+exists\\s+)?${IDENT}(?:\\s+with\\s*\\(\\s*force\\s*\\))?\\s*$`,
  "i",
);
const RENAME_DATABASE = new RegExp(`^alter\\s+database\\s+${IDENT}\\s+rename\\s+to\\s+${IDENT}\\s*$`, "i");

const identifier = (quoted: string | undefined, plain: string | undefined): string =>
  quoted === undefined ? (plain as string).toLowerCase() : quoted.replaceAll('""', '"');
const ROW_LOCK =
  /\s+for\s+(?:no\s+key\s+update|key\s+share|update|share)(?:\s+of\s+(?:(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)(?:\s*,\s*(?:(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?))*)?(?:\s+(nowait|skip\s+locked))?\s*$/i;
const LIMIT = /\s+limit\s+(\d+)(?:\s+offset\s+(\d+))?\s*$/i;
const SQL_NAME = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const SQL_RELATION = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?`;
const FROM_TABLE = new RegExp(String.raw`\bfrom\s+(${SQL_RELATION})`, "i");
const UPDATE_TARGET = new RegExp(
  String.raw`^update\s+(${SQL_RELATION})(?:\s+(?:as\s+)?(${SQL_NAME}))?\s+set\s+[\s\S]*?(?:\s+where\s+([\s\S]*?))?(?:\s+returning\s+[\s\S]*)?$`,
  "i",
);
const DELETE_TARGET = new RegExp(
  String.raw`^delete\s+from\s+(${SQL_RELATION})(?:\s+(?:as\s+)?(${SQL_NAME}))?(?:\s+where\s+([\s\S]*?))?(?:\s+returning\s+[\s\S]*)?$`,
  "i",
);

/**
 * Row-lock probe for UPDATE / DELETE. The alias has to survive: `UPDATE t AS ap`
 * is locked with `SELECT * FROM t AS ap`, or `ap.column` in WHERE is unknown.
 */
const lockedMutationQuery = (sql: string): string | null => {
  const match = UPDATE_TARGET.exec(sql) ?? DELETE_TARGET.exec(sql);
  const relation = match?.[1];
  if (!relation) return null;
  const alias = match?.[2];
  const where = match?.[3];
  const from = alias ? `${relation} AS ${alias}` : relation;
  return `SELECT * FROM ${from}${where ? ` WHERE ${where}` : ""}`;
};

/** Text form of a literal or bound parameter, matching the row-lock identity. */
const lockLiteral = (expr: Expr | undefined, params: readonly BindValue[]): string | null | undefined => {
  if (!expr) return undefined;
  switch (expr.type) {
    case "null_lit":
      return null;
    case "string_lit":
      return expr.value;
    case "bool_lit":
      return expr.value ? "t" : "f";
    case "number_lit":
      return expr.raw.replace(/^\+/, "");
    case "param": {
      const value = params[expr.index - 1];
      if (value === undefined) return undefined;
      const typed = bindValueToTyped(value, expr.index - 1);
      if (typed.v === null) return null;
      return datumText(typed.t, typed.v, UTC_OUTPUT);
    }
    default:
      return undefined;
  }
};

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
  if (isPostgresError(error)) {
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

/** set_config is a SELECT with session side effects that must survive workspace replay. */
const setsSessionConfig = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(setsSessionConfig);
  if (typeof node !== "object" || node === null) return false;
  const call = node as { type?: string; name?: string[] };
  if (call.type === "func" && call.name?.at(-1) === "set_config") return true;
  return Object.values(node).some(setsSessionConfig);
};
const mutatesDatabase = (sql: string): boolean =>
  parseSql(sql).some(
    (stmt) =>
      !["select", "show", "explain", "transaction", "no_op"].includes(stmt.type) ||
      (stmt.type === "select" && setsSessionConfig(stmt)),
  );

/** Statements that cannot change what a snapshot of the database holds. */
const NEVER_WRITES = new Set(["show", "set", "reset", "transaction", "no_op", "prepare", "deallocate"]);
const WRITE_NODES = new Set(["insert", "update", "delete"]);

/**
 * Whether a query tree holds a data-modifying statement, or names something that can run one:
 * a sequence function, a user-defined function, or a view (whose definition may call either).
 */
const containsWrite = (db: Database, node: unknown): boolean => {
  if (Array.isArray(node)) return node.some((item) => containsWrite(db, item));
  if (typeof node !== "object" || node === null) return false;
  const { type, name } = node as { type?: unknown; name?: unknown };
  if (typeof type === "string" && WRITE_NODES.has(type)) return true;
  if (Array.isArray(name)) {
    const named = String(name.at(-1)).toLowerCase();
    if (named === "nextval" || named === "setval") return true;
    for (const schema of db.state.schemas.values()) {
      if (schema.functions.has(named) || schema.views.has(named)) return true;
    }
  }
  return Object.values(node).some((value) => containsWrite(db, value));
};

/**
 * Whether an autocommit statement may have committed a change that durable mode has to persist.
 * Erring towards yes costs one snapshot encode: an image equal to the persisted one is not rewritten.
 */
const mayCommitWrite = (db: Database, sql: string): boolean => {
  let statements: ReturnType<typeof parseSql>;
  try {
    statements = parseSql(sql);
  } catch {
    return false;
  }
  return statements.some((stmt) => {
    if (NEVER_WRITES.has(stmt.type)) return false;
    const reads =
      stmt.type === "select" || stmt.type === "explain" || (stmt.type === "copy" && stmt.direction === "to");
    return !reads || containsWrite(db, stmt);
  });
};

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
 * Column layout of `INSERT`/`UPDATE`/`DELETE ... RETURNING`, without running the write.
 * `RETURNING *` is the target table. A qualifier that is not that table is left undescribed.
 */
function returningShape(db: Database, sql: string): TextResultSet | null {
  let statements: ReturnType<typeof parseSql>;
  try {
    statements = parseSql(sql);
  } catch {
    return null;
  }
  const stmt = statements.length === 1 ? statements[0] : undefined;
  if (!stmt || (stmt.type !== "insert" && stmt.type !== "update" && stmt.type !== "delete")) return null;
  const targets = stmt.returning;
  if (!targets || targets.length === 0) return null;
  const table = db.state.findTable(stmt.table);
  if (!table) return null;
  const label = stmt.alias ?? table.name;
  const columns: string[] = [];
  const columnTypes: string[] = [];
  for (const target of targets) {
    if (target.expr.type === "star") {
      const qualifier = target.expr.table?.at(-1);
      if (qualifier !== undefined && qualifier !== label && qualifier !== table.name) return null;
      for (const column of table.columns) {
        columns.push(column.name);
        columnTypes.push(column.type.id);
      }
      continue;
    }
    if (target.expr.type === "colref") {
      const name = target.expr.parts.at(-1) ?? "?column?";
      const column = table.columns.find((item) => item.name === name);
      columns.push(target.alias ?? name);
      columnTypes.push(column?.type.id ?? "text");
      continue;
    }
    columns.push(target.alias ?? inferColumnName(target.expr));
    columnTypes.push("text");
  }
  if (columns.length === 0) return null;
  const command = stmt.type === "insert" ? "INSERT" : stmt.type === "update" ? "UPDATE" : "DELETE";
  return { columns, columnTypes, rows: [], rowCount: 0, command };
}

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
  database: Database;
  databaseName: string;

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
  private copyIn: CopyIn | null = null;
  private copyDrain = false;
  /** Successful writes in this session's READ COMMITTED transaction workspace. */
  private transaction: TransactionWorkspace | null = null;
  private closed = false;
  /** This session's settings. They stand in for the database's own around each of its engine calls. */
  private settings = new Map<string, string>();
  /** What `RESET` returns to: the database's settings at connect, then the startup packet's. */
  private settingDefaults: ReadonlyMap<string, string> = new Map();
  /** Durable commits that are persisted and not yet acknowledged on the socket. */
  private readonly unacknowledged: DurableCommit[] = [];
  /** A commit of this session is being persisted; it still owns the statement turn. */
  private persisting: Promise<void> | null = null;

  constructor(
    private readonly socket: Socket,
    private readonly cluster: Cluster,
    private readonly options: ConnectionOptions,
  ) {
    this.database = cluster.db;
    this.databaseName = cluster.defaultDatabaseName;
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
    // An interrupted COPY began its engine transaction with this session's settings in place.
    const copy = this.copyIn;
    if (copy && !copy.workspace && copy.database.transactions.inTransaction) {
      this.inSession(copy.database, () => copy.database.transactions.rollback());
    }
    // A commit being persisted is rolled back or acknowledged before the session gives up its turn.
    if (this.persisting) void this.persisting.then(() => this.cluster.drop(this));
    else this.cluster.drop(this);
  }

  /**
   * Run engine work with this session's settings in place of the database's own, so one
   * connection's `SET` never reaches another. Whatever the work leaves behind is the session's.
   */
  private inSession<T>(db: Database, fn: () => T): T {
    const state = db.state;
    const shared = { settings: state.settings, defaults: state.settingDefaults };
    state.settings = this.settings;
    state.settingDefaults = this.settingDefaults;
    try {
      return fn();
    } finally {
      this.settings = state.settings;
      state.settings = shared.settings;
      state.settingDefaults = shared.defaults;
    }
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
    if (this.copyIn && message.kind === "typed") {
      await this.handleCopyIn(message.type, message.body);
      return;
    }
    if (this.copyDrain && message.kind === "typed") {
      if (message.type === "c" || message.type === "f") {
        this.copyDrain = false;
        this.readyForQuery();
      } else if (message.type === "X") {
        this.socket.end();
        this.dispose();
      }
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

  private fatal(code: string, message: string, extra: { detail?: string; hint?: string } = {}): void {
    this.write(backend.errorResponse({ severity: "FATAL", code, message, ...extra }));
    this.socket.end();
    this.dispose();
  }

  private startup(protocol: number, parameters: Record<string, string>): void {
    if (protocol >> 16 !== PROTOCOL_3_0 >> 16) {
      this.fatal("0A000", `unsupported frontend protocol ${protocol >> 16}.${protocol & 0xffff}: server supports 3.0`);
      return;
    }
    this.user = parameters.user ?? "postgres";
    const requested = parameters.database && parameters.database.length > 0 ? parameters.database : this.user;
    const database = this.cluster.getDatabase(requested);
    if (!database || (this.options.database !== undefined && requested !== this.options.database)) {
      this.fatal("3D000", `database "${requested}" does not exist`);
      return;
    }
    this.database = database;
    this.databaseName = requested;
    this.startupParameters = parameters;
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
    this.write(backend.authenticationOk());
    // PostgreSQL applies the packet's run-time parameters after authentication: the `options`
    // switches, then the parameters sent by name. A bad one ends the connection with FATAL.
    const settings = new Map(this.database.state.settings);
    try {
      const applied = applyStartupSettings(startupSettings(parameters), settings);
      this.settingDefaults = new Map([...this.database.state.settings, ...applied]);
    } catch (error) {
      if (!(error instanceof StartupError)) throw error;
      const { code, message, ...extra } = error.fields;
      this.fatal(code, message, extra);
      return;
    }
    this.settings = settings;
    this.started = true;
    const setting = (name: string, fallback: string): string => settings.get(name) ?? fallback;
    const status: Record<string, string> = {
      server_version: this.options.serverVersion,
      server_encoding: "UTF8",
      client_encoding: setting("client_encoding", "UTF8"),
      application_name: setting("application_name", ""),
      DateStyle: setting("datestyle", "ISO, MDY"),
      IntervalStyle: setting("intervalstyle", "postgres"),
      TimeZone: setting("timezone", "UTC"),
      integer_datetimes: "on",
      standard_conforming_strings: setting("standard_conforming_strings", "on"),
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
    return this.transaction !== null;
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
      if (isPostgresError(error) && error.sqlState === "40P01") this.cluster.unlockAll(this, true);
      const status = isPostgresError(error) ? error.sqlState : "XX000";
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
    if (CLUSTER_DDL.test(text)) {
      return this.cluster.durability ? this.durableClusterDdl(text) : this.executeClusterDdl(text);
    }
    for (;;) {
      if (this.cancelled) throw pgError("internal", "canceling statement due to user request", "57014");
      await this.cluster.acquireTurn(this);
      const faults = this.options.faults;
      if (faults.delayStatementMs !== undefined) {
        const ms = faults.delayStatementMs;
        faults.delayStatementMs = undefined;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      if (faults.dropConnection && this.inTransaction) {
        faults.dropConnection = undefined;
        this.destroy();
        throw new ConnectionDropped();
      }
      try {
        const undo = this.durableUndo(text, control);
        const outcome = this.runStatement(text, params, control);
        const commit = undo ? await this.persist(text, [this.database], undo) : null;
        this.afterStatement();
        if (commit) await this.cluster.durability?.beforeAcknowledge(commit);
        return outcome;
      } catch (error) {
        if (error instanceof LockWait) {
          const key = error.key;
          this.cluster.releaseTurn(this);
          await this.waitForLock(key);
          continue;
        }
        this.afterStatement();
        throw error;
      }
    }
  }

  /**
   * Durable mode, before a statement that may commit: how to take that commit back out of
   * memory if storage then refuses it. Null when the statement cannot commit a change.
   */
  private durableUndo(text: string, control: boolean): (() => void) | null {
    if (!this.cluster.durability) return null;
    if (control) {
      if (!COMMIT.test(text) || this.aborted || !this.transaction?.statements.length) return null;
    } else if (this.transaction !== null || !mayCommitWrite(this.database, text)) return null;
    return this.checkpoint(this.database);
  }

  /** What a transaction's BEGIN captures and its ROLLBACK restores, for a commit already applied. */
  private checkpoint(db: Database): () => void {
    db.state.freezeShared();
    const before = db.state.cloneShallow();
    const prng = db.prng.getState();
    return () => {
      db.state.restoreFrom(before);
      db.prng.setState(prng);
    };
  }

  /**
   * Persist a commit this session just applied, while it still holds the statement turn, so no
   * other session has seen it. Storage refusing it takes the commit back out of memory and
   * fails the statement (`58030`, or `53100` when storage is full); the transaction is gone,
   * as after any failed COMMIT. Resolves to the commit when storage was written.
   */
  private async persist(sql: string, changed: readonly Database[], undo: () => void): Promise<DurableCommit | null> {
    const durability = this.cluster.durability;
    if (!durability) return null;
    let settled = (): void => undefined;
    this.persisting = new Promise<void>((resolve) => {
      settled = resolve;
    });
    try {
      if (!(await durability.persist(changed))) return null;
    } catch (cause) {
      undo();
      this.pendingNotifies.length = 0;
      throw storageFailure(cause);
    } finally {
      this.persisting = null;
      settled();
    }
    const commit = { pid: this.pid, database: this.databaseName, sql };
    this.unacknowledged.push(commit);
    return commit;
  }

  /** The acknowledgement of every persisted commit is on the socket. */
  private async acknowledged(): Promise<void> {
    for (const commit of this.unacknowledged.splice(0)) await this.cluster.durability?.afterAcknowledge(commit);
  }

  /** CREATE / DROP / ALTER DATABASE in durable mode: the catalog change is persisted, or undone. */
  private async durableClusterDdl(text: string): Promise<Outcome> {
    await this.cluster.acquireTurn(this);
    try {
      const catalog = this.cluster.catalog();
      const outcome = this.executeClusterDdl(text);
      const commit = await this.persist(text, [], () => this.cluster.restoreCatalog(catalog));
      this.cluster.releaseTurn(this);
      if (commit) await this.cluster.durability?.beforeAcknowledge(commit);
      return outcome;
    } finally {
      this.cluster.releaseTurn(this);
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
    const faults = this.options.faults;
    if (control && COMMIT.test(text)) {
      if (this.aborted) {
        this.transaction = null;
        this.aborted = false;
        return command("ROLLBACK");
      }
      if (faults.failCommit !== undefined) {
        const code = faults.failCommit;
        faults.failCommit = undefined;
        this.transaction = null;
        throw pgError("internal", "could not serialize access due to concurrent update", code);
      }
    }
    if (control && this.aborted && /^(rollback|abort)\b/i.test(text) && !/\bto\b/i.test(text)) {
      this.transaction = null;
      this.aborted = false;
      return command("ROLLBACK");
    }
    if (control) return this.transactionControl(text);

    const workspace = this.transaction === null ? null : this.openWorkspace();
    const db = workspace ?? this.database;
    try {
      const run = () => {
        const result = this.cluster.as(this, () => this.runQuery(db, text, params));
        return { empty: false as const, result, tag: commandTag(result) };
      };
      // Index commands PostgreSQL refuses in a transaction block (CREATE / DROP INDEX CONCURRENTLY,
      // REINDEX CONCURRENTLY | SCHEMA | DATABASE | SYSTEM) run outside the statement rollback wrapper:
      // a failed concurrent build has to keep the invalid index it leaves in the catalog.
      const statements = /\b(concurrently|reindex)\b/i.test(text) ? parseSql(text) : [];
      const refused = statements.map(refusedInTransactionBlock).find((command) => command !== null);
      if (refused && this.transaction !== null) {
        throw new PostgresError("misuse", `${refused} cannot run inside a transaction block`, "25001");
      }
      if (faults.failConcurrentIndexBuild !== undefined && statements.some(leavesInvalidIndexOnFailure)) {
        db.state.faults.concurrentIndexBuild = faults.failConcurrentIndexBuild;
        faults.failConcurrentIndexBuild = undefined;
      }
      const statement = () => (refused ? run() : db.transaction(run));
      const outcome = workspace ? statement() : this.inSession(db, statement);
      if (this.transaction && mutatesDatabase(text)) {
        this.transaction.statements.push({ kind: "sql", sql: text, params: params.slice() });
      }
      return outcome;
    } finally {
      workspace?.transactions.rollback();
      workspace?.close();
    }
  }

  /** Release the statement turn; transaction-scoped locks live until COMMIT / ROLLBACK. */
  private afterStatement(): void {
    this.cluster.releaseTurn(this);
    if (!this.inTransaction) {
      this.cluster.unlockAll(this, true);
      this.flushNotifies();
    }
  }

  private transactionControl(text: string): Outcome {
    const stmt = parseSql(text)[0];
    if (stmt?.type !== "transaction") throw pgError("syntax", "invalid transaction command", "42601");
    switch (stmt.action) {
      case "begin":
        this.transaction ??= { statements: [], savepoints: [] };
        return command("BEGIN");
      case "commit": {
        const transaction = this.transaction;
        this.transaction = null;
        if (transaction) {
          this.inSession(this.database, () =>
            this.database.transaction(() => {
              for (const logged of transaction.statements) this.replay(this.database, logged);
            }),
          );
        }
        return command("COMMIT");
      }
      case "rollback":
        this.transaction = null;
        return command("ROLLBACK");
      case "savepoint": {
        if (!this.transaction) throw pgError("internal", "SAVEPOINT can only be used in transaction blocks", "25P01");
        this.transaction.savepoints.push({
          name: stmt.savepointName as string,
          statementCount: this.transaction.statements.length,
        });
        return command("SAVEPOINT");
      }
      case "release": {
        const index = this.findSavepoint(stmt.savepointName as string);
        this.transaction?.savepoints.splice(index);
        return command("RELEASE");
      }
      case "rollback_to": {
        const index = this.findSavepoint(stmt.savepointName as string);
        const savepoint = this.transaction?.savepoints[index];
        if (!this.transaction || !savepoint) throw pgError("internal", "savepoint does not exist", "3B001");
        this.transaction.statements.splice(savepoint.statementCount);
        this.transaction.savepoints.splice(index + 1);
        this.aborted = false;
        return command("ROLLBACK");
      }
    }
  }

  private findSavepoint(name: string): number {
    if (!this.transaction) throw pgError("internal", "SAVEPOINT can only be used in transaction blocks", "25P01");
    for (let i = this.transaction.savepoints.length - 1; i >= 0; i--) {
      if (this.transaction.savepoints[i]?.name === name) return i;
    }
    throw pgError("internal", `savepoint "${name}" does not exist`, "3B001");
  }

  /** Rebase this transaction's successful writes onto the latest committed state. */
  private openWorkspace(): Database {
    const workspace = this.database.branch();
    setDatabaseCatalogContext(workspace.state, {
      name: this.databaseName,
      names: () => this.cluster.databaseNames(),
    });
    // The workspace is this session's alone: a SET inside the block reaches the session at commit.
    workspace.state.settings = new Map(this.settings);
    workspace.state.settingDefaults = this.settingDefaults;
    workspace.transactions.begin();
    for (const logged of this.transaction?.statements ?? []) {
      this.replay(workspace, logged);
    }
    return workspace;
  }

  private replay(db: Database, logged: LoggedStatement): void {
    this.cluster.as(this, () => {
      if (logged.kind === "sql") db.prepare(logged.sql).textResult(...logged.params);
      else {
        const env = { ctx: new EngineCtx(db.state), params: null, ctes: new Map(), outer: null };
        executeCopyFromData(env, logged.stmt, logged.data);
      }
    });
  }

  /**
   * Hold the primary key until the transaction ends. PostgreSQL's unique index makes a
   * second `INSERT` of the same key wait; `ON CONFLICT DO UPDATE` then sees the committed row.
   * Without this, each session's workspace inserts the key and commit replay raises 23505.
   */
  private lockInsertedPrimaryKey(db: Database, text: string, params: readonly BindValue[]): void {
    let statements: ReturnType<typeof parseSql>;
    try {
      statements = parseSql(text);
    } catch {
      return;
    }
    const stmt = statements.length === 1 ? statements[0] : undefined;
    if (stmt?.type !== "insert" || stmt.source === "default_values" || stmt.source.body.type !== "values") return;
    if (!stmt.columns) return;
    const table = db.state.findTable(stmt.table);
    const primary = table?.constraints.find((constraint) => constraint.kind === "primary_key");
    if (!primary || primary.columns.length === 0) return;
    const indexes = primary.columns.map((column) => stmt.columns?.indexOf(column) ?? -1);
    if (indexes.some((index) => index < 0)) return;
    const identities: (string | null)[][] = [];
    for (const row of stmt.source.body.rows) {
      const identity: (string | null)[] = [];
      for (const index of indexes) {
        const value = lockLiteral(row[index], params);
        if (value === undefined) return;
        identity.push(value);
      }
      identities.push(identity);
    }
    const relation = stmt.table.join(".");
    for (const identity of identities) {
      const key = `row:${this.databaseName}:${relation}:${JSON.stringify(identity)}`;
      if (!this.cluster.tryLock(this, key, true)) throw new LockWait(key);
    }
  }

  private runQuery(db: Database, text: string, params: BindValue[]): TextResultSet {
    const lock = ROW_LOCK.exec(text);
    if (!lock) {
      const lockQuery = lockedMutationQuery(text);
      if (lockQuery) this.lockRows(db, lockQuery, params, "wait");
      this.lockInsertedPrimaryKey(db, text, params);
      return db.prepare(text).textResult(...params);
    }

    let query = text.slice(0, lock.index).trimEnd();
    const limitMatch = LIMIT.exec(query);
    const limit = limitMatch ? Number(limitMatch[1]) : Number.POSITIVE_INFINITY;
    const offset = limitMatch ? Number(limitMatch[2] ?? 0) : 0;
    if (limitMatch) query = query.slice(0, limitMatch.index).trimEnd();
    return this.lockRows(db, query, params, lock[1]?.toLowerCase().replace(/\s+/g, "_") ?? "wait", limit, offset);
  }

  private lockRows(
    db: Database,
    query: string,
    params: BindValue[],
    policy: string,
    limit = Number.POSITIVE_INFINITY,
    offset = 0,
  ): TextResultSet {
    const result = db.prepare(query).textResult(...params);
    const rows: (string | null)[][] = [];
    for (const row of result.rows.slice(offset)) {
      const key = this.rowLockKey(db, query, result.columns, row);
      if (this.cluster.tryLock(this, key, true)) {
        rows.push(row);
        if (rows.length >= limit) break;
        continue;
      }
      if (policy === "skip_locked") continue;
      if (policy === "nowait") {
        throw pgError("internal", "could not obtain lock on row in relation", "55P03");
      }
      throw new LockWait(key);
    }
    return { ...result, rows, rowCount: rows.length };
  }

  private rowLockKey(db: Database, query: string, columns: string[], row: (string | null)[]): string {
    const rawName = FROM_TABLE.exec(query)?.[1] ?? "query";
    const parts = rawName
      .split(".")
      .map((part) => (part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part.toLowerCase()));
    const table = db.state.findTable(parts);
    const primary = table?.constraints.find((constraint) => constraint.kind === "primary_key");
    const indexes = primary?.columns.map((column) => columns.indexOf(column)) ?? [];
    const identity = indexes.length > 0 && indexes.every((index) => index >= 0) ? indexes.map((i) => row[i]) : row;
    return `row:${this.databaseName}:${parts.join(".")}:${JSON.stringify(identity)}`;
  }

  private flushNotifies(): void {
    for (const { channel, payload } of this.pendingNotifies.splice(0)) this.cluster.notify(this, channel, payload);
  }

  private executeClusterDdl(text: string): Outcome {
    if (this.inTransaction) {
      throw pgError("internal", "CREATE/DROP/ALTER DATABASE cannot run inside a transaction block", "25001");
    }
    const create = CREATE_DATABASE.exec(text);
    if (create) {
      const name = identifier(create[1], create[2]);
      const template =
        create[3] === undefined && create[4] === undefined ? undefined : identifier(create[3], create[4]);
      this.cluster.createDatabase(name, template);
      return command("CREATE DATABASE");
    }
    const drop = DROP_DATABASE.exec(text);
    if (drop) {
      const name = identifier(drop[2], drop[3]);
      if (drop[1] && !this.cluster.getDatabase(name)) return command("DROP DATABASE");
      this.cluster.dropDatabase(name, this);
      return command("DROP DATABASE");
    }
    const rename = RENAME_DATABASE.exec(text);
    if (rename) {
      const from = identifier(rename[1], rename[2]);
      const to = identifier(rename[3], rename[4]);
      this.cluster.renameDatabase(from, to, this);
      return command("ALTER DATABASE");
    }
    throw pgError("syntax", "unsupported CREATE/DROP/ALTER DATABASE option", "0A000");
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
    if (statements.length === 1) {
      const copy = this.copyStatement(statements[0] as string);
      if (copy?.direction === "from") {
        await this.beginCopyIn(copy, statements[0] as string);
        return;
      }
      if (copy?.direction === "to") {
        try {
          const outcome = await this.execute(statements[0] as string);
          this.sendCopyOut(outcome, this.copyColumnCount(copy));
        } catch (error) {
          this.write(backend.errorResponse(errorFields(error)));
          if (this.inTransaction) this.aborted = true;
        }
        this.readyForQuery();
        return;
      }
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
        await this.acknowledged();
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
    await this.acknowledged();
  }

  private copyStatement(sql: string): CopyStmt | null {
    try {
      const statements = parseSql(sql);
      const stmt = statements.length === 1 ? statements[0] : undefined;
      return stmt?.type === "copy" ? stmt : null;
    } catch {
      return null;
    }
  }

  private copyColumnCount(stmt: CopyStmt): number {
    if (stmt.columns) return stmt.columns.length;
    const table = stmt.table;
    if (table) return this.inSession(this.database, () => this.database.state.findTable(table)?.columns.length ?? 0);
    return 0;
  }

  private async handleCopyIn(type: string, body: ByteReader): Promise<void> {
    const copy = this.copyIn as CopyIn;
    if (type === "d") {
      try {
        copy.buffer += copy.decoder.decode(body.rest(), { stream: true });
        this.flushCopyRecords(copy, false);
      } catch (error) {
        this.abortCopyIn(copy, error, true);
      }
      return;
    }
    if (type === "f") {
      const detail = body.cstring();
      this.abortCopyIn(copy, pgError("internal", `COPY from stdin failed: ${detail}`, "57014"), false);
      return;
    }
    if (type === "c") {
      await this.finishCopyIn(copy);
      return;
    }
    if (type === "H") return;
    if (type === "X") {
      this.socket.end();
      this.dispose();
      return;
    }
    this.fatal("08P01", `unexpected frontend message type ${JSON.stringify(type)} during COPY`);
  }

  /** Engine work of a COPY in progress. A workspace already carries the session's settings. */
  private inCopy<T>(copy: Pick<CopyIn, "database" | "workspace">, fn: () => T): T {
    return copy.workspace ? fn() : this.inSession(copy.database, fn);
  }

  private async beginCopyIn(stmt: CopyStmt, sql: string): Promise<void> {
    await this.cluster.acquireTurn(this);
    const workspace = this.transaction ? this.openWorkspace() : null;
    const database = workspace ?? this.database;
    const undo = workspace === null && this.cluster.durability ? this.checkpoint(database) : null;
    this.inCopy({ database, workspace: workspace !== null }, () => database.transactions.begin());
    this.copyIn = {
      stmt,
      sql,
      database,
      workspace: workspace !== null,
      undo,
      buffer: "",
      decoder: new TextDecoder(),
      rowCount: 0,
      headerPending: stmt.options.header === true || String(stmt.options.header ?? "").toLowerCase() === "true",
      loggedData: "",
    };
    this.write(backend.copyInResponse(this.copyColumnCount(stmt)));
  }

  private async finishCopyIn(copy: CopyIn): Promise<void> {
    const tx = copy.database.transactions;
    try {
      copy.buffer += copy.decoder.decode();
      this.flushCopyRecords(copy, true);
      tx.commit();
      if (copy.workspace) {
        this.transaction?.statements.push({ kind: "copy", stmt: copy.stmt, data: copy.loggedData });
        copy.database.close();
      }
      const commit = copy.undo ? await this.persist(copy.sql, [copy.database], copy.undo) : null;
      this.copyIn = null;
      this.cluster.releaseTurn(this);
      if (commit) await this.cluster.durability?.beforeAcknowledge(commit);
      this.write(backend.commandComplete(`COPY ${copy.rowCount}`));
      await this.acknowledged();
      this.readyForQuery();
    } catch (error) {
      this.abortCopyIn(copy, error, false);
    }
  }

  private flushCopyRecords(copy: CopyIn, final: boolean): void {
    const format = String(copy.stmt.options.format ?? "text").toLowerCase();
    const quote = String(copy.stmt.options.quote ?? '"');
    const boundaries: number[] = [];
    let quoted = false;
    for (let i = 0; i < copy.buffer.length; i++) {
      const char = copy.buffer[i];
      if (format === "csv" && char === quote) {
        if (quoted && copy.buffer[i + 1] === quote) i++;
        else quoted = !quoted;
      } else if (char === "\n" && !quoted) {
        boundaries.push(i + 1);
      }
    }
    if (final && quoted) {
      throw new PostgresError("invalid_text_representation", "unterminated CSV quoted field", "22P04");
    }
    const end = boundaries.at(-1) ?? 0;
    const data = final ? copy.buffer : end > 0 ? copy.buffer.slice(0, end) : "";
    if (data === "") return;
    copy.buffer = final ? "" : copy.buffer.slice(end);
    const stmt = copy.headerPending ? copy.stmt : { ...copy.stmt, options: { ...copy.stmt.options, header: false } };
    const env = {
      ctx: new EngineCtx(copy.database.state),
      params: null,
      ctes: new Map(),
      outer: null,
    };
    const result = this.inCopy(copy, () => this.cluster.as(this, () => executeCopyFromData(env, stmt, data)));
    copy.rowCount += result.rowCount;
    copy.loggedData += data;
    copy.headerPending = false;
  }

  private abortCopyIn(copy: CopyIn, error: unknown, drain: boolean): void {
    const tx = copy.database.transactions;
    if (tx.inTransaction) this.inCopy(copy, () => tx.rollback());
    if (copy.workspace) copy.database.close();
    if (this.inTransaction) this.aborted = true;
    this.cluster.releaseTurn(this);
    this.copyIn = null;
    this.copyDrain = drain;
    this.write(backend.errorResponse(errorFields(error)));
    if (!drain) this.readyForQuery();
  }

  private sendCopyOut(outcome: Outcome, columns: number): void {
    if (outcome.empty) throw pgError("internal", "COPY TO produced no result", "XX000");
    this.write(backend.copyOutResponse(columns));
    for (const row of outcome.result.rows) {
      const line = row[0] ?? "";
      this.write(backend.copyData(utf8.encode(`${line}\n`)));
    }
    this.write(backend.copyDone());
    this.write(backend.commandComplete(outcome.tag));
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
      if (!CLUSTER_DDL.test(text)) this.database.prepare(text);
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
   * The row shape of a statement that returns rows, for Describe on a statement.
   * `INSERT`/`UPDATE`/`DELETE ... RETURNING` is described from the catalog: a trial run binds
   * nulls and fails NOT NULL, and Describe would answer NoData. Bun then reads one DataRow cell
   * and treats the rest of the message as a broken protocol frame.
   * Other row-returning statements are a trial run with null parameters, rolled back. A trial
   * that fails is described as returning no data.
   */
  private async shapeOf(prepared: Prepared): Promise<TextResultSet | null> {
    const described = this.inSession(this.database, () => returningShape(this.database, prepared.sql));
    if (described) return described;
    if (!RETURNS_ROWS.test(prepared.sql)) return null;
    const db = this.database;
    await this.cluster.acquireTurn(this);
    try {
      const params = prepared.paramOids.map(() => null);
      return this.inSession(db, () => {
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
      });
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
    else {
      portal.cursor = portal.outcome.empty ? 0 : portal.outcome.result.rows.length;
      await this.acknowledged();
    }
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
