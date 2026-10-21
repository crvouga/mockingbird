import { quoteIdentifier } from "../sql/keywords.ts";
import { pgError } from "../errors/error.ts";
import { catalogRelationByOid, catalogRelationOid } from "../schema/catalog-oids.ts";
import { databaseCatalogContext } from "../runtime/database-context.ts";
import type { DatabaseState } from "../storage/database-state.ts";
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
  /** transaction timestamp (now(), current_timestamp) — UTC micros since PG epoch */
  readonly txNow: bigint;
  /** statement timestamp */
  readonly stmtNow: bigint;

  constructor(state: DatabaseState, txNow?: bigint) {
    this.state = state;
    const nowMs = state.clock().getTime();
    const nowMicros = BigInt(Math.round(nowMs)) * 1000n + UNIX_EPOCH_MICROS_FROM_PG;
    this.txNow = txNow ?? nowMicros;
    this.stmtNow = nowMicros;
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
    const target = this.state.resolveRelationSchema(parts);
    if (!target) return null;
    const catalogOid = catalogRelationOid(target.schema, target.name);
    if (catalogOid !== null) return catalogOid;
    const schema = this.state.schemas.get(target.schema);
    const relation =
      schema?.sequences.get(target.name) ??
      schema?.tables.get(target.name) ??
      schema?.views.get(target.name) ??
      schema?.indexes.get(target.name);
    return relation?.oid ?? null;
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

  zoneOffsetAt(utcMicros: bigint): number {
    return zoneOffsetAtUtc(this.timezone(), utcMicros);
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

  requireEnum(enumType: TypeId): string[] {
    const labels = this.enumLabels(enumType);
    if (!labels) throw pgError("undefined_object", `type "${enumType.slice(5)}" does not exist`);
    return labels;
  }
}
