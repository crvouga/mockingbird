/**
 * @packageDocumentation
 * Unstable internals for advanced tooling and the sqlite-mem test suite.
 *
 * **Exempt from semver.** Anything exported from `@crvouga/sqlite-mem/unstable`
 * may change or be removed in any release (including patch). Prefer the stable
 * entry `@crvouga/sqlite-mem` for application code.
 *
 * @module
 */

export type { Expr } from "./ast/nodes.ts";
export type { EvalContext } from "./expressions/context.ts";
export { evalExpr } from "./expressions/eval.ts";
export { globMatch, likeMatch } from "./expressions/like.ts";
export { type Token, type TokenKind, tokenize } from "./lexer/tokenize.ts";
export { type ParsedStatement, parse } from "./parser/index.ts";
export {
  type Clock,
  DEFAULT_DATABASE_SEED,
  DEFAULT_NOW,
  deriveSeed,
  fixedClock,
  OsEntropy,
  Prng,
  type RandomMode,
  resolveClock,
  systemClock,
} from "./runtime/index.ts";
export {
  type DecodedSnapshot,
  decodeDatabaseState,
  encodeDatabaseState,
  type SnapshotRuntime,
} from "./serialization/index.ts";
export type { DatabaseState } from "./storage/database-state.ts";
export {
  type Affinity,
  affinityFromTypeName,
  applyAffinity,
  asSqlJsonText,
  asSqlReal,
  canonicalizeNumber,
  cloneSqlValue,
  coerceToNumber,
  compareSql,
  isSqlJsonText,
  isSqlReal,
  isTruthySql,
  SqlJsonText,
  SqlReal,
  type SqlValue,
  type StorageClass,
  sqlValueEquals,
  storageClassOf,
  toInteger,
  typeofSql,
  utf8Decode,
  utf8Encode,
} from "./types/value.ts";
