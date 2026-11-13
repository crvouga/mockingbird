import type { Relation, RelColumn } from "../executor/relation.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { Datum, TypeId } from "../types/value.ts";
import { AVAILABLE_EXTENSIONS, installedExtension, installedExtensions } from "./extensions.ts";

type ColSpec = readonly [name: string, type: TypeId];

function rel(specs: readonly ColSpec[], rows: Datum[][], table: string): Relation {
  const columns: RelColumn[] = specs.map(([name, type]) => ({ name, type, table }));
  return { columns, rows };
}

/** `pg_extension`: one row per installed extension. */
function pgExtension(state: DatabaseState, namespaceOid: (schema: string) => number): Relation {
  const rows: Datum[][] = installedExtensions(state).map((ext) => [
    ext.oid,
    ext.spec.name,
    10,
    namespaceOid(ext.schema),
    ext.spec.relocatable,
    ext.version,
    null,
    null,
  ]);
  return rel(
    [
      ["oid", "oid"],
      ["extname", "name"],
      ["extowner", "oid"],
      ["extnamespace", "oid"],
      ["extrelocatable", "bool"],
      ["extversion", "text"],
      ["extconfig", "oid[]"],
      ["extcondition", "text[]"],
    ],
    rows,
    "pg_extension",
  );
}

/** `pg_available_extensions`: one row per extension `CREATE EXTENSION` can install. */
function pgAvailableExtensions(state: DatabaseState): Relation {
  const rows: Datum[][] = AVAILABLE_EXTENSIONS.map((spec) => [
    spec.name,
    spec.defaultVersion,
    installedExtension(state, spec)?.version ?? null,
    spec.comment,
  ]);
  return rel(
    [
      ["name", "name"],
      ["default_version", "text"],
      ["installed_version", "text"],
      ["comment", "text"],
    ],
    rows,
    "pg_available_extensions",
  );
}

/** `pg_available_extension_versions`: one row per installable version. */
function pgAvailableExtensionVersions(state: DatabaseState): Relation {
  const rows: Datum[][] = [];
  for (const spec of AVAILABLE_EXTENSIONS) {
    const installed = installedExtension(state, spec);
    for (const version of spec.versions) {
      rows.push([
        spec.name,
        version,
        installed?.version === version,
        true,
        spec.trusted ?? true,
        spec.relocatable,
        spec.builtinSchema ?? null,
        null,
        spec.comment,
      ]);
    }
  }
  return rel(
    [
      ["name", "name"],
      ["version", "text"],
      ["installed", "bool"],
      ["superuser", "bool"],
      ["trusted", "bool"],
      ["relocatable", "bool"],
      ["schema", "name"],
      ["requires", "name[]"],
      ["comment", "text"],
    ],
    rows,
    "pg_available_extension_versions",
  );
}

export const EXTENSION_CATALOG_RELATIONS: readonly string[] = [
  "pg_extension",
  "pg_available_extensions",
  "pg_available_extension_versions",
];

/** Extension catalogs of `pg_catalog`, or null when `name` is not one of them. */
export function extensionCatalogRelation(
  state: DatabaseState,
  name: string,
  namespaceOid: (schema: string) => number,
): Relation | null {
  switch (name) {
    case "pg_extension":
      return pgExtension(state, namespaceOid);
    case "pg_available_extensions":
      return pgAvailableExtensions(state);
    case "pg_available_extension_versions":
      return pgAvailableExtensionVersions(state);
    default:
      return null;
  }
}
