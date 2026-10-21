import type { Relation } from "../executor/relation.ts";
import type { EngineCtx } from "../expressions/context.ts";

/**
 * Virtual pg_catalog / information_schema relations, materialized on demand.
 * Implemented in catalog-tables.ts; this indirection keeps the executor
 * import graph acyclic.
 */
export type CatalogBuilder = (ctx: EngineCtx, schema: string, name: string) => Relation | null;

let builder: CatalogBuilder | null = null;

export function setCatalogBuilder(b: CatalogBuilder): void {
  builder = b;
}

export function catalogRelation(ctx: EngineCtx, schema: string, name: string): Relation | null {
  if (schema !== "pg_catalog" && schema !== "information_schema") return null;
  return builder ? builder(ctx, schema, name) : null;
}

/** Relations resolvable unqualified via the implicit pg_catalog search-path entry. */
export const PG_CATALOG_RELATIONS: ReadonlySet<string> = new Set([
  "pg_namespace",
  "pg_class",
  "pg_attribute",
  "pg_type",
  "pg_proc",
  "pg_enum",
  "pg_constraint",
  "pg_index",
  "pg_am",
  "pg_extension",
  "pg_available_extensions",
  "pg_available_extension_versions",
  "pg_description",
  "pg_stat_user_tables",
  "pg_stat_user_indexes",
  "pg_sequence",
  "pg_sequences",
  "pg_tables",
  "pg_views",
  "pg_matviews",
  "pg_indexes",
  "pg_settings",
  "pg_database",
  "pg_roles",
  "pg_user",
  "pg_trigger",
  "pg_attrdef",
  "pg_depend",
  "pg_inherits",
  "pg_collation",
  "pg_opclass",
  "pg_authid",
  "pg_locks",
  "pg_stat_activity",
]);
