import type { ConstraintMeta, DatabaseState, TableData, TriggerMeta } from "../storage/database-state.ts";

/**
 * pg_constraint and pg_trigger rows with the oids the catalogs list them under. The engine keeps
 * constraints and triggers inside their table, without oids of their own, so each is numbered in
 * catalog order: stable while the schema does not change, and the same in every catalog and
 * function (`pg_get_constraintdef`, `pg_get_triggerdef`, `pg_description`) that names it.
 */

export type ConstraintEntry =
  | { oid: number; table: TableData; contype: "p" | "u" | "c" | "f"; name: string; constraint: ConstraintMeta }
  /** PostgreSQL 18 lists each NOT NULL column as a constraint of its own */
  | { oid: number; table: TableData; contype: "n"; name: string; column: string };

export interface TriggerEntry {
  oid: number;
  table: TableData;
  trigger: TriggerMeta;
}

function* allTables(state: DatabaseState): Generator<TableData> {
  for (const schema of state.schemas.values()) yield* schema.tables.values();
}

export function contypeOf(c: ConstraintMeta): "p" | "u" | "c" | "f" {
  return c.kind === "primary_key" ? "p" : c.kind === "unique" ? "u" : c.kind === "check" ? "c" : "f";
}

export function constraintEntries(state: DatabaseState): ConstraintEntry[] {
  const out: ConstraintEntry[] = [];
  let oid = 30000;
  for (const table of allTables(state)) {
    for (const constraint of table.constraints) {
      out.push({ oid: oid++, table, contype: contypeOf(constraint), name: constraint.name, constraint });
    }
    for (const column of table.columns) {
      if (column.notNull) {
        out.push({
          oid: oid++,
          table,
          contype: "n",
          name: `${table.name}_${column.name}_not_null`,
          column: column.name,
        });
      }
    }
  }
  return out;
}

export function triggerEntries(state: DatabaseState): TriggerEntry[] {
  const out: TriggerEntry[] = [];
  let oid = 40000;
  for (const table of allTables(state)) {
    for (const trigger of table.triggers) out.push({ oid: oid++, table, trigger });
  }
  return out;
}

/** 1-based column number of `name` in `table` (0 when there is no such column). */
export function attnum(table: TableData, name: string): number {
  return table.columnIndex(name) + 1;
}

/** pg_class / pg_proc / pg_type / pg_constraint / pg_trigger oids, as pg_description.classoid holds them. */
export const CLASS_OIDS = {
  pg_class: 1259,
  pg_proc: 1255,
  pg_type: 1247,
  pg_constraint: 2606,
  pg_trigger: 2620,
} as const;

export interface DescriptionRow {
  objoid: number;
  classoid: number;
  objsubid: number;
  description: string;
}

/** Every stored comment, as pg_description lists it. */
export function descriptions(state: DatabaseState): DescriptionRow[] {
  const rows: DescriptionRow[] = [];
  const push = (objoid: number, classoid: number, objsubid: number, description: string | null | undefined) => {
    if (description) rows.push({ objoid, classoid, objsubid, description });
  };
  for (const schema of state.schemas.values()) {
    for (const table of schema.tables.values()) {
      push(table.oid, CLASS_OIDS.pg_class, 0, table.comment);
      table.columns.forEach((column, i) => {
        push(table.oid, CLASS_OIDS.pg_class, i + 1, column.comment);
      });
    }
    for (const view of schema.views.values()) push(view.oid, CLASS_OIDS.pg_class, 0, view.comment);
    for (const seq of schema.sequences.values()) push(seq.oid, CLASS_OIDS.pg_class, 0, seq.comment);
    for (const index of schema.indexes.values()) push(index.oid ?? 0, CLASS_OIDS.pg_class, 0, index.comment);
    for (const overloads of schema.functions.values()) {
      for (const f of overloads) push(f.oid, CLASS_OIDS.pg_proc, 0, f.comment);
    }
    for (const en of schema.enums.values()) push(en.oid, CLASS_OIDS.pg_type, 0, en.comment);
    for (const domain of schema.domains.values()) push(domain.oid, CLASS_OIDS.pg_type, 0, domain.comment);
  }
  for (const entry of constraintEntries(state)) {
    if (entry.contype !== "n") push(entry.oid, CLASS_OIDS.pg_constraint, 0, entry.constraint.comment);
  }
  for (const entry of triggerEntries(state)) push(entry.oid, CLASS_OIDS.pg_trigger, 0, entry.trigger.comment);
  return rows;
}
