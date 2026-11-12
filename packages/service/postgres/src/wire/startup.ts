/**
 * Run-time parameters of a StartupMessage, applied the way a PostgreSQL backend applies them at
 * start: the `options` command-line string first, then every other parameter sent by name. Both
 * become the session's defaults, so `RESET` returns to them.
 * https://www.postgresql.org/docs/18/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-STARTUPMESSAGE
 * https://www.postgresql.org/docs/18/libpq-connect.html#LIBPQ-CONNECT-OPTIONS
 *
 * The rules are PostgreSQL's own: `pg_split_opts` and `process_startup_options`
 * (src/backend/utils/init/postinit.c), `process_postgres_switches` (src/backend/tcop/postgres.c),
 * `ParseLongOption`, `parse_int` and `parse_bool` (src/backend/utils/misc/guc.c, utils/adt/bool.c).
 * A failure there is an ERROR raised before the backend can recover from one, which PostgreSQL
 * reports as FATAL and closes the connection.
 */
import { isPostgresError } from "../errors/error.ts";
import { type GucDef, gucDef, normalizeGucValue } from "../storage/guc-catalog.ts";
import { validateZone } from "../types/timezone.ts";

/** ErrorResponse fields of a rejected startup packet; the connection always ends with FATAL. */
export type StartupFailure = { code: string; message: string; detail?: string; hint?: string };

export class StartupError extends Error {
  constructor(readonly fields: StartupFailure) {
    super(fields.message);
    this.name = "StartupError";
  }
}

export type StartupSetting = { name: string; value: string };

const fail = (code: string, message: string, extra: { detail?: string; hint?: string } = {}): StartupError =>
  new StartupError({ code, message, ...extra });

/** C `isspace` in the "C" locale. */
const isSpace = (char: string | undefined): boolean => char !== undefined && " \t\n\v\f\r".includes(char);

/**
 * `pg_split_opts`: arguments are separated by whitespace; a backslash makes the next character
 * literal (`\ ` is a space inside an argument, `\\` a backslash).
 */
export const splitOptions = (options: string): string[] => {
  const args: string[] = [];
  let at = 0;
  while (at < options.length) {
    while (isSpace(options[at])) at++;
    if (at >= options.length) break;
    let arg = "";
    let escaped = false;
    for (; at < options.length; at++) {
      const char = options[at] as string;
      if (isSpace(char) && !escaped) break;
      if (!escaped && char === "\\") escaped = true;
      else {
        escaped = false;
        arg += char;
      }
    }
    args.push(arg);
  }
  return args;
};

/** The `postgres` getopt string: a switch followed by `:` takes an argument. */
const SWITCHES = "B:bC:c:D:d:EeFf:h:ijk:lN:nOPp:r:S:sTt:v:W:-:";

const invalidArgument = (arg: string): StartupError =>
  fail("42601", `invalid command-line argument for server process: ${arg}`, {
    hint: 'Try "postgres --help" for more information.',
  });

/** `ParseLongOption`: split at the first `=`; dashes in the name are underscores. */
const longOption = (flag: string, arg: string): StartupSetting => {
  const equals = arg.indexOf("=");
  if (equals === -1) {
    throw fail("42601", flag === "-" ? `--${arg} requires a value` : `-c ${arg} requires a value`);
  }
  return { name: arg.slice(0, equals).replaceAll("-", "_"), value: arg.slice(equals + 1) };
};

