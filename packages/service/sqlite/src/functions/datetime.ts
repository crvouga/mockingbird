import { coerceToNumber, isSqlReal, type SqlValue } from "../types/value.ts";
import type { FunctionContext, ScalarFunction } from "./registry.ts";

const JULIAN_UNIX_EPOCH = 2440587.5;

function parseDate(value: SqlValue | undefined, context: FunctionContext): Date | null {
  if (value === undefined || value === "now") {
    return context.now?.() ?? new Date("2000-01-01T00:00:00.000Z");
  }
  if (value === null || value instanceof Uint8Array) return null;
  if (typeof value === "number" || typeof value === "bigint" || isSqlReal(value)) {
    return new Date((Number(isSqlReal(value) ? value.value : value) - JULIAN_UNIX_EPOCH) * 86400000);
  }
  if (typeof value !== "string") return null;
  const source = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)
    ? `2000-01-01T${value}Z`
    : /^\d{4}-\d\d-\d\d$/.test(value)
      ? `${value}T00:00:00Z`
      : value.replace(" ", "T") + (/[zZ]|[+-]\d\d:\d\d$/.test(value) ? "" : "Z");
  const date = new Date(source);
  return Number.isNaN(date.getTime()) ? null : date;
}

function applyModifier(date: Date, modifier: string, flags: { subsec: boolean }): Date | null {
  const result = new Date(date);
  const normalized = modifier.trim().toLowerCase();
  if (normalized === "unixepoch") return new Date((date.getTime() / 86400000 + JULIAN_UNIX_EPOCH) * 1000);
  if (normalized === "utc" || normalized === "localtime") return result;
  if (normalized === "subsec" || normalized === "subsecond") {
    flags.subsec = true;
    return result;
  }
  // Accepted by SQLite; when not attached to a prior fractional add they are effectively no-ops.
  if (normalized === "floor" || normalized === "ceiling") return result;
  const weekday = /^weekday\s+([0-6])$/.exec(normalized);
  if (weekday) {
    const target = Number(weekday[1]);
    result.setUTCDate(result.getUTCDate() + ((target - result.getUTCDay() + 7) % 7));
  } else if (normalized === "start of day") result.setUTCHours(0, 0, 0, 0);
  else if (normalized === "start of month") {
    result.setUTCDate(1);
    result.setUTCHours(0, 0, 0, 0);
  } else if (normalized === "start of year") {
    result.setUTCMonth(0, 1);
    result.setUTCHours(0, 0, 0, 0);
  } else {
    const match = /^([+-]?\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?$/.exec(normalized);
    if (!match) return null;
    const amount = Number(match[1]);
    switch (match[2]) {
      case "second":
        result.setTime(result.getTime() + amount * 1000);
        break;
      case "minute":
        result.setTime(result.getTime() + amount * 60000);
        break;
      case "hour":
        result.setTime(result.getTime() + amount * 3600000);
        break;
      case "day":
        result.setTime(result.getTime() + amount * 86400000);
        break;
      case "month":
        result.setUTCMonth(result.getUTCMonth() + amount);
        break;
      case "year":
        result.setUTCFullYear(result.getUTCFullYear() + amount);
        break;
    }
  }
  return result;
}

function applyModifiers(date: Date, modifiers: SqlValue[]): { date: Date; subsec: boolean } | null {
  const flags = { subsec: false };
  let current = date;
  for (const modifier of modifiers) {
    if (typeof modifier !== "string") return null;
    const next = applyModifier(current, modifier, flags);
    if (!next) return null;
    current = next;
  }
  return { date: current, subsec: flags.subsec };
}

/** Prefer direct unix→ms to avoid julian float round-trip (off-by-one on some integers). */
function fromUnixSeconds(seconds: number): Date | null {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveDate(args: SqlValue[], context: FunctionContext): { date: Date; subsec: boolean } | null {
  let source = args[0];
  let modifiers = args.slice(1);
  if (source === undefined) source = "now";
  if (modifiers[0] === "unixepoch") {
    const seconds = coerceToNumber(source);
    if (seconds === null) return null;
    const date = fromUnixSeconds(seconds);
    if (!date) return null;
    return applyModifiers(date, modifiers.slice(1));
  }
  if (typeof modifiers[0] === "string" && modifiers[0].trim().toLowerCase() === "auto") {
    const number = coerceToNumber(source);
    if (number === null) {
      // Non-numeric timestring: SQLite ignores auto and parses the timestring.
      modifiers = modifiers.slice(1);
    } else if (number >= 0 && number < 5373484.5) {
      // Julian day number.
      source = number;
      modifiers = modifiers.slice(1);
    } else {
      const date = fromUnixSeconds(number);
      if (!date) return null;
      return applyModifiers(date, modifiers.slice(1));
    }
  }
  const date = parseDate(source, context);
  if (!date) return null;
  return applyModifiers(date, modifiers);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function isoDate(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function isoTime(date: Date, subsec = false): string {
  const base = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return subsec ? `${base}.${pad(date.getUTCMilliseconds(), 3)}` : base;
}

function dayOfYear(date: Date): number {
  return (
    Math.floor(
      (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 1)) /
        86400000,
    ) + 1
  );
}

function formatDate(date: Date, format: string): string {
  return format.replace(/%[%YmdHMSfjswWJ]/g, (code) => {
    switch (code) {
      case "%%":
        return "%";
      case "%Y":
        return pad(date.getUTCFullYear(), 4);
      case "%m":
        return pad(date.getUTCMonth() + 1);
      case "%d":
        return pad(date.getUTCDate());
      case "%H":
        return pad(date.getUTCHours());
      case "%M":
        return pad(date.getUTCMinutes());
      case "%S":
        return pad(date.getUTCSeconds());
      case "%f":
        return `${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
      case "%j":
        return pad(dayOfYear(date), 3);
      case "%s":
        return String(Math.floor(date.getTime() / 1000));
      case "%w":
        return String(date.getUTCDay());
      case "%W":
        return pad(Math.floor((dayOfYear(date) - 1 + 7 - date.getUTCDay()) / 7));
      case "%J":
        return String(date.getTime() / 86400000 + JULIAN_UNIX_EPOCH);
      default:
        return code;
    }
  });
}

export const dateTimeFunctions: Readonly<Record<string, ScalarFunction>> = {
  date(args, context) {
    const value = resolveDate(args, context);
    return value ? isoDate(value.date) : null;
  },
  time(args, context) {
    const value = resolveDate(args, context);
    return value ? isoTime(value.date, value.subsec) : null;
  },
  datetime(args, context) {
    const value = resolveDate(args, context);
    return value ? `${isoDate(value.date)} ${isoTime(value.date, value.subsec)}` : null;
  },
  julianday(args, context) {
    const value = resolveDate(args, context);
    return value ? value.date.getTime() / 86400000 + JULIAN_UNIX_EPOCH : null;
  },
  strftime(args, context) {
    if (typeof args[0] !== "string") return null;
    const value = resolveDate(args.slice(1), context);
    return value ? formatDate(value.date, args[0]) : null;
  },
  current_date(args, context) {
    return dateTimeFunctions.date!(args.length === 0 ? ["now"] : args, context);
  },
  current_time(args, context) {
    return dateTimeFunctions.time!(args.length === 0 ? ["now"] : args, context);
  },
  current_timestamp(args, context) {
    return dateTimeFunctions.datetime!(args.length === 0 ? ["now"] : args, context);
  },
  unixepoch(args, context) {
    const value = resolveDate(args.length === 0 ? ["now"] : args, context);
    return value ? Math.floor(value.date.getTime() / 1000) : null;
  },
  timediff(args) {
    if (args.length !== 2) return null;
    const a = parseDate(args[0], {});
    const b = parseDate(args[1], {});
    if (!a || !b) return null;
    let ms = a.getTime() - b.getTime();
    const sign = ms < 0 ? "-" : "+";
    ms = Math.abs(ms);
    const years = Math.floor(ms / (365.2425 * 86400000));
    ms -= years * 365.2425 * 86400000;
    // Approximate month/day breakdown matching SQLite's YYYY-MM-DD HH:MM:SS.mmm style
    const months = Math.floor(ms / (30.436875 * 86400000));
    ms -= months * 30.436875 * 86400000;
    const days = Math.floor(ms / 86400000);
    ms -= days * 86400000;
    const hours = Math.floor(ms / 3600000);
    ms -= hours * 3600000;
    const minutes = Math.floor(ms / 60000);
    ms -= minutes * 60000;
    const seconds = Math.floor(ms / 1000);
    const millis = Math.floor(ms % 1000);
    const p = (n: number, w: number) => String(n).padStart(w, "0");
    return `${sign}${p(years, 4)}-${p(months, 2)}-${p(days, 2)} ${p(hours, 2)}:${p(minutes, 2)}:${p(seconds, 2)}.${p(millis, 3)}`;
  },
};
