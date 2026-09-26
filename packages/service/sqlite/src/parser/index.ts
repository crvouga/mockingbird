import type { Statement as ParsedStatement } from "../ast/nodes.ts";
import { tokenize } from "../lexer/tokenize.ts";
import { type ParsedUnit, parseTokenUnits } from "./parser.ts";

/** Parsed SQL statement AST (`SELECT`, `INSERT`, `CREATE TABLE`, …). */
export type { Statement as ParsedStatement } from "../ast/nodes.ts";
export type { ParsedUnit } from "./parser.ts";
export { parseTokens, parseTokenUnits } from "./parser.ts";

/**
 * Tokenize `sql` and parse every semicolon-separated statement.
 *
 * @param sql - SQLite SQL text.
 * @returns AST statements in source order.
 */
export function parse(sql: string): ParsedStatement[] {
  return parseUnits(sql).map((unit) => unit.statement);
}

/**
 * Parse SQL into AST + per-statement source slices (for `sqlite_master.sql`).
 */
export function parseUnits(sql: string): ParsedUnit[] {
  return parseTokenUnits(tokenize(sql), sql);
}