/** `process_postgres_switches` for a backend: `-c name=value` and `--name=value` are settings. */
const switchSettings = (args: string[]): StartupSetting[] => {
  const settings: StartupSetting[] = [];
  let at = 0;
  for (; at < args.length; at++) {
    const arg = args[at] as string;
    if (arg === "--") {
      at++;
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    const flag = arg[1] as string;
    if (flag === ":" || !SWITCHES.includes(flag)) throw invalidArgument(arg);
    if (flag !== "c" && flag !== "-") {
      throw fail("0A000", `startup option -${flag} is not supported: only -c name=value and --name=value are`);
    }
    // getopt takes the argument from the rest of the word (`-cname=value`), else from the next one.
    const value = arg.length > 2 ? arg.slice(2) : args[++at];
    if (value === undefined) throw invalidArgument(arg);
    settings.push(longOption(flag, value));
  }
  if (at < args.length) throw invalidArgument(args[at] as string);
  return settings;
};

/** Startup parameters that are not settings: connection routing and protocol extensions. */
const NOT_SETTINGS = new Set(["user", "database", "options", "replication"]);

/**
 * Every setting a startup packet asks for, in the order PostgreSQL applies them: the `options`
 * switches, then the parameters sent by name (which therefore win).
 */
export const startupSettings = (parameters: Readonly<Record<string, string>>): StartupSetting[] => {
  const settings = switchSettings(splitOptions(parameters.options ?? ""));
  for (const [name, value] of Object.entries(parameters)) {
    if (NOT_SETTINGS.has(name) || name.startsWith("_pq_.")) continue;
    settings.push({ name, value });
  }
  return settings;
};

// --- values ---------------------------------------------------------------------------------

/** `scanner_isspace`. */
const isListSpace = (char: string | undefined): boolean => char !== undefined && " \t\n\r\f".includes(char);

/**
 * `SplitIdentifierString`: a comma-separated list of identifiers, each bare (folded to lower
 * case) or double-quoted. Null when the list is malformed.
 */
export const splitIdentifierList = (raw: string): string[] | null => {
  const names: string[] = [];
  let at = 0;
  const skipSpace = () => {
    while (isListSpace(raw[at])) at++;
  };
  skipSpace();
  if (at >= raw.length) return names;
  for (;;) {
    if (raw[at] === '"') {
      let name = "";
      for (at++; ; at++) {
        if (at >= raw.length) return null;
        if (raw[at] !== '"') name += raw[at];
        else if (raw[at + 1] === '"') name += raw[at++];
        else break;
      }
      at++;
      names.push(name);
    } else {
      const start = at;
      while (at < raw.length && raw[at] !== "," && !isListSpace(raw[at])) at++;
      if (at === start) return null;
      names.push(raw.slice(start, at).toLowerCase());
    }
    skipSpace();
    if (at >= raw.length) return names;
    if (raw[at] !== ",") return null;
    at++;
    skipSpace();
  }
};

/** What a value check sees: the value, the parameter's display name, and the session so far. */
type Check = (value: string, name: string, current: ReadonlyMap<string, string>) => string;

const invalidValue = (name: string, value: string, extra: { detail?: string; hint?: string } = {}): StartupError =>
  fail("22023", `invalid value for parameter "${name}": "${value}"`, extra);

/** `parse_bool`: `on`/`off`, `1`/`0`, and unique prefixes of `true`/`false`/`yes`/`no`. */
const bool: Check = (value, name) => {
  const text = value.toLowerCase();
  const truthy = text !== "" && ("true".startsWith(text) || "yes".startsWith(text) || text === "on" || text === "1");
  const falsy =
    text !== "" &&
    ("false".startsWith(text) || "no".startsWith(text) || text === "of" || text === "off" || text === "0");
  if (!truthy && !falsy) throw fail("22023", `parameter "${name}" requires a Boolean value`);
  return truthy ? "on" : "off";
};

const INT_MAX = 2_147_483_647;
const NUMBER = /^[-+]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/;

/** `parse_int`'s number: C `strtol` with base 0 (decimal, `0x` hex, leading-`0` octal), else a rounded real. */
const parseNumber = (text: string): { value: number; rest: string } | null => {
  const match = NUMBER.exec(text);
  if (!match) return null;
  const digits = match[0].replace(/^[-+]/, "");
  const sign = match[0].startsWith("-") ? -1 : 1;
  const magnitude = /^0[xX]/.test(digits)
    ? Number.parseInt(digits, 16)
    : /^0[0-7]+$/.test(digits)
      ? Number.parseInt(digits, 8)
      : Number(digits);
  return { value: sign * magnitude, rest: text.slice(match[0].length) };
};

/** Round half to even, as C `rint` does. */
const rint = (value: number): number => {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
};

const integer =
  (min: number, max: number): Check =>
  (value, name) => {
    const parsed = parseNumber(value);
    // An integer parameter without units: anything after the number is an error.
    const result = parsed?.rest.trim() === "" ? rint(parsed.value) : Number.NaN;
    if (Number.isNaN(result)) throw invalidValue(name, value);
    if (Math.abs(result) > INT_MAX) throw invalidValue(name, value, { hint: "Value exceeds integer range." });
    if (result < min || result > max) {
      throw fail("22023", `${result} is outside the valid range for parameter "${name}" (${min} .. ${max})`);
    }
    return String(result);
  };

/** Microseconds per unit, largest first, which is also how PostgreSQL chooses the unit to show. */
const TIME_UNITS: [unit: string, micros: number][] = [
  ["d", 86_400_000_000],
  ["h", 3_600_000_000],
  ["min", 60_000_000],
  ["s", 1_000_000],
  ["ms", 1_000],
  ["us", 1],
];

/** A timeout in milliseconds, with PostgreSQL's units; shown in the largest unit that is exact. */
const milliseconds: Check = (value, name) => {
  const hint = 'Valid units for this parameter are "us", "ms", "s", "min", "h", and "d".';
  const parsed = parseNumber(value);
  if (!parsed) throw invalidValue(name, value);
  const unit = parsed.rest.trim();
  const micros = TIME_UNITS.find(([known]) => known === (unit === "" ? "ms" : unit))?.[1];
  if (micros === undefined) throw invalidValue(name, value, { hint });
  const ms = rint((parsed.value * micros) / 1_000);
  if (Math.abs(ms) > INT_MAX) throw invalidValue(name, value, { hint: "Value exceeds integer range." });
  if (ms < 0) {
    throw fail("22023", `${ms} ms is outside the valid range for parameter "${name}" (0 ms .. ${INT_MAX} ms)`);
  }
  if (ms === 0) return "0";
  const [shown, each] = TIME_UNITS.find(([, size]) => size >= 1_000 && (ms * 1_000) % size === 0) as [string, number];
  return `${(ms * 1_000) / each}${shown}`;
};

/** An enum parameter: `options` are the documented values, `hidden` maps the other accepted spellings. */
const oneOf =
  (options: string[], hidden: Record<string, string> = {}): Check =>
  (value, name) => {
    const text = value.toLowerCase();
    const found = options.includes(text) ? text : hidden[text];
    if (found === undefined) throw invalidValue(name, value, { hint: `Available values: ${options.join(", ")}.` });
    return found;
  };

const ISOLATION_LEVELS = ["serializable", "repeatable read", "read committed", "read uncommitted"];

/** `check_search_path`: any well-formed list is accepted; schemas need not exist. */
const searchPath: Check = (value, name) => {
  if (splitIdentifierList(value) === null) throw invalidValue(name, value, { detail: "List syntax is invalid." });
  // The engine reads the stored list itself and expects bare names already folded, as `SET` stores them.
  return value.replace(/"(?:[^"]|"")*"|[^"]+/g, (part) => (part.startsWith('"') ? part : part.toLowerCase()));
};

