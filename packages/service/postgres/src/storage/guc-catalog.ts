import { pgError } from "../errors/error.ts";
import type { DatabaseState } from "./database-state.ts";
import {
  GUC_CATEGORIES,
  GUC_CONTEXTS,
  GUC_ROWS,
  GUC_SOURCES,
  GUC_UNITS,
  GUC_VARTYPES,
  type GucRow,
} from "./guc-catalog-data.ts";

/**
 * PostgreSQL's run-time parameters (`pg_settings`), with the checks `SET` applies to them: the
 * context that says when a parameter may change, the Boolean / integer / real / enum parsers, the
 * units integer and real parameters accept, and the unit `SHOW` prints them in.
 *
 * Values are kept in the form `SHOW` prints (`8MB`, `1s`, `on`); `pg_settings.setting` converts
 * back to the parameter's base unit.
 */

export type GucVartype = (typeof GUC_VARTYPES)[number];
export type GucContext = (typeof GUC_CONTEXTS)[number];

export interface GucDef {
  /** As `pg_settings` spells it (`DateStyle`, `TimeZone`, `work_mem`). */
  readonly name: string;
  readonly vartype: GucVartype;
  readonly context: GucContext;
  /** Base unit of an integer or real parameter (`kB`, `8kB`, `ms`, ...). */
  readonly unit: string | null;
  /** Built-in default, in base units. */
  readonly setting: string;
  readonly bootVal: string | null;
  readonly category: string;
  readonly shortDesc: string;
  readonly min: string | null;
  readonly max: string | null;
  readonly enumvals: readonly string[] | null;
  readonly source: string;
}

function decode(row: GucRow): GucDef {
  const [name, vartype, context, unit, setting, bootVal, category, shortDesc, ...rest] = row;
  const type = GUC_VARTYPES[vartype]!;
  const numeric = type === "integer" || type === "real";
  return {
    name,
    vartype: type,
    context: GUC_CONTEXTS[context]!,
    unit: GUC_UNITS[unit] ?? null,
    setting,
    bootVal,
    category: GUC_CATEGORIES[category]!,
    shortDesc,
    min: numeric ? (rest[0] as string) : null,
    max: numeric ? (rest[1] as string) : null,
    enumvals: type === "enum" ? (rest[0] as string[]) : null,
    source: GUC_SOURCES[rest[numeric ? 2 : 1] as number]!,
  };
}

let byName: Map<string, GucDef> | null = null;

function catalog(): Map<string, GucDef> {
  if (!byName) {
    byName = new Map();
    for (const row of GUC_ROWS) {
      const def = decode(row);
      byName.set(def.name.toLowerCase(), def);
    }
  }
  return byName;
}

/** The parameter `name` (already folded to lower case), if PostgreSQL has it. */
export function gucDef(name: string): GucDef | undefined {
  return catalog().get(name);
}

export function allGucDefs(): Iterable<GucDef> {
  return catalog().values();
}

/** Parameters that belong to the current transaction: `SET` outside one leaves them alone. */
export const TRANSACTION_GUCS: ReadonlyMap<string, string> = new Map([
  ["transaction_read_only", "default_transaction_read_only"],
  ["transaction_deferrable", "default_transaction_deferrable"],
  ["transaction_isolation", "default_transaction_isolation"],
]);

// --- units ----------------------------------------------------------------------------------

/** Each unit in kB (memory) or ms (time), largest first, as guc.c lists them. */
const MEMORY_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["TB", 1024 * 1024 * 1024],
  ["GB", 1024 * 1024],
  ["MB", 1024],
  ["kB", 1],
  ["B", 1 / 1024],
];
const TIME_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["d", 86400000],
  ["h", 3600000],
  ["min", 60000],
  ["s", 1000],
  ["ms", 1],
  ["us", 0.001],
];
const BASE_SIZE: Record<string, readonly [table: typeof MEMORY_UNITS, size: number]> = {
  B: [MEMORY_UNITS, 1 / 1024],
  kB: [MEMORY_UNITS, 1],
  "8kB": [MEMORY_UNITS, 8],
  MB: [MEMORY_UNITS, 1024],
  ms: [TIME_UNITS, 1],
  s: [TIME_UNITS, 1000],
  min: [TIME_UNITS, 60000],
};

