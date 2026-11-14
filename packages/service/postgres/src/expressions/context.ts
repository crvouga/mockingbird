import { quoteIdentifier } from "../sql/keywords.ts";
import { pgError } from "../errors/error.ts";
import { getRegResolver } from "../schema/catalog.ts";
import { catalogRelationByOid, catalogRelationOid } from "../schema/catalog-oids.ts";
import { clockMicros } from "../runtime/clock.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import type { DatabaseState } from "../storage/database-state.ts";
import { findRole, roleByOid } from "../storage/roles.ts";
import type { CastEnv } from "../types/cast.ts";
import type { CompareCtx } from "../types/compare.ts";
import { UNIX_EPOCH_MICROS_FROM_PG } from "../types/datetime.ts";
import { builtinNamespaceName, builtinNamespaceOid } from "../types/regnamespace.ts";
import { zoneOffsetAtUtc, zoneOffsetForNaive } from "../types/timezone.ts";
import { isEnumType, type TypeId } from "../types/value.ts";

/**
 * Engine-wide evaluation context: database state plus per-statement clock
 * captures. One instance is created per top-level statement execution.
 */
export class EngineCtx implements CastEnv, CompareCtx {
  readonly state: DatabaseState;
  private writeXid: number | null = null;

  rowVersionXid(): number {
    if (this.state.inTransaction) return (this.state.transactionXid ??= this.state.allocateXid());
    return (this.writeXid ??= this.state.allocateXid());
  }

  /** The transaction id assigned so far (by a write or pg_current_xact_id()), or null when none is. */
  assignedXid(): number | null {
    return this.state.inTransaction ? this.state.transactionXid : this.writeXid;
  }
  /** transaction timestamp (now(), current_timestamp) — UTC micros since PG epoch */
  readonly txNow: bigint;
  /** statement timestamp */
  readonly stmtNow: bigint;

  /**
   * @param txNow the transaction start when the caller already knows it (later statements of one
   *   implicit multi-statement transaction); inside a transaction block the block's own start wins.
   */
  constructor(state: DatabaseState, txNow?: bigint) {
    this.state = state;
    const nowMicros = this.clockNow();
    this.stmtNow = nowMicros;
    // PostgreSQL: now() is the start of the transaction, the statement start of an implicit one
    this.txNow = state.inTransaction ? (state.transactionStart ??= txNow ?? nowMicros) : (txNow ?? nowMicros);
  }

  /** clock_timestamp(): the clock read afresh, PG-epoch UTC micros. */
  clockNow(): bigint {
    return clockMicros(this.state.clock) + UNIX_EPOCH_MICROS_FROM_PG;
  }

  timezone(): string {
    return this.state.getSetting("timezone") ?? "UTC";
  }

  /** The oid of the relation `parts` names, or null when there is none (the soft form `to_regclass` needs). */
  findRelationOid(parts: string[]): number | null {
    if (parts.length === 3) {
      const database = databaseCatalogContext(this.state).name;
      if (parts[0] !== database) {
        throw pgError(
          "feature_not_supported",
          `cross-database references are not implemented: "${parts.join(".")}"`,
          "0A000",
        );
      }
    }
    const target = this.state.resolveRelationSchema(parts) ?? this.compositeRelation(parts);
    if (!target) return null;
    const catalogOid = catalogRelationOid(target.schema, target.name);
    if (catalogOid !== null) return catalogOid;
    const schema = this.state.schemas.get(target.schema);
    const relation =
      schema?.sequences.get(target.name) ??
      schema?.tables.get(target.name) ??
      schema?.views.get(target.name) ??
      schema?.indexes.get(target.name);
    if (relation) return relation.oid ?? null;
    // a composite type is a relation of kind 'c'
    return this.state.catalogExt.composites.get(`${target.schema}.${target.name}`)?.relOid ?? null;
  }

  /** A composite type's relation, for `'name'::regclass`. */
  private compositeRelation(parts: string[]): { schema: string; name: string } | null {
    const composites = this.state.catalogExt.composites;
    if (composites.size === 0) return null;
    const name = parts[parts.length - 1]!;
    const schemas = parts.length >= 2 ? [parts[parts.length - 2]!] : this.state.effectiveSearchPath();
    for (const schema of schemas) if (composites.has(`${schema}.${name}`)) return { schema, name };
    return null;
  }

