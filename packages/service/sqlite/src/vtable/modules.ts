import { SqliteError } from "../errors/index.ts";
import type { Rowid } from "../storage/row.ts";
import type { SqlValue } from "../types/value.ts";

export interface RTreeRow {
  id: number | bigint;
  coords: number[];
}

/**
 * Simplified R*Tree for SQLite rtree / rtree_i32 modules.
 * Stores axis-aligned boxes; queries filter by bound inequalities in WHERE.
 */
export class RTreeVirtualTable {
  readonly kind = "rtree" as const;
  readonly name: string;
  readonly columns: string[];
  readonly dimension: number;
  readonly integerCoords: boolean;
  readonly originalSql: string | null;
  readonly rows = new Map<string, RTreeRow>();
  /** Shadow node table content for rtreenode/rtreedepth. */
  readonly nodes = new Map<number, Uint8Array>();

  constructor(name: string, columns: string[], integerCoords = false, originalSql: string | null = null) {
    if (columns.length < 3 || columns.length % 2 === 0) {
      throw new SqliteError("rtree tables must have an odd number of columns >= 3", "other");
    }
    this.name = name;
    this.columns = columns;
    this.dimension = (columns.length - 1) / 2;
    this.integerCoords = integerCoords;
    this.originalSql = originalSql;
    this.nodes.set(1, new Uint8Array([0]));
  }

  scan(): Array<{ rowid: Rowid; values: Map<string, SqlValue> }> {
    return [...this.rows.values()].map((row) => {
      const values = new Map<string, SqlValue>();
      values.set(this.columns[0]!.toLowerCase(), row.id);
      for (let i = 0; i < row.coords.length; i++) {
        values.set(this.columns[i + 1]!.toLowerCase(), row.coords[i]!);
      }
      return { rowid: row.id, values };
    });
  }

  insert(values: Map<string, SqlValue>): Rowid {
    const idVal = values.get(this.columns[0]!.toLowerCase());
    if (idVal === null || idVal === undefined) {
      throw new SqliteError("rtree id must not be NULL", "constraint_notnull");
    }
    const id = typeof idVal === "bigint" ? idVal : Math.trunc(Number(idVal));
    const key = String(id);
    if (this.rows.has(key)) throw new SqliteError("UNIQUE constraint failed", "constraint_unique");
    const coords: number[] = [];
    for (let i = 1; i < this.columns.length; i++) {
      const raw = values.get(this.columns[i]!.toLowerCase()) ?? null;
      if (raw === null) throw new SqliteError("rtree coordinate must not be NULL", "constraint_notnull");
      let n = Number(raw);
      if (this.integerCoords) n = Math.trunc(n);
      coords.push(n);
    }
    this.rows.set(key, { id, coords });
    return id;
  }

  update(rowid: Rowid, updates: Map<string, SqlValue>): void {
    const key = String(rowid);
    const existing = this.rows.get(key);
    if (!existing) return;
    const values = new Map<string, SqlValue>();
    values.set(this.columns[0]!.toLowerCase(), existing.id);
    for (let i = 0; i < existing.coords.length; i++) {
      values.set(this.columns[i + 1]!.toLowerCase(), existing.coords[i]!);
    }
    for (const [k, v] of updates) values.set(k, v);
    this.rows.delete(key);
    this.insert(values);
  }

  delete(rowid: Rowid): void {
    this.rows.delete(String(rowid));
  }

  clone(): RTreeVirtualTable {
    const copy = new RTreeVirtualTable(this.name, this.columns, this.integerCoords, this.originalSql);
    for (const [k, row] of this.rows) copy.rows.set(k, { id: row.id, coords: [...row.coords] });
    for (const [k, v] of this.nodes) copy.nodes.set(k, new Uint8Array(v));
    return copy;
  }
}

export class DbStatVirtualTable {
  readonly kind = "dbstat" as const;
  readonly name: string;
  readonly columns = [
    "name",
    "path",
    "pageno",
    "pagetype",
    "ncell",
    "payload",
    "unused",
    "mx_payload",
    "pgoffset",
    "pgsize",
  ];
  readonly originalSql: string | null;
  readonly schemaArg: string | null;

  constructor(name: string, schemaArg: string | null = null, originalSql: string | null = null) {
    this.name = name;
    this.schemaArg = schemaArg;
    this.originalSql = originalSql;
  }

  clone(): DbStatVirtualTable {
    return new DbStatVirtualTable(this.name, this.schemaArg, this.originalSql);
  }
}

export class BytecodeVirtualTable {
  readonly kind = "bytecode" as const;
  readonly name: string;
  readonly columns = ["addr", "opcode", "p1", "p2", "p3", "p4", "p5", "comment", "subprog"];
  readonly originalSql: string | null;

  constructor(name: string, originalSql: string | null = null) {
    this.name = name;
    this.originalSql = originalSql;
  }

  clone(): BytecodeVirtualTable {
    return new BytecodeVirtualTable(this.name, this.originalSql);
  }
}

export class TablesUsedVirtualTable {
  readonly kind = "tables_used" as const;
  readonly name: string;
  readonly columns = ["type", "schema", "name"];
  readonly originalSql: string | null;

  constructor(name: string, originalSql: string | null = null) {
    this.name = name;
    this.originalSql = originalSql;
  }

  clone(): TablesUsedVirtualTable {
    return new TablesUsedVirtualTable(this.name, this.originalSql);
  }
}

export class FtsVocabVirtualTable {
  readonly kind = "fts5vocab" as const;
  readonly name: string;
  readonly columns: string[];
  readonly ftsTable: string;
  readonly vocabType: string;
  readonly originalSql: string | null;

  constructor(name: string, args: string[], originalSql: string | null = null) {
    if (args.length < 1) throw new SqliteError("fts5vocab requires an fts5 table name", "other");
    this.name = name;
    this.ftsTable = args[0]!;
    this.vocabType = (args[1] ?? "row").replace(/'/g, "").toLowerCase();
    this.columns =
      this.vocabType === "col"
        ? ["term", "col", "doc", "cnt"]
        : this.vocabType === "instance"
          ? ["term", "doc", "col", "offset"]
          : ["term", "doc", "cnt"];
    this.originalSql = originalSql;
  }

  clone(): FtsVocabVirtualTable {
    return new FtsVocabVirtualTable(this.name, [this.ftsTable, this.vocabType], this.originalSql);
  }
}