/** C's `%g`: six significant digits, trailing zeros dropped, two-digit exponents. */
export function formatG(value: number): string {
  if (value === 0) return "0";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= 6) {
    const [mantissa, exp] = value.toExponential(5).split("e") as [string, string];
    const trimmed = mantissa.includes(".") ? mantissa.replace(/\.?0+$/, "") : mantissa;
    const sign = exp.startsWith("-") ? "-" : "+";
    const digits = exp.replace(/^[+-]/, "").padStart(2, "0");
    return `${trimmed}e${sign}${digits}`;
  }
  const fixed = value.toPrecision(6);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** `SHOW`'s form of a base-unit value: the largest unit that divides it evenly. */
function withUnit(def: GucDef, base: number): string {
  if (def.vartype === "integer") {
    if (!def.unit || base <= 0) return String(base);
    const [table, size] = BASE_SIZE[def.unit]!;
    for (const [unit, unitSize] of table) {
      const multiplier = unitSize / size;
      if (multiplier <= 1 || base % multiplier === 0) return `${Math.round(base / multiplier)}${unit}`;
    }
    return String(base);
  }
  if (!def.unit || base <= 0) return formatG(base);
  const [table, size] = BASE_SIZE[def.unit]!;
  let shown = "";
  for (const [unit, unitSize] of table) {
    const value = base / (unitSize / size);
    shown = `${formatG(value)}${unit}`;
    if (value > 0 && Math.abs(Math.round(value) / value - 1) <= 1e-8) break;
  }
  return shown;
}

/** strtol(…, 0) then strtod: decimal, 0x hex, leading-zero octal, then a fraction or exponent. */
function parseNumberPrefix(text: string, integerOnly: boolean): { value: number; rest: string } | null {
  const integer = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(text);
  if (integer) {
    const after = text.slice(integer[0].length);
    if (integerOnly || !/^[.eE]/.test(after)) {
      const digits = integer[2]!;
      const magnitude = /^0[xX]/.test(digits)
        ? Number.parseInt(digits.slice(2), 16)
        : digits.length > 1 && digits.startsWith("0")
          ? Number.parseInt(digits, 8)
          : Number.parseInt(digits, 10);
      if (!integerOnly || !/^[.eE]/.test(after)) {
        return { value: integer[1] === "-" ? -magnitude : magnitude, rest: after };
      }
    }
  }
  const real = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text);
  if (!real) return null;
  return { value: Number(real[0]), rest: text.slice(real[0].length) };
}

/** parse_int / parse_real: a number with an optional unit, converted to the base unit. */
function parseNumeric(def: GucDef, raw: string): number | null {
  const parsed = parseNumberPrefix(raw, false);
  if (!parsed) return null;
  let value = parsed.value;
  let rest = parsed.rest.replace(/^\s+/, "");
  if (rest !== "") {
    if (!def.unit) return null;
    const [table, size] = BASE_SIZE[def.unit]!;
    const unitText = rest.replace(/\s+$/, "");
    const unit = table.find(([name]) => name === unitText);
    if (!unit) return null;
    value = (value * unit[1]) / size;
    rest = "";
  }
  if (def.vartype === "integer") {
    value = Math.round(value);
    if (!Number.isSafeInteger(value)) return Number.NaN;
  }
  return value;
}

const invalidValue = (name: string, raw: string) =>
  pgError("invalid_parameter_value", `invalid value for parameter "${name}": "${raw}"`, "22023");

/** parse_bool: any prefix of true/false/yes/no, on/off from two letters, 1 and 0. */
export function parseGucBool(raw: string): boolean | null {
  const value = raw.toLowerCase();
  if (value.length === 0) return null;
  if ("true".startsWith(value) || "yes".startsWith(value) || value === "1") return true;
  if ("false".startsWith(value) || "no".startsWith(value) || value === "0") return false;
  if (value.length >= 2 && "on".startsWith(value)) return true;
  if (value.length >= 2 && "off".startsWith(value)) return false;
  return null;
}

/** Spellings guc_tables.c accepts for an enum without listing them in `enumvals`. */
const HIDDEN_ENUM_VALUES: Record<string, Record<string, string>> = {
  client_min_messages: { debug: "debug2", info: "info" },
  log_min_messages: { debug: "debug2" },
  log_min_error_statement: { debug: "debug2" },
};

/**
 * Check `raw` against parameter `def` the way `SET` does and return the value `SHOW` prints.
 * String parameters are returned unchanged.
 */
