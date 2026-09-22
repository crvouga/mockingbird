import type { SqlValue } from "../types/value.ts";

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "||"
  | "="
  | "=="
  | "!="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "AND"
  | "OR"
  | "IS"
  | "IS NOT"
  | "IS DISTINCT FROM"
  | "IS NOT DISTINCT FROM"
  | "LIKE"
  | "NOT LIKE"
  | "GLOB"
  | "NOT GLOB"
  | "IN"
  | "NOT IN"
  | "MATCH"
  | "->"
  | "->>"
  | "&"
  | "|"
  | "<<"
  | ">>";

export type UnaryOp = "+" | "-" | "~" | "NOT";

/** Parsed SQL expression AST (literals, operators, functions, subqueries, …). */
export type Expr =
  | LiteralExpr
  | NullExpr
  | ColumnRefExpr
  | UnaryExpr
  | BinaryExpr
  | BetweenExpr
  | InExpr
  | LikeExpr
  | IsBoolExpr
  | FunctionExpr
  | AggregateExpr
  | WindowExpr
  | CaseExpr
  | CastExpr
  | ExistsExpr
  | SubqueryExpr
  | ParameterExpr
  | RowExpr
  | CollateExpr;

export interface LiteralExpr {
  type: "literal";
  value: SqlValue;
  /** True when the literal was written with float syntax (e.g. 1.0) or must be REAL. */
  forceReal?: boolean;
}

export interface NullExpr {
  type: "null";
}

export interface ColumnRefExpr {
  type: "column";
  table: string | null;
  name: string;
}

export interface UnaryExpr {
  type: "unary";
  op: UnaryOp;
  expr: Expr;
}

