/**
 * PostgresError mirrors the shape a real PostgreSQL server reports:
 * a human message plus a five-character SQLSTATE code.
 *
 * `category` is a stable, coarse-grained enum for consumers that do not want
 * to switch on raw SQLSTATE codes. New categories may appear in minor
 * releases — always include a default case.
 */
export type ErrorCategory =
  | "syntax"
  | "undefined_table"
  | "undefined_column"
  | "undefined_function"
  | "undefined_object"
  | "duplicate_object"
  | "duplicate_table"
  | "duplicate_column"
  | "constraint_not_null"
  | "constraint_unique"
  | "constraint_check"
  | "constraint_foreign_key"
  | "constraint_exclusion"
  | "restrict_violation"
  | "invalid_text_representation"
  | "numeric_value_out_of_range"
  | "division_by_zero"
  | "datatype_mismatch"
  | "cannot_coerce"
  | "invalid_parameter_value"
  | "invalid_datetime"
  | "ambiguous_column"
  | "ambiguous_function"
  | "grouping_error"
  | "windowing_error"
  | "invalid_column_reference"
  | "wrong_object_type"
  | "dependent_objects"
  | "transaction_state"
  | "misuse"
  | "unsupported"
  | "internal"
  | "data_exception"
  | "program_limit_exceeded"
  | "invalid_cursor"
  | "snapshot_format"
  | "snapshot_version"
  | "string_data_right_truncation"
  | "invalid_regular_expression"
  | "case_not_found"
  | "cardinality_violation"
  | "undefined_parameter"
  | "not_null_violation"
  | "check_violation"
  | "array_subscript_error"
  | "array_element_error"
  | "invalid_escape_sequence"
  | "feature_not_supported"
  | "null_value_not_allowed"
  | "invalid_argument_for_power_function"
  | "invalid_argument_for_log"
  | "invalid_argument_for_width_bucket_function"
  | "sequence_generator_limit_exceeded"
  | "object_not_in_prerequisite_state"
  | "substring_error"
  | "invalid_table_definition"
  | "duplicate_schema"
  | "duplicate_function"
  | "generated_always"
  | "invalid_row_count"
  | "duplicate_prepared_statement"
  | "undefined_prepared_statement"
  | "invalid_savepoint_specification"
  | "raise_exception"
  | "invalid_function_definition";

const CATEGORY_TO_SQLSTATE: Record<ErrorCategory, string> = {
  syntax: "42601",
  undefined_table: "42P01",
  undefined_column: "42703",
  undefined_function: "42883",
  undefined_object: "42704",
  duplicate_object: "42710",
  duplicate_table: "42P07",
  duplicate_column: "42701",
  constraint_not_null: "23502",
  constraint_unique: "23505",
  constraint_check: "23514",
  constraint_foreign_key: "23503",
  constraint_exclusion: "23P01",
  restrict_violation: "23001",
  invalid_text_representation: "22P02",
  numeric_value_out_of_range: "22003",
  division_by_zero: "22012",
  datatype_mismatch: "42804",
  cannot_coerce: "42846",
  invalid_parameter_value: "22023",
  invalid_datetime: "22008",
  ambiguous_column: "42702",
  ambiguous_function: "42725",
  grouping_error: "42803",
  windowing_error: "42P20",
  invalid_column_reference: "42P10",
  wrong_object_type: "42809",
  dependent_objects: "2BP01",
  transaction_state: "25P01",
  misuse: "XX000",
  unsupported: "0A000",
  internal: "XX000",
  data_exception: "22000",
  program_limit_exceeded: "54000",
  invalid_cursor: "34000",
  snapshot_format: "XX001",
  snapshot_version: "XX002",
  string_data_right_truncation: "22001",
  invalid_regular_expression: "2201B",
  case_not_found: "20000",
  cardinality_violation: "21000",
  undefined_parameter: "42P02",
  not_null_violation: "23502",
  check_violation: "23514",
  array_subscript_error: "2202E",
  array_element_error: "2202E",
  invalid_escape_sequence: "22025",
  feature_not_supported: "0A000",
  null_value_not_allowed: "22004",
  invalid_argument_for_power_function: "2201F",
  invalid_argument_for_log: "2201E",
  invalid_argument_for_width_bucket_function: "2201G",
  sequence_generator_limit_exceeded: "2200H",
  object_not_in_prerequisite_state: "55000",
  substring_error: "22011",
  invalid_table_definition: "42P16",
  duplicate_schema: "42P06",
  duplicate_function: "42723",
  generated_always: "428C9",
  invalid_row_count: "2201W",
  duplicate_prepared_statement: "42P05",
  undefined_prepared_statement: "26000",
  invalid_savepoint_specification: "3B001",
  raise_exception: "P0001",
  invalid_function_definition: "2F005",
};

export class PostgresError extends Error {
  readonly category: ErrorCategory;
  /** Five-character SQLSTATE, e.g. "42P01". Always set. */
  readonly sqlState: string;
  /** Alias of sqlState (node-postgres `err.code` convention). */
  readonly code: string;

  constructor(category: ErrorCategory, message: string, sqlState?: string) {
    super(message);
    this.name = "PostgresError";
    this.category = category;
    this.sqlState = sqlState ?? CATEGORY_TO_SQLSTATE[category] ?? "XX000";
    this.code = this.sqlState;
  }
}

export function pgError(category: ErrorCategory, message: string, sqlState?: string): PostgresError {
  return new PostgresError(category, message, sqlState);
}

/**
 * SQL the oracle accepts but this engine has not implemented must fail loud,
 * never silently misbehave. The compat gate keys off this.
 */
export function unsupported(what: string): PostgresError {
  return new PostgresError("unsupported", `${what} is not supported`);
}

export function isPostgresError(err: unknown): err is PostgresError {
  return err instanceof PostgresError;
}