export function normalizeGucValue(def: GucDef, raw: string): string {
  const name = def.name;
  switch (def.vartype) {
    case "bool": {
      const value = parseGucBool(raw);
      if (value === null) {
        throw pgError("invalid_parameter_value", `parameter "${name}" requires a Boolean value`, "22023");
      }
      return value ? "on" : "off";
    }
    case "enum": {
      const lower = raw.toLowerCase();
      const options = def.enumvals ?? [];
      const match = options.find((option) => option.toLowerCase() === lower);
      if (match !== undefined) return match;
      const hidden = HIDDEN_ENUM_VALUES[name.toLowerCase()]?.[lower];
      if (hidden !== undefined) return hidden;
      // enums with on / off options also take the other Boolean spellings
      if (options.includes("on") && options.includes("off")) {
        const value = parseGucBool(lower);
        if (value !== null && lower.length > 0 && ["true", "false", "yes", "no", "1", "0"].includes(lower)) {
          return value ? "on" : "off";
        }
      }
      throw invalidValue(name, raw);
    }
    case "integer":
    case "real": {
      const value = parseNumeric(def, raw);
      if (value === null || Number.isNaN(value)) throw invalidValue(name, raw);
      const min = Number(def.min);
      const max = Number(def.max);
      if (value < min || value > max) {
        const unit = def.unit ? ` ${def.unit}` : "";
        const show = (n: number) => (def.vartype === "integer" ? String(n) : formatG(n));
        throw pgError(
          "invalid_parameter_value",
          `${show(value)}${unit} is outside the valid range for parameter "${name}" (${show(min)}${unit} .. ${show(max)}${unit})`,
          "22023",
        );
      }
      return withUnit(def, value);
    }
    case "string":
      return raw;
  }
}

/** The value `SHOW` prints for the parameter's built-in default. */
export function gucDefaultDisplay(def: GucDef): string {
  let shown = defaultShown.get(def);
  if (shown === undefined) {
    shown = def.vartype === "integer" || def.vartype === "real" ? withUnit(def, Number(def.setting)) : def.setting;
    defaultShown.set(def, shown);
  }
  return shown;
}

const defaultShown = new WeakMap<GucDef, string>();

/** `pg_settings.setting`: the value in the parameter's base unit. */
export function gucBaseSetting(def: GucDef, shown: string): string {
  if (def.vartype !== "integer" && def.vartype !== "real") return shown;
  const value = parseNumeric(def, shown);
  if (value === null || Number.isNaN(value)) return shown;
  return def.vartype === "integer" ? String(value) : formatG(value);
}

/** `SET` refuses a parameter that can only change at server start, on reload, or at connection start. */
export function assertGucSettable(def: GucDef): void {
  const name = def.name;
  switch (def.context) {
    case "internal":
      throw pgError("object_not_in_prerequisite_state", `parameter "${name}" cannot be changed`, "55P02");
    case "postmaster":
      throw pgError(
        "object_not_in_prerequisite_state",
        `parameter "${name}" cannot be changed without restarting the server`,
        "55P02",
      );
    case "sighup":
      throw pgError("object_not_in_prerequisite_state", `parameter "${name}" cannot be changed now`, "55P02");
    case "backend":
    case "superuser-backend":
      throw pgError(
        "object_not_in_prerequisite_state",
        `parameter "${name}" cannot be set after connection start`,
        "55P02",
      );
    default:
  }
}

const byGucName = (a: string, b: string): number => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Every parameter, keyed in lower case and named as PostgreSQL spells it, with its current value. */
export function allSettings(state: DatabaseState): Array<{ key: string; name: string; value: string }> {
  const keys = new Set<string>();
  for (const def of allGucDefs()) keys.add(def.name.toLowerCase());
  for (const key of state.settings.keys()) keys.add(key);
  for (const key of state.localSettings.keys()) keys.add(key);
  return [...keys]
    .map((key) => ({ key, name: gucDef(key)?.name ?? key, value: state.getSetting(key) ?? "" }))
    .sort((a, b) => byGucName(a.name, b.name));
}

type ConfigurationSetter = (state: DatabaseState, name: string, value: string | null, local: boolean) => string;
let configurationSetter: ConfigurationSetter | null = null;

/** The session module registers `SET`'s checks here, so `set_config()` can run them without an import cycle. */
export function registerConfigurationSetter(setter: ConfigurationSetter): void {
  configurationSetter = setter;
}

/** `set_config()`: `SET` / `SET LOCAL` (a `null` value resets). Returns the value `SHOW` now prints. */
export function setConfiguration(state: DatabaseState, name: string, value: string | null, local: boolean): string {
  if (!configurationSetter) throw pgError("internal", "set_config is not registered");
  return configurationSetter(state, name, value, local);
}