export interface BinaryExpr {
  type: "binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

/** `expr IS [NOT] TRUE` / `expr IS [NOT] FALSE` (truthiness, not equality to 1/0). */
export interface IsBoolExpr {
  type: "is_bool";
  expr: Expr;
  not: boolean;
  /** `true` for TRUE, `false` for FALSE. */
  sense: boolean;
}

export interface BetweenExpr {
  type: "between";
  not: boolean;
  expr: Expr;
  lower: Expr;
  upper: Expr;
}

export interface InExpr {
  type: "in";
  not: boolean;
  expr: Expr;
  values: Expr[] | SelectStmt;
}

export interface LikeExpr {
  type: "like";
  not: boolean;
  op: "LIKE" | "GLOB";
  expr: Expr;
  pattern: Expr;
  escape: Expr | null;
}

export interface FunctionExpr {
  type: "function";
  name: string;
  distinct: boolean;
  args: Expr[] | "*";
  orderBy: OrderByItem[];
  filter: Expr | null;
}

export interface AggregateExpr {
  type: "aggregate";
  name: string;
  distinct: boolean;
  args: Expr[] | "*";
  orderBy: OrderByItem[];
  filter: Expr | null;
}

export interface WindowExpr {
  type: "window";
  func: FunctionExpr | AggregateExpr;
  window: WindowSpec;
}

export interface WindowSpec {
  partitionBy: Expr[];
  orderBy: OrderByItem[];
  frame: FrameSpec | null;
  /** Named window reference for `OVER window_name`. */
  ref?: string | null;
}

export interface FrameSpec {
  type: "ROWS" | "RANGE" | "GROUPS";
  start: FrameBound;
  end: FrameBound;
  exclude: "no_others" | "current_row" | "group" | "ties" | null;
}

export type FrameBound =
  | { kind: "unbounded_preceding" }
  | { kind: "unbounded_following" }
  | { kind: "current_row" }
  | { kind: "preceding"; expr: Expr }
  | { kind: "following"; expr: Expr };

export interface CaseExpr {
  type: "case";
  base: Expr | null;
  whens: { when: Expr; then: Expr }[];
  else: Expr | null;
}

export interface CastExpr {
  type: "cast";
  expr: Expr;
  typeName: string;
}

export interface ExistsExpr {
  type: "exists";
  not: boolean;
  select: SelectStmt;
}

export interface SubqueryExpr {
  type: "subquery";
  select: SelectStmt;
}

export interface ParameterExpr {
  type: "parameter";
  /** 1-based positional index, or named key */
  name: string | number;
}

export interface RowExpr {
  type: "row";
  values: Expr[];
}

export interface CollateExpr {
  type: "collate";
  expr: Expr;
  collation: string;
}

export interface OrderByItem {
  expr: Expr;
  dir: "ASC" | "DESC";
  nulls: "FIRST" | "LAST" | null;
}

export interface LimitClause {
  limit: Expr;
  offset: Expr | null;
}

export type Statement =
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | CreateTableStmt
  | DropTableStmt
  | AlterTableStmt
  | CreateIndexStmt
  | DropIndexStmt
  | CreateViewStmt
  | DropViewStmt
  | CreateTriggerStmt
  | DropTriggerStmt
  | BeginStmt
  | CommitStmt
  | RollbackStmt
  | SavepointStmt
  | ReleaseStmt
  | PragmaStmt
  | AttachStmt
  | DetachStmt
  | CreateVirtualTableStmt
  | ExplainStmt
  | AnalyzeStmt
  | ReindexStmt
  | VacuumStmt;

export interface AnalyzeStmt {
  type: "analyze";
  schema: string | null;
  name: string | null;
}

export interface ReindexStmt {
  type: "reindex";
  schema: string | null;
  name: string | null;
}

export interface VacuumStmt {
  type: "vacuum";
  schema: string | null;
  into: string | null;
}

export interface SelectStmt {
  type: "select";
  with: WithClause | null;
  distinct: boolean;
  columns: ResultColumn[];
  from: FromItem | null;
  where: Expr | null;
  groupBy: Expr[];
  having: Expr | null;
  windows: { name: string; spec: WindowSpec }[];
  orderBy: OrderByItem[];
  limit: LimitClause | null;
  compound: CompoundTail | null;
}

export interface CompoundTail {
  op: "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";
  select: SelectStmt;
}

export interface WithClause {
  recursive: boolean;
  ctes: Cte[];
}

export interface Cte {
  name: string;
  columns: string[] | null;
  materialized: "materialized" | "not_materialized" | null;
  select: SelectStmt;
}

export type ResultColumn = { type: "star"; table: string | null } | { type: "expr"; expr: Expr; alias: string | null };

export type FromItem = TableRef | JoinFrom | SubqueryFrom | TableFuncFrom;

export interface TableRef {
  type: "table";
  schema: string | null;
  name: string;
  alias: string | null;
}

export interface SubqueryFrom {
  type: "subquery";
  select: SelectStmt;
  alias: string;
}

export interface TableFuncFrom {
  type: "table_func";
  name: string;
  args: Expr[];
  alias: string | null;
}

export interface JoinFrom {
  type: "join";
  left: FromItem;
  right: FromItem;
  joinType: "CROSS" | "INNER" | "LEFT" | "RIGHT" | "FULL";
  on: Expr | null;
  using: string[] | null;
}

export interface InsertStmt {
  type: "insert";
  with: WithClause | null;
  mode:
    | "insert"
    | "replace"
    | "insert_or_replace"
    | "insert_or_ignore"
    | "insert_or_abort"
    | "insert_or_rollback"
    | "insert_or_fail";
  table: string;
  columns: string[] | null;
  values: Expr[][] | null;
  select: SelectStmt | null;
  upsert: UpsertClause | null;
  returning: ResultColumn[];
}

export interface UpsertClause {
  targetColumns: string[] | null;
  targetExprs: Expr[] | null;
  targetWhere: Expr | null;
  action: "nothing" | { set: SetItem[]; where: Expr | null };
}

export interface SetItem {
  columns: string[];
  expr: Expr;
}

export interface UpdateStmt {
  type: "update";
  with: WithClause | null;
  or: "replace" | "ignore" | "abort" | "rollback" | "fail" | null;
  table: string;
  alias: string | null;
  set: SetItem[];
  from: FromItem | null;
  where: Expr | null;
  returning: ResultColumn[];
}

export interface DeleteStmt {
  type: "delete";
  with: WithClause | null;
  or: "replace" | "ignore" | "abort" | "rollback" | "fail" | null;
  table: string;
  alias: string | null;
  where: Expr | null;
  returning: ResultColumn[];
}

export interface CreateTableStmt {
  type: "create_table";
  ifNotExists: boolean;
  temp: boolean;
  name: string;
  columns: ColumnDef[];
  constraints: TableConstraint[];
  asSelect: SelectStmt | null;
  withoutRowid: boolean;
  strict: boolean;
}

export interface ColumnDef {
  name: string;
  typeName: string | null;
  constraints: ColumnConstraint[];
}

export type ColumnConstraint =
  | { type: "primary_key"; order: "ASC" | "DESC" | null; autoincrement: boolean; conflict: ConflictAction | null }
  | { type: "not_null"; conflict: ConflictAction | null }
  | { type: "unique"; conflict: ConflictAction | null }
  | { type: "check"; expr: Expr }
  | { type: "default"; expr: Expr }
  | { type: "collate"; name: string }
  | {
      type: "references";
      table: string;
      columns: string[] | null;
      onDelete: FkAction | null;
      onUpdate: FkAction | null;
      match: FkMatch;
      deferrable: boolean;
      initiallyDeferred: boolean;
    }
  | { type: "generated"; expr: Expr; stored: boolean };

export type TableConstraint =
  | { type: "primary_key"; columns: IndexedColumn[]; conflict: ConflictAction | null }
  | { type: "unique"; columns: IndexedColumn[]; conflict: ConflictAction | null; name: string | null }
  | { type: "check"; expr: Expr; name: string | null }
  | {
      type: "foreign_key";
      columns: string[];
      refTable: string;
      refColumns: string[] | null;
      onDelete: FkAction | null;
      onUpdate: FkAction | null;
      match: FkMatch;
      name: string | null;
      deferrable: boolean;
      initiallyDeferred: boolean;
    };

export interface IndexedColumn {
  name: string;
  collate: string | null;
  order: "ASC" | "DESC" | null;
  /** Present when the index key is an expression rather than a bare column. */
  expr?: Expr | null;
}

export type ConflictAction = "ROLLBACK" | "ABORT" | "FAIL" | "IGNORE" | "REPLACE";
export type FkAction = "SET NULL" | "SET DEFAULT" | "CASCADE" | "RESTRICT" | "NO ACTION";
/** SQLite MATCH clause; FULL rejects partial-NULL composite keys. PARTIAL is accepted as SIMPLE. */
export type FkMatch = "SIMPLE" | "FULL" | "PARTIAL";

export interface DropTableStmt {
  type: "drop_table";
  ifExists: boolean;
  name: string;
}

export interface AlterTableStmt {
  type: "alter_table";
  table: string;
  action:
    | { kind: "rename_table"; newName: string }
    | { kind: "rename_column"; oldName: string; newName: string }
    | { kind: "add_column"; column: ColumnDef }
    | { kind: "drop_column"; name: string };
}

export interface CreateIndexStmt {
  type: "create_index";
  unique: boolean;
  ifNotExists: boolean;
  name: string;
  table: string;
  columns: IndexedColumn[];
  where: Expr | null;
}

export interface DropIndexStmt {
  type: "drop_index";
  ifExists: boolean;
  name: string;
}

export interface CreateViewStmt {
  type: "create_view";
  ifNotExists: boolean;
  temp: boolean;
  name: string;
  columns: string[] | null;
  select: SelectStmt;
}

export interface DropViewStmt {
  type: "drop_view";
  ifExists: boolean;
  name: string;
}

export interface CreateTriggerStmt {
  type: "create_trigger";
  ifNotExists: boolean;
  temp: boolean;
  name: string;
  timing: "BEFORE" | "AFTER" | "INSTEAD";
  event: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  updateColumns: string[] | null;
  forEachRow: boolean;
  when: Expr | null;
  body: Statement[];
}

export interface DropTriggerStmt {
  type: "drop_trigger";
  ifExists: boolean;
  name: string;
}

export interface CreateVirtualTableStmt {
  type: "create_virtual_table";
  ifNotExists: boolean;
  name: string;
  module: string;
  moduleArgs: string[];
}

export interface BeginStmt {
  type: "begin";
  mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE" | null;
}

export interface CommitStmt {
  type: "commit";
}

export interface RollbackStmt {
  type: "rollback";
  savepoint: string | null;
}

export interface SavepointStmt {
  type: "savepoint";
  name: string;
}

export interface ReleaseStmt {
  type: "release";
  name: string;
}

export interface PragmaStmt {
  type: "pragma";
  name: string;
  value: Expr | null;
}

export interface AttachStmt {
  type: "attach";
  filename: Expr;
  schema: string;
}

export interface DetachStmt {
  type: "detach";
  schema: string;
}

export interface ExplainStmt {
  type: "explain";
  queryPlan: boolean;
  statement: Statement;
}
