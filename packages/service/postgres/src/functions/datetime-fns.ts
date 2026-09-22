import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { castTo } from "../types/cast.ts";
import {
  civilToDays,
  DATE_NEG_INF,
  DATE_POS_INF,
  dayOfWeek,
  daysInMonth,
  daysToCivil,
  type Interval,
  isValidCivil,
  makeInterval,
  splitTs,
  TS_NEG_INF,
  TS_POS_INF,
  USECS_PER_DAY,
  USECS_PER_HOUR,
  USECS_PER_MIN,
  USECS_PER_SEC,
} from "../types/datetime.ts";
import { makeNumeric, type Numeric, numericFromBigInt, parseNumeric } from "../types/numeric.ts";
import { type TypedValue, tv } from "../types/value.ts";

/**
 * EXTRACT / date_part. `asNumeric=true` → numeric result (EXTRACT, PG 14+);
 * false → float8 (date_part).
 */
export function extractDatePart(ctx: EngineCtx, field0: string, src0: TypedValue, asNumeric: boolean): TypedValue {
  const field = field0.toLowerCase();
  const resultType = asNumeric ? "numeric" : "float8";
  let src = src0;
  if (src.t === "unknown" && typeof src.v === "string") {
    src = castTo(ctx, src, "timestamptz", { explicit: true });
  }
  if (src.v === null) return tv(resultType, null);

  const wrap = (n: Numeric): TypedValue => {
    if (asNumeric) return tv("numeric", n);
    return castTo(ctx, tv("numeric", n), "float8", { explicit: true });
  };

  switch (src.t) {
    case "date": {
      const days = src.v as number;
      if (days === DATE_POS_INF || days === DATE_NEG_INF) return extractInfinity(field, days > 0, wrap, "date");
      return wrap(extractFromDate(field, days, src.t));
    }
    case "timestamp": {
      const micros = src.v as bigint;
      if (micros === TS_POS_INF || micros === TS_NEG_INF) return extractInfinity(field, micros > 0n, wrap, "timestamp");
      const { days, tod } = splitTs(micros);
      if (field === "epoch") {
        return wrap(microsToNumericSeconds(micros + 946_684_800_000_000n));
      }
      return wrap(hasTimeField(field) ? extractFromTime(field, tod) : extractFromDate(field, days, src.t));
    }
    case "timestamptz": {
      const micros = src.v as bigint;
      if (micros === TS_POS_INF || micros === TS_NEG_INF)
        return extractInfinity(field, micros > 0n, wrap, "timestamp with time zone");
      if (field === "epoch") {
        return wrap(microsToNumericSeconds(micros + 946_684_800_000_000n));
      }
      const offsetSec = ctx.zoneOffsetAt(micros);
      const local = micros + BigInt(offsetSec) * USECS_PER_SEC;
      if (field === "timezone") return wrap(numericFromBigInt(BigInt(offsetSec)));
      if (field === "timezone_hour") return wrap(numericFromBigInt(BigInt(Math.trunc(offsetSec / 3600))));
      if (field === "timezone_minute") return wrap(numericFromBigInt(BigInt(Math.trunc((offsetSec % 3600) / 60))));
      const { days, tod } = splitTs(local);
      return wrap(hasTimeField(field) ? extractFromTime(field, tod) : extractFromDate(field, days, src.t));
    }
    case "time": {
      const micros = src.v as bigint;
      if (field === "epoch") return wrap(microsToNumericSeconds(micros));
      if (!hasTimeField(field)) {
        throw pgError(
          "feature_not_supported",
          `unit "${field}" not supported for type time without time zone`,
          "0A000",
        );
      }
      return wrap(extractFromTime(field, micros));
    }
    case "timetz": {
      const v = src.v as unknown as { micros: bigint; offsetSec: number };
      if (field === "timezone") return wrap(numericFromBigInt(BigInt(v.offsetSec)));
      if (field === "timezone_hour") return wrap(numericFromBigInt(BigInt(Math.trunc(v.offsetSec / 3600))));
      if (field === "timezone_minute") return wrap(numericFromBigInt(BigInt(Math.trunc((v.offsetSec % 3600) / 60))));
      if (field === "epoch") return wrap(microsToNumericSeconds(v.micros - BigInt(v.offsetSec) * USECS_PER_SEC));
      if (!hasTimeField(field)) {
        throw pgError("feature_not_supported", `unit "${field}" not supported for type time with time zone`, "0A000");
      }
      return wrap(extractFromTime(field, v.micros));
    }
    case "interval":
      return wrap(extractFromInterval(field, src.v as Interval));
    default:
      throw pgError("datatype_mismatch", `function extract(unknown, ${src.t}) does not exist`, "42883");
  }
}

