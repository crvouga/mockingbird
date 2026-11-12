import type { FromTable } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";
import { hashAnyUint32 } from "../functions/hash-fns.ts";
import type { TableData } from "../storage/database-state.ts";
import { castTo } from "../types/cast.ts";
import type { Datum } from "../types/value.ts";
import type { ExecEnv } from "./relation.ts";
import { evalScalar } from "./select.ts";

/**
 * Table scans that are more than "every row of one heap": `TABLESAMPLE`, partitioned tables (their
 * rows live in the partitions) and row-level security. Index access paths read a table's own rows
 * directly, so they are only taken for a {@link plainTableScan}.
 */

/** Hooks other modules install (partitioning, row-level security) without a dependency cycle. */
export interface ScanHooks {
  /** the rows (with system values) a scan of `table` sees before sampling, or null for its own rows */
  rows?(env: ExecEnv, table: TableData, label: string): Datum[][] | null;
  /** narrow the rows a scan sees (row-level security) */
  filter?(env: ExecEnv, table: TableData, rows: Datum[][]): Datum[][];
  /** whether a scan of `table` is just its own rows (no partitions, no policies) */
  plain?(env: ExecEnv, table: TableData): boolean;
}

const hooks: ScanHooks[] = [];

export function registerScanHooks(h: ScanHooks): void {
  hooks.push(h);
}

export function plainTableScan(env: ExecEnv, table: TableData, item?: FromTable): boolean {
  if (item?.tablesample) return false;
  return hooks.every((h) => h.plain?.(env, table) ?? true);
}

/** The rows of a scan of `table`; `own` produces the table's own rows with their system values. */
export function scanTableRows(
  env: ExecEnv,
  table: TableData,
  label: string,
  item: FromTable | undefined,
  own: () => Datum[][],
): Datum[][] {
  let rows: Datum[][] | null = null;
  for (const h of hooks) {
    rows = h.rows?.(env, table, label) ?? null;
    if (rows) break;
  }
  rows ??= own();
  // sampling picks rows by their place in the heap; quals (row security among them) apply after
  if (item?.tablesample) rows = sampleRows(env, table, rows, item.tablesample);
  for (const h of hooks) if (h.filter) rows = h.filter(env, table, rows);
  return rows;
}

// --- TABLESAMPLE --------------------------------------------------------------

const PAGE_BYTES = 8192 - 24;

/** Roughly how many of the table's tuples share a heap page: what SYSTEM sampling picks whole. */
function tuplesPerPage(table: TableData): number {
  let width = 24;
  for (const column of table.columns) {
    switch (column.type.id) {
      case "bool":
        width += 1;
        break;
      case "int2":
        width += 2;
        break;
      case "int4":
      case "float4":
      case "date":
      case "oid":
        width += 4;
        break;
      case "uuid":
        width += 16;
        break;
      case "int8":
      case "float8":
      case "timestamp":
      case "timestamptz":
      case "time":
      case "money":
        width += 8;
        break;
      default:
        width += 16;
    }
  }
  width = Math.ceil(width / 8) * 8 + 4;
  return Math.max(1, Math.floor(PAGE_BYTES / width));
}

function uint32Bytes(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => {
    view.setUint32(i * 4, v >>> 0, true);
  });
  return out;
}

/**
 * `TABLESAMPLE BERNOULLI (p)` keeps each row with probability p%; `SYSTEM (p)` keeps each page of
 * rows with probability p%. Like PostgreSQL's samplers the choice is a hash of the row's (or page's)
 * position and a seed: the seed is the `REPEATABLE` value, otherwise a draw from the session's
 * deterministic random generator. 0 and 100 are exact.
 */
function sampleRows(
  env: ExecEnv,
  table: TableData,
  rows: Datum[][],
  spec: NonNullable<FromTable["tablesample"]>,
): Datum[][] {
  const method = spec.method.toLowerCase();
  if (method !== "bernoulli" && method !== "system") {
    throw pgError("undefined_object", `tablesample method ${spec.method} does not exist`, "42704");
  }
  if (spec.args.length !== 1) {
    throw pgError(
      "data_exception",
      `tablesample method ${method} requires 1 argument, not ${spec.args.length}`,
      "2202H",
    );
  }
  const ctx = env.ctx;
  const percentValue = castTo(ctx, evalScalar(env, null, spec.args[0]!), "float4", {
    explicit: false,
    assignment: true,
  });
  if (percentValue.v === null) {
    throw pgError("data_exception", "TABLESAMPLE parameter cannot be null", "2202H");
  }
  const percent = percentValue.v as number;
  if (!(percent >= 0 && percent <= 100)) {
    throw pgError("data_exception", "sample percentage must be between 0 and 100", "2202H");
  }
  let seed: number;
  if (spec.repeatable) {
    const seedValue = castTo(ctx, evalScalar(env, null, spec.repeatable), "float8", { assignment: true });
    if (seedValue.v === null) {
      throw pgError("data_exception", "TABLESAMPLE REPEATABLE parameter cannot be null", "2202G");
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, (seedValue.v as number) === 0 ? 0 : (seedValue.v as number), true);
    seed = hashAnyUint32(bytes);
  } else {
    seed = Math.floor(ctx.state.prng.nextFloat() * 0x100000000) >>> 0;
  }
  if (percent >= 100) return rows;
  if (percent <= 0) return [];
  const cutoff = Math.round(0x100000000 * (percent / 100));
  const perPage = tuplesPerPage(table);
  return rows.filter((_, index) => {
    const key =
      method === "bernoulli"
        ? uint32Bytes([Math.floor(index / perPage), (index % perPage) + 1, seed])
        : uint32Bytes([Math.floor(index / perPage), seed]);
    return hashAnyUint32(key) < cutoff;
  });
}
