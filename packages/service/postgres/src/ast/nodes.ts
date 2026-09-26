/**
 * Discriminated-union AST. `type` tags are snake_case; interfaces PascalCase.
 * Identifier parts are stored case-folded (unquoted → lowercase) by the parser.
 */

// ---------------------------------------------------------------------------
// type names
// ---------------------------------------------------------------------------

export interface TypeName {
  /** qualified name parts, already case-folded */
  readonly parts: string[];
  /** typmod arguments, e.g. varchar(10) → [10]; numeric(10,2) → [10,2] */
  readonly mods: number[];
  /** number of array bracket pairs (0 = scalar) */
  readonly arrayDims: number;
  readonly setof?: boolean;
}

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

export type Expr =
  | NullLit
  | StringLit
  | NumberLit
  | BoolLit
  | BitStringLit
  | ParamRef
  | ColumnRef
  | StarExpr
  | BinaryOp
  | UnaryOp
  | CastExpr
  | CollateExpr
  | FuncCall
  | CaseExpr
  | SubqueryExpr
  | InExpr
  | BetweenExpr
  | IsNullExpr
  | BoolTest
  | IsDistinctExpr
  | RowExpr
  | ArrayCtor
  | ArrayQueryCtor
  | SubscriptExpr
  | FieldSelect
  | AtTimeZone
  | LikeExpr
  | PositionExpr
  | SubstringExpr
  | OverlayExpr
  | TrimExpr
  | ExtractExpr
  | GroupingFunc
  | DefaultExpr;

export interface NullLit {
  readonly type: "null_lit";
}
export interface StringLit {
  readonly type: "string_lit";
  readonly value: string;
}
export interface NumberLit {
  readonly type: "number_lit";
  /** raw literal text (underscores stripped) */
  readonly raw: string;
}
export interface BoolLit {
  readonly type: "bool_lit";
  readonly value: boolean;
}
export interface BitStringLit {
  readonly type: "bitstring_lit";
  /** leading 'b' or 'x' + digits */
  readonly value: string;
}
export interface ParamRef {
  readonly type: "param";
  readonly index: number; // 1-based
}
export interface ColumnRef {
  readonly type: "colref";
  /** [col] | [table, col] | [schema, table, col] */
  readonly parts: string[];
}
export interface StarExpr {
  readonly type: "star";
  /** qualified prefix for t.* */
  readonly table?: string[];
}
export interface BinaryOp {
  readonly type: "binop";
  readonly op: string;
  readonly left: Expr;
  readonly right: Expr;
}
export interface UnaryOp {
  readonly type: "unop";
  readonly op: string;
  readonly operand: Expr;
}
export interface CastExpr {
  readonly type: "cast";
  readonly expr: Expr;
  readonly target: TypeName;
}
export interface CollateExpr {
  readonly type: "collate";
  readonly expr: Expr;
  readonly collation: string[];
}

export interface OrderByItem {
  readonly expr: Expr;
  readonly dir: "asc" | "desc" | null;
  readonly nulls: "first" | "last" | null;
  readonly using?: string;
}

export interface WindowSpec {
  readonly name?: string; // reference to named window
  readonly partitionBy: Expr[];
  readonly orderBy: OrderByItem[];
  readonly frame: FrameSpec | null;
}

export interface FrameSpec {
  readonly mode: "range" | "rows" | "groups";
  readonly start: FrameBound;
  readonly end: FrameBound | null;
  readonly exclusion: "current_row" | "group" | "ties" | "no_others" | null;
}

export interface FrameBound {
  readonly kind: "unbounded_preceding" | "preceding" | "current_row" | "following" | "unbounded_following";
  readonly offset?: Expr;
}

