import type { RelOption } from "../ast/nodes.ts";
import { pgError } from "../errors/error.ts";

/**
 * Index storage parameters (reloptions.c). The engine stores no pages, so they change nothing but
 * pg_class.reloptions and pg_get_indexdef: each is checked as PostgreSQL checks it and kept as written.
 */
type OptionKind =
  | { kind: "int"; min: number; max: number }
  | { kind: "bool" }
  | { kind: "enum"; values: readonly string[] };

const FILLFACTOR: OptionKind = { kind: "int", min: 10, max: 100 };

const INDEX_OPTIONS: ReadonlyMap<string, ReadonlyMap<string, OptionKind>> = new Map([
  [
    "btree",
    new Map<string, OptionKind>([
      ["fillfactor", FILLFACTOR],
      ["deduplicate_items", { kind: "bool" }],
    ]),
  ],
  ["hash", new Map<string, OptionKind>([["fillfactor", FILLFACTOR]])],
  [
    "gist",
    new Map<string, OptionKind>([
      ["fillfactor", FILLFACTOR],
      ["buffering", { kind: "enum", values: ["auto", "on", "off"] }],
    ]),
  ],
  ["spgist", new Map<string, OptionKind>([["fillfactor", FILLFACTOR]])],
  [
    "gin",
    new Map<string, OptionKind>([
      ["fastupdate", { kind: "bool" }],
      ["gin_pending_list_limit", { kind: "int", min: 64, max: 2147483647 }],
    ]),
  ],
  [
    "brin",
    new Map<string, OptionKind>([
      ["pages_per_range", { kind: "int", min: 1, max: 131072 }],
      ["autosummarize", { kind: "bool" }],
    ]),
  ],
]);

const invalid = (message: string) => pgError("invalid_parameter_value", message, "22023");

/** parse_bool: true/false/yes/no/on/off/1/0 and their unambiguous prefixes, any case. */
function parseBool(text: string): boolean | null {
  const v = text.toLowerCase();
  if (v.length === 0) return null;
  const prefixOf = (word: string, min: number) => v.length >= min && word.startsWith(v);
  if (prefixOf("true", 1) || prefixOf("yes", 1) || v === "1") return true;
  if (prefixOf("false", 1) || prefixOf("no", 1) || v === "0") return false;
  if (prefixOf("on", 2)) return true;
  if (prefixOf("off", 2)) return false;
  return null;
}

/** parse_int: an integer (decimal, 0x hex, 0 octal) or a number rounded to one, spaces around allowed. */
function parseInt32(text: string): number | null {
  const v = text.trim();
  let n: number;
  if (/^[+-]?0x[0-9a-f]+$/i.test(v)) n = (v.startsWith("-") ? -1 : 1) * Number.parseInt(v.replace(/^[+-]?0x/i, ""), 16);
  else if (/^[+-]?0[0-7]+$/.test(v)) n = Number.parseInt(v, 8);
  else if (/^[+-]?\d+$/.test(v)) n = Number.parseInt(v, 10);
  else if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) n = Math.round(Number(v));
  else return null;
  return Number.isFinite(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** validateRelOptions for an index of access method `method` (other methods are not checked). */
export function validateIndexOptions(method: string, options: ReadonlyArray<RelOption>): void {
  const known = INDEX_OPTIONS.get(method);
  if (!known) return;
  const seen = new Set<string>();
  for (const option of options) {
    if (option.namespace !== undefined) continue;
    const kind = known.get(option.name);
    if (!kind) throw invalid(`unrecognized parameter "${option.name}"`);
    if (seen.has(option.name)) throw invalid(`parameter "${option.name}" specified more than once`);
    seen.add(option.name);
    // a parameter written without a value means true
    const value = option.value ?? "true";
    switch (kind.kind) {
      case "bool":
        if (parseBool(value) === null) throw invalid(`invalid value for boolean option "${option.name}": ${value}`);
        break;
      case "int": {
        const n = parseInt32(value);
        if (n === null) throw invalid(`invalid value for integer option "${option.name}": ${value}`);
        if (n < kind.min || n > kind.max) throw invalid(`value ${value} out of bounds for option "${option.name}"`);
        break;
      }
      case "enum":
        if (!kind.values.includes(value.toLowerCase())) {
          throw invalid(`invalid value for enum option "${option.name}": ${value}`);
        }
        break;
    }
  }
}

/**
 * transformRelOptions: the options kept after `SET (...)` / `RESET (...)`. Options of other names keep
 * their place; the ones set are appended in the order written. Namespaced (`toast.`) ones do not apply
 * to an index and are dropped.
 */
export function mergeIndexOptions(
  current: ReadonlyArray<{ name: string; value: string }>,
  changes: ReadonlyArray<RelOption>,
  reset: boolean,
): Array<{ name: string; value: string }> {
  const plain = changes.filter((c) => c.namespace === undefined);
  const named = new Set(plain.map((c) => c.name));
  const kept = current.filter((o) => !named.has(o.name)).map((o) => ({ ...o }));
  if (reset) return kept;
  return [...kept, ...plain.map((c) => ({ name: c.name, value: c.value ?? "true" }))];
}