function extractInfinity(
  field: string,
  positive: boolean,
  wrap: (n: Numeric) => TypedValue,
  typeName: string,
): TypedValue {
  const monotonic = new Set(["epoch", "julian", "year", "isoyear", "decade", "century", "millennium"]);
  if (monotonic.has(field)) {
    // PG returns +/-Infinity — representable only in float8; numeric supports inf too
    const inf: Numeric = { kind: "numeric", coef: 0n, dscale: 0, special: positive ? "inf" : "-inf" };
    return wrap(inf);
  }
  if (hasTimeField(field) || ["day", "month", "quarter", "week", "dow", "isodow", "doy"].includes(field)) {
    return wrap(makeNumeric(0n, 0)); // PG returns NULL actually
  }
  throw pgError("invalid_parameter_value", `unit "${field}" not supported for type ${typeName}`);
}

function hasTimeField(field: string): boolean {
  return ["hour", "minute", "second", "milliseconds", "microseconds"].includes(field);
}

function extractFromTime(field: string, micros: bigint): Numeric {
  switch (field) {
    case "hour":
      return numericFromBigInt(micros / USECS_PER_HOUR);
    case "minute":
      return numericFromBigInt((micros / USECS_PER_MIN) % 60n);
    case "second":
      return makeNumeric(micros % USECS_PER_MIN, 6);
    case "milliseconds":
      return makeNumeric((micros % USECS_PER_MIN) / 1000n, 3);
    case "microseconds":
      return numericFromBigInt(micros % USECS_PER_MIN);
    default:
      throw pgError("invalid_parameter_value", `unit "${field}" not recognized`);
  }
}

function extractFromDate(field: string, days: number, srcType: string): Numeric {
  const { y, m, d } = daysToCivil(days);
  switch (field) {
    case "year":
      return numericFromBigInt(BigInt(y));
    case "month":
      return numericFromBigInt(BigInt(m));
    case "day":
      return numericFromBigInt(BigInt(d));
    case "quarter":
      return numericFromBigInt(BigInt(Math.floor((m - 1) / 3) + 1));
    case "decade":
      return numericFromBigInt(BigInt(Math.floor(y / 10)));
    case "century": {
      const c = y > 0 ? Math.floor((y - 1) / 100) + 1 : -(Math.floor((-y - 1) / 100) + 1) + 1;
      return numericFromBigInt(BigInt(y > 0 ? Math.floor((y - 1) / 100) + 1 : c));
    }
    case "millennium":
      return numericFromBigInt(BigInt(y > 0 ? Math.floor((y - 1) / 1000) + 1 : Math.floor(y / 1000)));
    case "dow":
      return numericFromBigInt(BigInt(dayOfWeek(days)));
    case "isodow": {
      const dw = dayOfWeek(days);
      return numericFromBigInt(BigInt(dw === 0 ? 7 : dw));
    }
    case "doy":
      return numericFromBigInt(BigInt(days - civilToDays(y, 1, 1) + 1));
    case "week":
      return numericFromBigInt(BigInt(isoWeek(days).week));
    case "isoyear":
      return numericFromBigInt(BigInt(isoWeek(days).year));
    case "epoch":
      return numericFromBigInt(BigInt(days) * 86400n + 946_684_800n);
    case "julian":
      return numericFromBigInt(BigInt(days + 2451545));
    case "hour":
    case "minute":
    case "second":
    case "milliseconds":
    case "microseconds":
      if (srcType === "date") {
        throw pgError("feature_not_supported", `unit "${field}" not supported for type date`, "0A000");
      }
      return makeNumeric(0n, field === "second" ? 6 : 0);
    default:
      throw pgError("invalid_parameter_value", `unit "${field}" not recognized for type ${srcType}`);
  }
}