export interface FuncCall {
  readonly type: "func";
  readonly name: string[];
  readonly args: Expr[];
  readonly star?: boolean; // count(*)
  readonly distinct?: boolean;
  readonly orderBy?: OrderByItem[]; // aggregate ORDER BY
  readonly filter?: Expr;
  readonly withinGroupOrderBy?: OrderByItem[];
  readonly over?: WindowSpec | null;
  readonly variadic?: boolean;
  /** parallel to args; non-null entries are named-notation argument names (f(a => 1)) */
  readonly argNames?: (string | null)[];
}
export interface CaseExpr {
  readonly type: "case";
  readonly operand: Expr | null;
  readonly whens: ReadonlyArray<{ when: Expr; then: Expr }>;
  readonly elseExpr: Expr | null;
}
export interface SubqueryExpr {
  readonly type: "subquery_expr";
  readonly kind: "scalar" | "exists" | "any" | "all";
  /** comparison operator for ANY/ALL */
  readonly op?: string;
  readonly left?: Expr;
  readonly query: SelectStmt;
  readonly not?: boolean; // NOT EXISTS
}
export interface InExpr {
  readonly type: "in_expr";
  readonly left: Expr;
  readonly not: boolean;
  readonly list?: Expr[];
  readonly query?: SelectStmt;
}
export interface BetweenExpr {
  readonly type: "between";
  readonly left: Expr;
  readonly low: Expr;
  readonly high: Expr;
  readonly not: boolean;
  readonly symmetric: boolean;
}
export interface IsNullExpr {
  readonly type: "is_null";
  readonly expr: Expr;
  readonly not: boolean;
}
export interface BoolTest {
  readonly type: "bool_test";
  readonly expr: Expr;
  readonly test: "true" | "false" | "unknown";
  readonly not: boolean;
}
export interface IsDistinctExpr {
  readonly type: "is_distinct";
  readonly left: Expr;
  readonly right: Expr;
  readonly not: boolean; // true => IS NOT DISTINCT FROM
}
export interface RowExpr {
  readonly type: "row";
  readonly items: Expr[];
  readonly explicit: boolean; // ROW(...) vs (a, b)
}
export interface ArrayCtor {
  readonly type: "array_ctor";
  readonly items: Expr[];
}
export interface ArrayQueryCtor {
  readonly type: "array_query";
  readonly query: SelectStmt;
}
export interface SubscriptExpr {
  readonly type: "subscript";
  readonly base: Expr;
  readonly indexes: ReadonlyArray<{ lower: Expr | null; upper: Expr | null; slice: boolean }>;
}
export interface FieldSelect {
  readonly type: "field_select";
  readonly base: Expr;
  readonly field: string | "*";
}
export interface AtTimeZone {
  readonly type: "at_time_zone";
  readonly expr: Expr;
  readonly zone: Expr;
}
export interface LikeExpr {
  readonly type: "like";
  readonly kind: "like" | "ilike" | "similar";
  readonly left: Expr;
  readonly pattern: Expr;
  readonly escape: Expr | null;
  readonly not: boolean;
}
export interface PositionExpr {
  readonly type: "position";
  readonly needle: Expr;
  readonly haystack: Expr;
}
export interface SubstringExpr {
  readonly type: "substring_sql";
  readonly source: Expr;
  readonly from: Expr | null;
  readonly forLen: Expr | null;
  readonly similar: Expr | null; // SUBSTRING(x SIMILAR p ESCAPE e) / FROM p FOR e regex form
  readonly escape: Expr | null;
}
export interface OverlayExpr {
  readonly type: "overlay";
  readonly source: Expr;
  readonly placing: Expr;
  readonly from: Expr;
  readonly forLen: Expr | null;
}
export interface TrimExpr {
  readonly type: "trim";
  readonly side: "both" | "leading" | "trailing";
  readonly chars: Expr | null;
  readonly source: Expr;
}
export interface ExtractExpr {
  readonly type: "extract";
  readonly field: string;
  readonly source: Expr;
}
export interface GroupingFunc {
  readonly type: "grouping_func";
  readonly args: Expr[];
}
export interface DefaultExpr {
  readonly type: "default_expr";
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

export interface WithClause {
  readonly recursive: boolean;
  readonly ctes: CommonTableExpr[];
}

export interface CommonTableExpr {
  readonly name: string;
  readonly columns: string[] | null;
  readonly query: Statement; // select / insert / update / delete (data-modifying CTE)
  readonly materialized: boolean | null; // null = default
  /** SEARCH / CYCLE clauses are not supported (parser rejects) */
}

export type SelectBody = SelectCore | SetOp | ValuesBody;

export interface SetOp {
  readonly type: "setop";
  readonly op: "union" | "intersect" | "except";
  readonly all: boolean;
  readonly left: SelectBody;
  readonly right: SelectBody;
}

export interface ValuesBody {
  readonly type: "values";
  readonly rows: Expr[][];
}

export interface SelectTarget {
  readonly expr: Expr;
  readonly alias: string | null;
}

export type GroupItem =
  | { kind: "expr"; expr: Expr }
  | { kind: "rollup" | "cube"; items: Expr[][] }
  | { kind: "grouping_sets"; sets: GroupItem[][] }
  | { kind: "empty" };

export interface SelectCore {
  readonly type: "select_core";
  readonly distinct: { on: Expr[] | null } | null; // {on:null} = DISTINCT, {on:[..]} = DISTINCT ON
  readonly targets: SelectTarget[];
  readonly from: FromItem[];
  readonly where: Expr | null;
  readonly groupBy: GroupItem[] | null;
  readonly groupDistinct: boolean;
  readonly having: Expr | null;
  readonly windows: ReadonlyArray<{ name: string; spec: WindowSpec }>;
}

export type FromItem = FromTable | FromSubquery | FromFunc | FromJoin;

export interface FromTable {
  readonly type: "from_table";
  readonly name: string[];
  readonly only: boolean;
  readonly alias: string | null;
  readonly colAliases: string[] | null;
}
export interface FromSubquery {
  readonly type: "from_subquery";
  readonly query: SelectStmt;
  readonly lateral: boolean;
  readonly alias: string | null;
  readonly colAliases: string[] | null;
}
export interface FromFunc {
  readonly type: "from_func";
  readonly call: Expr;
  readonly lateral: boolean;
  readonly withOrdinality: boolean;
  readonly alias: string | null;
  readonly colAliases: string[] | null;
  /** ROWS FROM (f1(), f2()) */
  readonly rowsFrom: Expr[] | null;
}
export interface FromJoin {
  readonly type: "from_join";
  readonly kind: "inner" | "left" | "right" | "full" | "cross";
  readonly left: FromItem;
  readonly right: FromItem;
  readonly on: Expr | null;
  readonly using: string[] | null;
  readonly usingAlias: string | null;
  readonly natural: boolean;
}

export interface SelectStmt {
  readonly type: "select";
  readonly with: WithClause | null;
  readonly body: SelectBody;
  readonly orderBy: OrderByItem[];
  readonly limit: Expr | null; // LIMIT ALL => null
  /** FETCH FIRST n ROWS WITH TIES */
  readonly limitWithTies: boolean;
  readonly offset: Expr | null;
  readonly lockingClause: string | null; // FOR UPDATE etc (accepted, no-op)
}

// ---------------------------------------------------------------------------
// DML
// ---------------------------------------------------------------------------

export interface InsertStmt {
  readonly type: "insert";
  readonly with: WithClause | null;
  readonly table: string[];
  readonly alias: string | null;
  readonly columns: string[] | null;
  readonly overriding: "system" | "user" | null;
  readonly source: SelectStmt | "default_values";
  readonly onConflict: OnConflictClause | null;
  readonly returning: SelectTarget[] | null;
}

export interface OnConflictClause {
  readonly target: { columns: Expr[]; where: Expr | null } | { constraint: string } | null;
  readonly action: "nothing" | { sets: UpdateSet[]; where: Expr | null };
}

export interface UpdateSet {
  readonly columns: ReadonlyArray<{ name: string; subscripts: SubscriptExpr["indexes"] | null; fields: string[] }>;
  readonly value: Expr | { kind: "row_subquery"; query: SelectStmt } | { kind: "row_values"; items: Expr[] };
}

export interface UpdateStmt {
  readonly type: "update";
  readonly with: WithClause | null;
  readonly table: string[];
  readonly only: boolean;
  readonly alias: string | null;
  readonly sets: UpdateSet[];
  readonly from: FromItem[];
  readonly where: Expr | null;
  readonly whereCurrentOf: string | null;
  readonly returning: SelectTarget[] | null;
}

export interface DeleteStmt {
  readonly type: "delete";
  readonly with: WithClause | null;
  readonly table: string[];
  readonly only: boolean;
  readonly alias: string | null;
  readonly using: FromItem[];
  readonly where: Expr | null;
  readonly returning: SelectTarget[] | null;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export type ColumnConstraint =
  | { kind: "not_null"; name: string | null }
  | { kind: "null"; name: string | null }
  | { kind: "default"; expr: Expr; name: string | null }
  | { kind: "primary_key"; name: string | null }
  | { kind: "unique"; name: string | null; nullsNotDistinct: boolean }
  | { kind: "check"; expr: Expr; name: string | null; noInherit: boolean }
  | {
      kind: "references";
      name: string | null;
      table: string[];
      columns: string[] | null;
      onDelete: RefAction;
      onUpdate: RefAction;
      match: "full" | "partial" | "simple" | null;
    }
  | { kind: "generated_identity"; always: boolean; name: string | null; options: SequenceOptions }
  | { kind: "generated_stored"; expr: Expr; name: string | null }
  | { kind: "collate"; collation: string[] };

export type RefAction = "no_action" | "restrict" | "cascade" | "set_null" | "set_default" | null;

export interface ColumnDef {
  readonly name: string;
  readonly typeName: TypeName;
  readonly constraints: ColumnConstraint[];
}

export type TableConstraint =
  | { kind: "primary_key"; name: string | null; columns: string[] }
  | { kind: "unique"; name: string | null; columns: string[]; nullsNotDistinct: boolean }
  | { kind: "check"; name: string | null; expr: Expr; noInherit: boolean }
  | {
      kind: "foreign_key";
      name: string | null;
      columns: string[];
      refTable: string[];
      refColumns: string[] | null;
      onDelete: RefAction;
      onUpdate: RefAction;
      match: "full" | "partial" | "simple" | null;
    }
  | { kind: "exclude"; name: string | null };

export interface CreateTableStmt {
  readonly type: "create_table";
  readonly name: string[];
  readonly ifNotExists: boolean;
  readonly temp: boolean;
  readonly unlogged: boolean;
  readonly columns: ColumnDef[];
  readonly constraints: TableConstraint[];
  readonly likeClauses: ReadonlyArray<{ table: string[]; options: string[] }>;
}

export interface CreateTableAsStmt {
  readonly type: "create_table_as";
  readonly name: string[];
  readonly ifNotExists: boolean;
  readonly temp: boolean;
  readonly columns: string[] | null;
  readonly query: SelectStmt;
  readonly withData: boolean;
  readonly materialized: boolean; // CREATE MATERIALIZED VIEW handled separately
}

export interface CreateIndexStmt {
  readonly type: "create_index";
  readonly unique: boolean;
  readonly name: string | null;
  readonly ifNotExists: boolean;
  readonly table: string[];
  readonly using: string | null;
  readonly columns: ReadonlyArray<{
    expr: Expr;
    dir: "asc" | "desc" | null;
    nulls: "first" | "last" | null;
    opclass: string | null;
  }>;
  readonly include: string[];
  readonly where: Expr | null;
  readonly nullsNotDistinct: boolean;
  readonly concurrently: boolean;
}

export interface CreateViewStmt {
  readonly type: "create_view";
  readonly name: string[];
  readonly orReplace: boolean;
  readonly temp: boolean;
  readonly columns: string[] | null;
  readonly query: SelectStmt;
  readonly materialized: boolean;
  readonly withData: boolean;
}

export interface SequenceOptions {
  increment?: bigint;
  minValue?: bigint | "no";
  maxValue?: bigint | "no";
  start?: bigint;
  cache?: bigint;
  cycle?: boolean;
  ownedBy?: string[] | "none";
  as?: TypeName;
  restart?: bigint | "default";
}

export interface CreateSequenceStmt {
  readonly type: "create_sequence";
  readonly name: string[];
  readonly ifNotExists: boolean;
  readonly temp: boolean;
  readonly options: SequenceOptions;
}

export interface AlterSequenceStmt {
  readonly type: "alter_sequence";
  readonly name: string[];
  readonly ifExists: boolean;
  readonly options: SequenceOptions;
}

export interface CreateSchemaStmt {
  readonly type: "create_schema";
  readonly name: string;
  readonly ifNotExists: boolean;
}

export interface CreateEnumStmt {
  readonly type: "create_enum";
  readonly name: string[];
  readonly labels: string[];
}

export interface AlterEnumStmt {
  readonly type: "alter_enum";
  readonly name: string[];
  readonly action:
    | { kind: "add_value"; label: string; ifNotExists: boolean; before: string | null; after: string | null }
    | { kind: "rename_value"; from: string; to: string };
}

export interface CreateDomainStmt {
  readonly type: "create_domain";
  readonly name: string[];
  readonly baseType: TypeName;
  readonly notNull: boolean;
  readonly defaultExpr: Expr | null;
  readonly checks: ReadonlyArray<{ name: string | null; expr: Expr }>;
  readonly collate: string[] | null;
}

export interface CreateFunctionStmt {
  readonly type: "create_function";
  readonly orReplace: boolean;
  readonly name: string[];
  readonly args: ReadonlyArray<{
    name: string | null;
    typeName: TypeName;
    mode: "in" | "out" | "inout" | "variadic";
    defaultExpr: Expr | null;
  }>;
  readonly returns: TypeName | null;
  readonly returnsTable: ReadonlyArray<{ name: string; typeName: TypeName }> | null;
  readonly language: string;
  readonly body: string | null; // AS 'body'
  readonly sqlBody: Statement[] | null; // BEGIN ATOMIC ... END or RETURN expr
  readonly volatility: "immutable" | "stable" | "volatile" | null;
  readonly strict: boolean;
}

export interface CreateTriggerStmt {
  readonly type: "create_trigger";
  readonly orReplace: boolean;
  readonly name: string;
  readonly timing: "before" | "after" | "instead_of";
  readonly events: ReadonlyArray<{ event: "insert" | "update" | "delete" | "truncate"; columns: string[] | null }>;
  readonly table: string[];
  readonly forEachRow: boolean;
  readonly when: Expr | null;
  readonly funcName: string[];
  readonly funcArgs: string[];
}

export type AlterTableAction =
  | { kind: "add_column"; column: ColumnDef; ifNotExists: boolean }
  | { kind: "drop_column"; name: string; ifExists: boolean; cascade: boolean }
  | { kind: "alter_type"; column: string; typeName: TypeName; using: Expr | null }
  | { kind: "set_default"; column: string; expr: Expr }
  | { kind: "drop_default"; column: string }
  | { kind: "set_not_null"; column: string }
  | { kind: "drop_not_null"; column: string }
  | { kind: "add_constraint"; constraint: TableConstraint; skipValidation: boolean }
  | { kind: "drop_constraint"; name: string; ifExists: boolean; cascade: boolean }
  | { kind: "rename_column"; from: string; to: string }
  | { kind: "rename_constraint"; from: string; to: string }
  | { kind: "rename_table"; to: string }
  | { kind: "set_schema"; to: string }
  | { kind: "owner_to"; role: string }
  | { kind: "add_identity"; column: string; always: boolean; options: SequenceOptions }
  | { kind: "drop_identity"; column: string; ifExists: boolean }
  | { kind: "validate_constraint"; name: string }
  | { kind: "reloptions" };

export interface AlterTableStmt {
  readonly type: "alter_table";
  readonly table: string[];
  readonly ifExists: boolean;
  readonly only: boolean;
  readonly actions: AlterTableAction[];
}

export interface AlterViewStmt {
  readonly type: "alter_view";
  readonly name: string[];
  readonly ifExists: boolean;
  readonly action: { kind: "rename_table"; to: string } | { kind: "set_schema"; to: string };
}

export interface AlterIndexStmt {
  readonly type: "alter_index";
  readonly name: string[];
  readonly ifExists: boolean;
  readonly action: { kind: "rename_table"; to: string };
}

export interface AlterSchemaStmt {
  readonly type: "alter_schema";
  readonly name: string;
  readonly action: { kind: "rename"; to: string };
}

export interface DropStmt {
  readonly type: "drop";
  readonly kind:
    | "table"
    | "view"
    | "materialized_view"
    | "index"
    | "sequence"
    | "schema"
    | "type"
    | "domain"
    | "function"
    | "trigger"
    | "extension";
  readonly names: string[][];
  /** for DROP TRIGGER name ON table */
  readonly onTable: string[] | null;
  /** for DROP FUNCTION name(argtypes) */
  readonly funcArgs: TypeName[][] | null;
  readonly ifExists: boolean;
  readonly cascade: boolean;
}

export interface TruncateStmt {
  readonly type: "truncate";
  readonly tables: string[][];
  readonly restartIdentity: boolean;
  readonly cascade: boolean;
}

export interface RefreshMaterializedViewStmt {
  readonly type: "refresh_materialized_view";
  readonly name: string[];
  readonly withData: boolean;
}

// ---------------------------------------------------------------------------
// transactions / session
// ---------------------------------------------------------------------------

export interface TransactionStmt {
  readonly type: "transaction";
  readonly action: "begin" | "commit" | "rollback" | "savepoint" | "release" | "rollback_to";
  readonly savepointName?: string;
  /** BEGIN ISOLATION LEVEL ... (accepted, single-session engine) */
  readonly modes?: string[];
  /** COMMIT/ROLLBACK AND CHAIN */
  readonly chain?: boolean;
}

export interface SetStmt {
  readonly type: "set";
  readonly name: string;
  readonly value: string | null; // null => DEFAULT
  readonly local: boolean;
}

export interface ShowStmt {
  readonly type: "show";
  readonly name: string; // "all" for SHOW ALL
}

export interface ResetStmt {
  readonly type: "reset";
  readonly name: string; // "all" for RESET ALL
}

export interface PrepareStmt {
  readonly type: "prepare";
  readonly name: string;
  readonly argTypes: TypeName[] | null;
  readonly query: Statement;
}

export interface ExecuteStmt {
  readonly type: "execute";
  readonly name: string;
  readonly params: Expr[];
}

export interface DeallocateStmt {
  readonly type: "deallocate";
  readonly name: string | null; // null => ALL
}

export interface ExplainStmt {
  readonly type: "explain";
  readonly analyze: boolean;
  readonly verbose: boolean;
  readonly query: Statement;
}

export interface CopyStmt {
  readonly type: "copy";
  readonly table: string[] | null;
  readonly columns: string[] | null;
  readonly query: Statement | null;
  readonly direction: "from" | "to";
  readonly target: "stdin" | "stdout";
  readonly options: Record<string, string | boolean>;
}

export interface CommentStmt {
  readonly type: "comment";
  readonly objectKind: string;
  readonly objectName: string[];
  readonly comment: string | null;
}

export interface NoOpStmt {
  readonly type: "no_op";
  readonly what: string; // GRANT / REVOKE / VACUUM / ANALYZE / CHECKPOINT / LISTEN...
}

export interface DoStmt {
  readonly type: "do";
  readonly language: string;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// statement union
// ---------------------------------------------------------------------------

export type Statement =
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | CreateTableStmt
  | CreateTableAsStmt
  | CreateIndexStmt
  | CreateViewStmt
  | CreateSequenceStmt
  | AlterSequenceStmt
  | CreateSchemaStmt
  | CreateEnumStmt
  | AlterEnumStmt
  | CreateDomainStmt
  | CreateFunctionStmt
  | CreateTriggerStmt
  | AlterTableStmt
  | AlterViewStmt
  | AlterIndexStmt
  | AlterSchemaStmt
  | DropStmt
  | TruncateStmt
  | RefreshMaterializedViewStmt
  | TransactionStmt
  | SetStmt
  | ShowStmt
  | ResetStmt
  | PrepareStmt
  | ExecuteStmt
  | DeallocateStmt
  | ExplainStmt
  | CopyStmt
  | CommentStmt
  | NoOpStmt
  | DoStmt;