const DATE_STYLES: Record<string, string> = { iso: "ISO", sql: "SQL", postgres: "Postgres", german: "German" };

/** `check_datestyle`: an output style and a field order, either of which keeps its current value. */
const dateStyle: Check = (value, name, current) => {
  const words = splitIdentifierList(value);
  if (words === null) throw invalidValue(name, value, { detail: "List syntax is invalid." });
  let style: string | undefined;
  let order: string | undefined;
  let conflict = false;
  for (const word of words) {
    const nextStyle = DATE_STYLES[word];
    const nextOrder =
      word === "ymd"
        ? "YMD"
        : word === "dmy" || word.startsWith("euro")
          ? "DMY"
          : word === "mdy" || word === "us" || word.startsWith("noneuro")
            ? "MDY"
            : undefined;
    if (nextStyle !== undefined) {
      conflict ||= style !== undefined && style !== nextStyle;
      style = nextStyle;
    } else if (nextOrder !== undefined) {
      conflict ||= order !== undefined && order !== nextOrder;
      order = nextOrder;
    } else if (word !== "default") {
      throw invalidValue(name, value, { detail: `Unrecognized key word: "${word}".` });
    }
  }
  if (conflict) throw invalidValue(name, value, { detail: 'Conflicting "DateStyle" specifications.' });
  const [currentStyle, currentOrder] = (current.get("datestyle") ?? "ISO, MDY").split(", ");
  const useDefault = words.includes("default");
  // German output implies day-first input unless an order was named.
  order ??= style === "German" ? "DMY" : undefined;
  return `${style ?? (useDefault ? "ISO" : currentStyle)}, ${order ?? (useDefault ? "MDY" : currentOrder)}`;
};