function extractFromInterval(field: string, v: Interval): Numeric {
  const years = Math.trunc(v.months / 12);
  switch (field) {
    case "year":
      return numericFromBigInt(BigInt(years));
    case "month":
      return numericFromBigInt(BigInt(v.months % 12));
    case "day":
      return numericFromBigInt(BigInt(v.days));
    case "hour":
      return numericFromBigInt(v.micros / USECS_PER_HOUR);
    case "minute":
      return numericFromBigInt((v.micros / USECS_PER_MIN) % 60n);
    case "second":
      return makeNumeric(v.micros % USECS_PER_MIN, 6);
    case "milliseconds":
      return makeNumeric((v.micros % USECS_PER_MIN) / 1000n, 3);
    case "microseconds":
      return numericFromBigInt(v.micros % USECS_PER_MIN);
    case "quarter":
      return numericFromBigInt(
        BigInt(Math.floor(((((v.months % 12) + 12) % 12) - (v.months % 12 < 0 ? 0 : 0)) / 3) + 1),
      );
    case "decade":
      return numericFromBigInt(BigInt(Math.trunc(v.months / 120)));
    case "century":
      return numericFromBigInt(BigInt(Math.trunc(v.months / 1200)));
    case "millennium":
      return numericFromBigInt(BigInt(Math.trunc(v.months / 12000)));
    case "epoch": {
      const seconds =
        BigInt(v.months) * 2_629_800n + // PG: months * 30.436875 days
        BigInt(v.days) * 86400n;
      const microsPart = v.micros;
      return makeNumeric(seconds * 1_000_000n + microsPart, 6);
    }
    default:
      throw pgError("invalid_parameter_value", `unit "${field}" not supported for type interval`);
  }
}

function microsToNumericSeconds(micros: bigint): Numeric {
  return makeNumeric(micros, 6);
}

/** ISO 8601 week + iso year for a day number. */
export function isoWeek(days: number): { week: number; year: number } {
  const { y } = daysToCivil(days);
  const week1Monday = (yy: number): number => {
    const jan4 = civilToDays(yy, 1, 4);
    const dw = dayOfWeek(jan4);
    const isoDw = dw === 0 ? 7 : dw;
    return jan4 - (isoDw - 1);
  };
  let year = y;
  let start = week1Monday(y);
  if (days < start) {
    year = y - 1;
    start = week1Monday(year);
  } else {
    const nextStart = week1Monday(y + 1);
    if (days >= nextStart) {
      year = y + 1;
      start = nextStart;
    }
  }
  return { week: Math.floor((days - start) / 7) + 1, year };
}

// --- date_trunc -------------------------------------------------------------------