  relationOid(parts: string[]): number {
    const oid = this.findRelationOid(parts);
    if (oid === null) {
      throw pgError("undefined_table", `relation "${parts.join(".")}" does not exist`, "42P01");
    }
    return oid;
  }

  relationName(oid: number): string | null {
    const catalog = catalogRelationByOid(oid);
    if (catalog) {
      const [schema, name] = catalog;
      return (schema === "pg_catalog" ? [name] : [schema, name]).map(quoteIdentifier).join(".");
    }
    for (const schema of this.state.schemas.values()) {
      for (const relation of [
        ...schema.tables.values(),
        ...schema.sequences.values(),
        ...schema.views.values(),
        ...schema.indexes.values(),
      ]) {
        if (relation.oid !== oid) continue;
        const visible = this.state.resolveRelationSchema([relation.name])?.schema === schema.name;
        return (visible ? [relation.name] : [schema.name, relation.name]).map(quoteIdentifier).join(".");
      }
    }
    return null;
  }

  namespaceOid(name: string): number {
    const oid = builtinNamespaceOid(name) ?? this.state.schemas.get(name)?.oid;
    if (oid === undefined) throw pgError("undefined_object", `schema "${name}" does not exist`, "3F000");
    return oid;
  }

  namespaceName(oid: number): string | null {
    const builtin = builtinNamespaceName(oid);
    if (builtin !== undefined) return builtin;
    for (const schema of this.state.schemas.values()) {
      if (schema.oid === oid) return schema.name;
    }
    return null;
  }

  roleOid(name: string): number {
    const role = findRole(this.state, name);
    if (!role) throw pgError("undefined_object", `role "${name}" does not exist`, "42704");
    return role.oid;
  }

  roleName(oid: number): string | null {
    return roleByOid(this.state.catalogExt, oid)?.name ?? null;
  }

  regtypeIn(text: string): string {
    return getRegResolver().typeIn(this.state, text);
  }

  regprocIn(text: string): string {
    return getRegResolver().procIn(this.state, text);
  }

  regOid(t: "regtype" | "regproc", name: string): number | null {
    return getRegResolver().oid(this.state, t, name);
  }

  regName(t: "regtype" | "regproc", oid: number): string | null {
    return getRegResolver().name(this.state, t, oid);
  }

  zoneOffsetAt(utcMicros: bigint): number {
    return zoneOffsetAtUtc(this.timezone(), utcMicros);
  }

  /** 'now' / 'today' input reads the transaction timestamp, as now() does */
  datetimeNow(): { utc: bigint; offsetSec: number } {
    return { utc: this.txNow, offsetSec: this.zoneOffsetAt(this.txNow) };
  }

  zoneOffsetForNaive(naiveMicros: bigint): number {
    return zoneOffsetForNaive(this.timezone(), naiveMicros);
  }

  enumLabels(enumType: TypeId): string[] | null {
    if (!isEnumType(enumType)) return null;
    const e = this.state.findEnumByKey(enumType.slice(5));
    return e?.labels ?? null;
  }

  enumHasLabel(enumType: TypeId, label: string): boolean {
    const labels = this.enumLabels(enumType);
    return labels === null ? true : labels.includes(label);
  }

  enumOrder(enumType: TypeId, label: string): number {
    const labels = this.enumLabels(enumType);
    if (!labels) return 0;
    const idx = labels.indexOf(label);
    return idx === -1 ? labels.length : idx;
  }

  /** A composite type's attribute names and types (record_in, casts, field selection). */
  compositeAttributes(t: TypeId): { names: string[]; types: TypeId[] } | null {
    const c = this.state.catalogExt.composites.get(t.slice(5));
    if (!c) return null;
    return { names: c.attributes.map((a) => a.name), types: c.attributes.map((a) => a.type.id) };
  }

  requireEnum(enumType: TypeId): string[] {
    const labels = this.enumLabels(enumType);
    if (!labels) throw pgError("undefined_object", `type "${enumType.slice(5)}" does not exist`);
    return labels;
  }
}