const timeZone: Check = (value, name) => {
  try {
    validateZone(value);
  } catch {
    throw invalidValue(name, value);
  }
  return value;
};

/** The engine serves UTF-8 only; PostgreSQL reports the canonical spelling of the requested encoding. */
const clientEncoding: Check = (value) => {
  const normalized = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return normalized === "UTF8" || normalized === "UNICODE" ? "UTF8" : value;
};

const readOnly: Check = (_value, name) => {
  throw fail("55P02", `parameter "${name}" cannot be changed`);
};

/** Parameters whose values the server checks, by canonical name; the rest are stored as sent. */
const PARAMETERS: Record<string, { display?: string; check: Check; ignored?: true }> = {
  search_path: { check: searchPath },
  datestyle: { display: "DateStyle", check: dateStyle },
  timezone: { display: "TimeZone", check: timeZone },
  client_encoding: { check: clientEncoding },
  intervalstyle: {
    display: "IntervalStyle",
    check: oneOf(["postgres", "postgres_verbose", "sql_standard", "iso_8601"]),
  },
  bytea_output: { check: oneOf(["escape", "hex"]) },
  xmloption: { check: oneOf(["content", "document"]) },
  client_min_messages: {
    check: oneOf(["debug5", "debug4", "debug3", "debug2", "debug1", "log", "notice", "warning", "error"], {
      debug: "debug2",
      info: "info",
    }),
  },
  backslash_quote: {
    check: oneOf(["safe_encoding", "on", "off"], { true: "on", yes: "on", 1: "on", false: "off", no: "off", 0: "off" }),
  },
  default_transaction_isolation: { check: oneOf(ISOLATION_LEVELS) },
  // Checked, then left alone: every transaction starts from default_transaction_isolation.
  transaction_isolation: { check: oneOf(ISOLATION_LEVELS), ignored: true },
  standard_conforming_strings: { check: bool },
  check_function_bodies: { check: bool },
  row_security: { check: bool },
  array_nulls: { check: bool },
  extra_float_digits: { check: integer(-15, 3) },
  statement_timeout: { check: milliseconds },
  lock_timeout: { check: milliseconds },
  idle_in_transaction_session_timeout: { check: milliseconds },
  transaction_timeout: { check: milliseconds },
  server_version: { check: readOnly },
  server_version_num: { check: readOnly },
  server_encoding: { check: readOnly },
  integer_datetimes: { check: readOnly },
  max_identifier_length: { check: readOnly },
};

/** Any other PostgreSQL parameter: settable at connection start unless fixed at server start or reload. */
const catalogCheck = (def: GucDef, value: string): string => {
  if (def.context === "internal") throw fail("55P02", `parameter "${def.name}" cannot be changed`);
  if (def.context === "postmaster") {
    throw fail("55P02", `parameter "${def.name}" cannot be changed without restarting the server`);
  }
  if (def.context === "sighup") throw fail("55P02", `parameter "${def.name}" cannot be changed now`);
  try {
    return normalizeGucValue(def, value);
  } catch (error) {
    if (isPostgresError(error)) throw fail(error.sqlState, error.message);
    throw error;
  }
};

/**
 * Check `settings` and write them into `session`, a copy of the database's settings. Returns the
 * values that are now the session's reset defaults. A parameter the engine has no setting for
 * is `42704`, the same rule its `SET` follows; names containing a dot are custom parameters.
 */
export const applyStartupSettings = (
  settings: readonly StartupSetting[],
  session: Map<string, string>,
): Map<string, string> => {
  const applied = new Map<string, string>();
  for (const { name, value } of settings) {
    const key = name.toLowerCase();
    const def = gucDef(key);
    if (!session.has(key) && !def && !key.includes(".")) {
      throw fail("42704", `unrecognized configuration parameter "${name}"`);
    }
    const parameter = PARAMETERS[key];
    const checked = parameter
      ? parameter.check(value, parameter.display ?? key, session)
      : def
        ? catalogCheck(def, value)
        : value;
    if (parameter?.ignored) continue;
    session.set(key, checked);
    applied.set(key, checked);
  }
  return applied;
};
