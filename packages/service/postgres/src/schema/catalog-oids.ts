/**
 * Object identifiers of the virtual catalog relations, so `'pg_class'::regclass` and
 * `to_regclass('information_schema.tables')` resolve and print. The base catalogs carry the oids
 * PostgreSQL 18 assigns them (they are fixed in the catalog headers); the views and the
 * information_schema relations are numbered after the oids a stock server gives its first system
 * views, which PostgreSQL itself does not pin across builds.
 */
const PG_CATALOG_OIDS: ReadonlyArray<readonly [name: string, oid: number]> = [
  ["pg_attribute", 1249],
  ["pg_type", 1247],
  ["pg_proc", 1255],
  ["pg_class", 1259],
  ["pg_authid", 1260],
  ["pg_database", 1262],
  ["pg_sequence", 2224],
  ["pg_am", 2601],
  ["pg_attrdef", 2604],
  ["pg_constraint", 2606],
  ["pg_depend", 2608],
  ["pg_description", 2609],
  ["pg_index", 2610],
  ["pg_inherits", 2611],
  ["pg_namespace", 2615],
  ["pg_opclass", 2616],
  ["pg_trigger", 2620],
  ["pg_extension", 3079],
  ["pg_collation", 3456],
  ["pg_enum", 3501],
  ["pg_roles", 12000],
  ["pg_user", 12014],
  ["pg_tables", 12033],
  ["pg_views", 12028],
  ["pg_matviews", 12038],
  ["pg_indexes", 12043],
  ["pg_sequences", 12048],
  ["pg_locks", 12073],
  ["pg_available_extensions", 12081],
  ["pg_available_extension_versions", 12085],
  ["pg_settings", 12104],
  ["pg_stat_user_tables", 12165],
  ["pg_stat_user_indexes", 12196],
  ["pg_stat_activity", 12226],
];

const INFORMATION_SCHEMA_NAMES: readonly string[] = [
  "schemata",
  "tables",
  "columns",
  "views",
  "sequences",
  "table_constraints",
  "key_column_usage",
  "routines",
];

const byKey = new Map<string, number>();
const byOid = new Map<number, readonly [schema: string, name: string]>();

for (const [name, oid] of PG_CATALOG_OIDS) {
  byKey.set(`pg_catalog.${name}`, oid);
  byOid.set(oid, ["pg_catalog", name]);
}
INFORMATION_SCHEMA_NAMES.forEach((name, index) => {
  const oid = 13300 + index;
  byKey.set(`information_schema.${name}`, oid);
  byOid.set(oid, ["information_schema", name]);
});

/** The oid of a catalog relation, or null when the engine has no such relation. */
export function catalogRelationOid(schema: string, name: string): number | null {
  return byKey.get(`${schema}.${name}`) ?? null;
}

/** The schema and name of the catalog relation with this oid, or null. */
export function catalogRelationByOid(oid: number): readonly [schema: string, name: string] | null {
  return byOid.get(oid) ?? null;
}

/** Every catalog relation with an oid, for `pg_class`-style listings. */
export function catalogRelationNames(): ReadonlyArray<readonly [schema: string, name: string]> {
  return [...byOid.values()];
}
