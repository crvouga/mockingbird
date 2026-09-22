import type { TypeName } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import type { ColumnType, TypeId, TypeMod } from "./value.ts";
import { arrayTypeOf, normalizeTypeName } from "./value.ts";

export interface ResolvedType {
  readonly column: ColumnType;
  /** "schema.name" when the name resolved to a domain */
  readonly domain: string | null;
  /** serial pseudo-types need sequence creation in DDL */
  readonly serial: "int2" | "int4" | "int8" | null;
}

const SERIALS: Record<string, "int2" | "int4" | "int8"> = {
  smallserial: "int2",
  serial2: "int2",
  serial: "int4",
  serial4: "int4",
  bigserial: "int8",
  serial8: "int8",
};

function modOf(t: TypeId, mods: number[]): TypeMod | null {
  if (mods.length === 0) return null;
  if (t === "numeric") return { a: mods[0], b: mods[1] ?? 0 };
  return { a: mods[0] };
}

/**
 * Resolve a parsed type name against the catalog: builtin alias, enum, or
 * domain (searched along search_path). Throws 42704 when nothing matches.
 */
export function resolveTypeName(state: DatabaseState, tn: TypeName): ResolvedType {
  const joined = tn.parts.join(".");
  const bare =
    tn.parts.length === 1 ? tn.parts[0]! : tn.parts.length === 2 && tn.parts[0] === "pg_catalog" ? tn.parts[1]! : null;

  if (bare !== null) {
    const serial = SERIALS[bare];
    if (serial !== undefined && tn.arrayDims === 0) {
      return { column: { id: serial, mod: null }, domain: null, serial };
    }
    const builtin = normalizeTypeName(bare);
    if (builtin !== null) {
      const id = tn.arrayDims > 0 ? arrayTypeOf(builtin) : builtin;
      return { column: { id, mod: modOf(builtin, tn.mods) }, domain: null, serial: null };
    }
  }

  const enumData = state.findEnum(tn.parts);
  if (enumData) {
    const elem: TypeId = `enum:${enumData.schema}.${enumData.name}`;
    const id = tn.arrayDims > 0 ? arrayTypeOf(elem) : elem;
    return { column: { id, mod: null }, domain: null, serial: null };
  }

  const domainData = state.findDomain(tn.parts);
  if (domainData) {
    if (tn.arrayDims > 0) {
      const id = arrayTypeOf(domainData.baseType.id);
      return { column: { id, mod: domainData.baseType.mod }, domain: null, serial: null };
    }
    return {
      column: domainData.baseType,
      domain: `${domainData.schema}.${domainData.name}`,
      serial: null,
    };
  }

  throw pgError("undefined_object", `type "${joined}" does not exist`);
}
