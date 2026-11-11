/**
 * The relational model, declared once. Both database implementations (PostgreSQL and the
 * in-memory one used on loopback and in tests) are generic over this description, so the
 * domain logic above them is written once and behaves the same on either.
 */

export type ColumnType = "text" | "timestamp" | "json" | "integer"
export type Column = { type: ColumnType; nullable?: true }

export type TableSpec = {
  columns: Record<string, Column>
  /** Each entry is one unique constraint over those columns. `id` is always the primary key. */
  unique?: readonly (readonly string[])[]
  /** Columns the API looks rows up by. */
  indexes?: readonly (readonly string[])[]
}

const text = { type: "text" } as const
const optionalText = { type: "text", nullable: true } as const
const timestamp = { type: "timestamp" } as const
const optionalTimestamp = { type: "timestamp", nullable: true } as const
const integer = { type: "integer" } as const
const json = { type: "json" } as const

export const TABLES = {
  users: {
    columns: {
      id: text,
      issuer: text,
      subject: text,
      email: optionalText,
      name: optionalText,
      created_at: timestamp,
    },
    unique: [["issuer", "subject"]],
  },
  sessions: {
    columns: {
      id: text,
      token_hash: text,
      user_id: text,
      expires_at: timestamp,
      created_at: timestamp,
    },
    unique: [["token_hash"]],
    indexes: [["user_id"]],
  },
  auth_transactions: {
    columns: { id: text, nonce: text, verifier: text, return_to: text, expires_at: timestamp },
  },
  orgs: {
    columns: {
      id: text,
      slug: text,
      name: text,
      /** Per-organization overrides of the default quotas, set by the operator. */
      limits: json,
      /**
       * The `mockingbird.yaml` last applied (`{ declaration, appliedAt, appliedBy }`), or JSON
       * null when the organization is configured by hand.
       */
      manifest: json,
      /** Why the organization is suspended; null when it is not. */
      suspended: optionalText,
      created_at: timestamp,
    },
    unique: [["slug"]],
  },
  memberships: {
    columns: { id: text, org_id: text, user_id: text, role: text, created_at: timestamp },
    unique: [["org_id", "user_id"]],
    indexes: [["user_id"]],
  },
  invites: {
    columns: {
      id: text,
      org_id: text,
      email: text,
      role: text,
      token_hash: text,
      invited_by: text,
      expires_at: timestamp,
      created_at: timestamp,
    },
    unique: [["token_hash"]],
    indexes: [["org_id"]],
  },
  projects: {
    columns: { id: text, org_id: text, slug: text, name: text, created_at: timestamp },
    unique: [["org_id", "slug"]],
  },
  fleets: {
    columns: {
      id: text,
      org_id: text,
      project_id: text,
      slug: text,
      name: text,
      access: text,
      emulators: json,
      /** Fleet-level options, e.g. `{ requestsPerMinute }`. */
      options: json,
      revision: text,
      created_at: timestamp,
      updated_at: timestamp,
    },
    unique: [["slug"]],
    indexes: [["project_id"], ["org_id"]],
  },
  api_keys: {
    columns: {
      id: text,
      scope: text,
      user_id: optionalText,
      org_id: optionalText,
      project_id: optionalText,
      role: optionalText,
      name: text,
      prefix: text,
      key_hash: text,
      created_by: text,
      last_used_at: optionalTimestamp,
      expires_at: optionalTimestamp,
      created_at: timestamp,
    },
    unique: [["key_hash"]],
    indexes: [["user_id"], ["org_id"], ["project_id"]],
  },
  /** Emulator requests served, one row per organization per UTC day. */
  usage: {
    columns: { id: text, org_id: text, day: text, requests: integer, created_at: timestamp },
    indexes: [["org_id"]],
  },
  audit: {
    columns: {
      id: text,
      org_id: text,
      actor: text,
      action: text,
      target: text,
      created_at: timestamp,
    },
    indexes: [["org_id"]],
  },
} as const satisfies Record<string, TableSpec>

export type TableName = keyof typeof TABLES

type ValueOf<C extends Column> = C extends { type: "json" }
  ? unknown
  : C extends { type: "integer" }
    ? number
    : C extends { nullable: true }
      ? string | null
      : string

/** A row as the application sees it. Timestamps are ISO-8601 strings. */
export type Row<T extends TableName> = {
  -readonly [K in keyof (typeof TABLES)[T]["columns"]]: (typeof TABLES)[T]["columns"][K] extends Column
    ? ValueOf<(typeof TABLES)[T]["columns"][K]>
    : never
}

export type Where<T extends TableName> = Partial<Record<keyof Row<T>, string>>

/** A write broke a unique constraint. `constraint` is the columns, joined with `+`. */
export class UniqueViolation extends Error {
  constructor(
    readonly table: string,
    readonly constraint: string,
  ) {
    super(`duplicate ${table} ${constraint}`)
    this.name = "UniqueViolation"
  }
}

export interface Database {
  /** Create or upgrade the schema. Safe to call from several replicas at once. */
  migrate(): Promise<void>
  insert<T extends TableName>(table: T, row: Row<T>): Promise<void>
  get<T extends TableName>(table: T, id: string): Promise<Row<T> | undefined>
  /** Rows matching every given column, oldest first. */
  find<T extends TableName>(table: T, where: Where<T>): Promise<Row<T>[]>
  update<T extends TableName>(
    table: T,
    id: string,
    patch: Partial<Row<T>>,
    /** Update only while these columns still hold these values (optimistic concurrency). */
    ifMatch?: Where<T>,
  ): Promise<Row<T> | undefined>
  /**
   * Add `by` to an integer column, creating the row (with `by` as its value) when it does not
   * exist. Atomic, so several replicas can count into one row.
   */
  increment<T extends TableName>(
    table: T,
    row: Row<T>,
    column: keyof Row<T>,
    by: number,
  ): Promise<void>
  /** Delete matching rows and return how many went. An empty `where` is refused. */
  remove<T extends TableName>(table: T, where: Where<T>): Promise<number>
  /** Delete rows whose timestamp column is before `before`. */
  removeExpired<T extends TableName>(
    table: T,
    column: keyof Row<T>,
    before: string,
  ): Promise<number>
  ping(): Promise<void>
  close(): Promise<void>
}
