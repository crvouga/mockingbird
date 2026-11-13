import {
  type CatalogExt,
  type CompositeTypeData,
  type DbRoleSetting,
  EMPTY_CATALOG_EXT,
  type EventTriggerData,
  type RoleData,
  type TableExt,
} from "../storage/catalog-ext.ts";

/**
 * {@link CatalogExt} (roles, privileges, composite types, event triggers, partitioning and
 * row-level security) as a BJV value for the snapshot trailer, and back. A catalog with nothing of
 * these beyond the built-in roles encodes to null, so its snapshot bytes are unchanged.
 */

interface CatalogExtBjv {
  roles: RoleData[];
  memberships: CatalogExt["memberships"];
  grants: CatalogExt["grants"];
  composites: CompositeTypeData[];
  tables: Array<TableExt & { oid: number }>;
  eventTriggers: EventTriggerData[];
  dbRoleSettings?: DbRoleSetting[];
}

/** Drop `undefined` members (BJV would turn them into null). */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = plain(v);
  return out;
}

function toBjv(ext: CatalogExt): CatalogExtBjv {
  return plain({
    roles: [...ext.roles.values()],
    memberships: ext.memberships,
    grants: ext.grants,
    composites: [...ext.composites.values()],
    tables: [...ext.tables].map(([oid, t]) => ({ oid, ...t })),
    eventTriggers: [...ext.eventTriggers.values()],
    // only when present, so a catalog without any encodes as before
    ...(ext.dbRoleSettings?.length ? { dbRoleSettings: ext.dbRoleSettings } : {}),
  }) as CatalogExtBjv;
}

const EMPTY_TEXT = JSON.stringify(toBjv(EMPTY_CATALOG_EXT));

/** The trailer value for `ext`, or null when it holds nothing beyond a fresh catalog. */
export function catalogExtToBjv(ext: CatalogExt): unknown {
  if (ext === EMPTY_CATALOG_EXT) return null;
  const value = toBjv(ext);
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
  return text === EMPTY_TEXT ? null : value;
}

/** Turn a dropped `null` back into an absent member. */
function restoreNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(restoreNulls) as T;
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = restoreNulls(v);
  return out as T;
}

export function catalogExtFromBjv(value: unknown): CatalogExt {
  const v = restoreNulls(value) as CatalogExtBjv;
  return {
    roles: new Map(v.roles.map((r) => [r.name, r])),
    memberships: v.memberships,
    grants: v.grants,
    composites: new Map(v.composites.map((c) => [`${c.schema}.${c.name}`, c])),
    tables: new Map(
      v.tables.map(({ oid, ...t }) => {
        return [oid, t as TableExt];
      }),
    ),
    eventTriggers: new Map(v.eventTriggers.map((e) => [e.name, e])),
    ...(v.dbRoleSettings?.length ? { dbRoleSettings: v.dbRoleSettings } : {}),
  };
}