export function dateTruncDays(field: string, days: number): number {
  const { y, m } = daysToCivil(days);
  switch (field) {
    case "millennium":
      return civilToDays(Math.floor((y - 1) / 1000) * 1000 + 1, 1, 1);
    case "century":
      return civilToDays(Math.floor((y - 1) / 100) * 100 + 1, 1, 1);
    case "decade":
      return civilToDays(Math.floor(y / 10) * 10, 1, 1);
    case "year":
      return civilToDays(y, 1, 1);
    case "quarter":
      return civilToDays(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
    case "month":
      return civilToDays(y, m, 1);
    case "week": {
      const dw = dayOfWeek(days);
      const isoDw = dw === 0 ? 7 : dw;
      return days - (isoDw - 1);
    }
    case "day":
      return days;
    default:
      throw pgError("invalid_parameter_value", `unit "${field}" not supported`);
  }
}

export function dateTruncMicros(field: string, micros: bigint): bigint {
  const { days, tod } = splitTs(micros);
  switch (field) {
    case "hour":
      return BigInt(days) * USECS_PER_DAY + (tod / USECS_PER_HOUR) * USECS_PER_HOUR;
    case "minute":
      return BigInt(days) * USECS_PER_DAY + (tod / USECS_PER_MIN) * USECS_PER_MIN;
    case "second":
      return BigInt(days) * USECS_PER_DAY + (tod / USECS_PER_SEC) * USECS_PER_SEC;
    case "milliseconds":
      return BigInt(days) * USECS_PER_DAY + (tod / 1000n) * 1000n;
    case "microseconds":
      return micros;
    default:
      return BigInt(dateTruncDays(field, days)) * USECS_PER_DAY;
  }
}

export function dateTruncInterval(field: string, v: Interval): Interval {
  switch (field) {
    case "millennium":
      return makeInterval(Math.trunc(v.months / 12000) * 12000, 0, 0n);
    case "century":
      return makeInterval(Math.trunc(v.months / 1200) * 1200, 0, 0n);
    case "decade":
      return makeInterval(Math.trunc(v.months / 120) * 120, 0, 0n);
    case "year":
      return makeInterval(Math.trunc(v.months / 12) * 12, 0, 0n);
    case "quarter":
      return makeInterval(Math.trunc(v.months / 3) * 3, 0, 0n);
    case "month":
      return makeInterval(v.months, 0, 0n);
    case "day":
      return makeInterval(v.months, v.days, 0n);
    case "hour":
      return makeInterval(v.months, v.days, (v.micros / USECS_PER_HOUR) * USECS_PER_HOUR);
    case "minute":
      return makeInterval(v.months, v.days, (v.micros / USECS_PER_MIN) * USECS_PER_MIN);
    case "second":
      return makeInterval(v.months, v.days, (v.micros / USECS_PER_SEC) * USECS_PER_SEC);
    case "milliseconds":
      return makeInterval(v.months, v.days, (v.micros / 1000n) * 1000n);
    case "microseconds":
      return v;
    default:
      throw pgError("invalid_parameter_value", `unit "${field}" not supported for type interval`);
  }
}

// --- make_* ---------------------------------------------------------------------

export function makeDateDatum(y: number, m: number, d: number): number {
  if (y === 0 || !isValidCivil(y < 0 ? y + 1 : y, m, d)) {
    throw pgError(
      "invalid_datetime",
      `date field value out of range: ${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      "22008",
    );
  }
  return civilToDays(y < 0 ? y + 1 : y, m, d);
}

export function makeTimeDatum(h: number, min: number, sec: number): bigint {
  if (h < 0 || h > 24 || min < 0 || min > 59 || sec < 0 || sec >= 60 || (h === 24 && (min > 0 || sec > 0))) {
    throw pgError("invalid_datetime", `time field value out of range: ${h}:${min}:${sec}`, "22008");
  }
  return BigInt(h) * USECS_PER_HOUR + BigInt(min) * USECS_PER_MIN + BigInt(Math.round(sec * 1_000_000));
}

export function justifyHours(v: Interval): Interval {
  const extraDays = v.micros / USECS_PER_DAY;
  return makeInterval(v.months, v.days + Number(extraDays), v.micros % USECS_PER_DAY);
}

export function justifyDays(v: Interval): Interval {
  const extraMonths = Math.trunc(v.days / 30);
  return makeInterval(v.months + extraMonths, v.days % 30, v.micros);
}

export function justifyInterval(v: Interval): Interval {
  let months = v.months;
  let days = v.days;
  let micros = v.micros;
  days += Number(micros / USECS_PER_DAY);
  micros %= USECS_PER_DAY;
  months += Math.trunc(days / 30);
  days %= 30;
  if (micros < 0n && (days > 0 || months > 0)) {
    micros += USECS_PER_DAY;
    days -= 1;
  }
  if (days < 0 && months > 0) {
    days += 30;
    months -= 1;
  }
  if (micros > 0n && (days < 0 || months < 0)) {
    micros -= USECS_PER_DAY;
    days += 1;
  }
  if (days > 0 && months < 0) {
    days -= 30;
    months += 1;
  }
  return makeInterval(months, days, micros);
}

/** age(a, b): symbolic year/month/day difference like PG timestamp_age */
export function timestampAge(a: bigint, b: bigint): Interval {
  const split = (m: bigint): { y: number; mo: number; d: number; tod: bigint } => {
    const { days, tod } = splitTs(m);
    const c = daysToCivil(days);
    return { y: c.y, mo: c.m, d: c.d, tod };
  };
  const A = split(a);
  const B = split(b);
  let years = A.y - B.y;
  let months = A.mo - B.mo;
  let days = A.d - B.d;
  let micros = A.tod - B.tod;
  const sign = a >= b ? 1 : -1;
  if (sign > 0) {
    if (micros < 0n) {
      micros += USECS_PER_DAY;
      days -= 1;
    }
    if (days < 0) {
      // PG borrows the length of tm1's own month (timestamp_age / day_tab[...][tm_mon-1])
      days += daysInMonth(A.y, A.mo);
      months -= 1;
    }
    if (months < 0) {
      months += 12;
      years -= 1;
    }
  } else {
    if (micros > 0n) {
      micros -= USECS_PER_DAY;
      days += 1;
    }
    if (days > 0) {
      days -= daysInMonth(B.y, B.mo === 12 ? 12 : B.mo);
      months += 1;
    }
    if (months > 0) {
      months -= 12;
      years += 1;
    }
  }
  return makeInterval(years * 12 + months, days, micros);
}

export function numericSecondsToMicros(n: Numeric): bigint {
  const text = `${n.coef < 0n ? "-" : ""}${(n.coef < 0n ? -n.coef : n.coef).toString()}`;
  void text;
  // rescale to 6 fraction digits
  let coef = n.coef;
  let ds = n.dscale;
  while (ds < 6) {
    coef *= 10n;
    ds++;
  }
  while (ds > 6) {
    const q = coef / 10n;
    const r = coef % 10n;
    coef = q + (r >= 5n ? 1n : r <= -5n ? -1n : 0n);
    ds--;
  }
  return coef;
}

export function parseNumericArg(text: string): Numeric {
  return parseNumeric(text);
}
