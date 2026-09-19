import { pgError } from "../errors/error.ts";

/**
 * Internal representations (mirroring PostgreSQL):
 * - date: integer days since 2000-01-01 (PG epoch); ±Infinity as special
 * - time: bigint microseconds since midnight (0 .. 86_400_000_000 inclusive)
 * - timestamp / timestamptz: bigint microseconds since 2000-01-01 00:00:00 (UTC for tz)
 * - interval: { months, days, micros }
 */

export const PG_EPOCH_JDATE = 2451545; // 2000-01-01 as Julian day
export const UNIX_EPOCH_MICROS_FROM_PG = -946_684_800_000_000n; // 1970-01-01 in PG micros
export const DATE_POS_INF = 2147483647;
export const DATE_NEG_INF = -2147483648;
export const TS_POS_INF = 9223372036854775807n;
export const TS_NEG_INF = -9223372036854775808n;

export interface Interval {
  readonly kind: "interval";
  readonly months: number;
  readonly days: number;
  readonly micros: bigint;
}

export function makeInterval(months: number, days: number, micros: bigint): Interval {
  return { kind: "interval", months, days, micros };
}

export function isInterval(v: unknown): v is Interval {
  return typeof v === "object" && v !== null && (v as any).kind === "interval";
}

export const USECS_PER_DAY = 86_400_000_000n;
export const USECS_PER_HOUR = 3_600_000_000n;
export const USECS_PER_MIN = 60_000_000n;
export const USECS_PER_SEC = 1_000_000n;

// --- civil calendar <-> days (Howard Hinnant's algorithm), day 0 = 2000-01-01

export function civilToDays(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const unixDays = era * 146097 + doe - 719468;
  return unixDays - 10957; // shift epoch 1970-01-01 -> 2000-01-01
}

export function daysToCivil(days: number): { y: number; m: number; d: number } {
  const z = days + 10957 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(y: number, m: number): number {
  if (m === 2 && isLeapYear(y)) return 29;
  return DAYS_IN_MONTH[m - 1]!;
}

export function isValidCivil(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

/** day of week, 0=Sunday (2000-01-01 was a Saturday = 6) */
export function dayOfWeek(days: number): number {
  return (((days + 6) % 7) + 7) % 7;
}

// --- parsing ------------------------------------------------------------

function bad(type: string, text: string): never {
  throw pgError("invalid_text_representation", `invalid input syntax for type ${type}: "${text}"`, "22007");
}

function outOfRange(_type: string, text: string): never {
  throw pgError("invalid_datetime", `date/time field value out of range: "${text}"`, "22008");
}

const DATE_RE = /^(\d{1,7})-(\d{1,2})-(\d{1,2})(?:\s*(BC|AD|bc|ad))?$/;
const DATE_SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{1,7})$/;

/** Parse a date string -> days since 2000-01-01. DateStyle ISO, MDY. */
export function parseDate(text: string): number {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower === "infinity") return DATE_POS_INF;
  if (lower === "-infinity") return DATE_NEG_INF;
  if (lower === "epoch") return civilToDays(1970, 1, 1);
  let y: number;
  let m: number;
  let d: number;
  let mm = DATE_RE.exec(t);
  if (mm) {
    y = Number(mm[1]);
    m = Number(mm[2]);
    d = Number(mm[3]);
    if (mm[4] && mm[4].toLowerCase() === "bc") y = -(y - 1);
  } else if ((mm = DATE_SLASH_RE.exec(t))) {
    // MDY datestyle
    m = Number(mm[1]);
    d = Number(mm[2]);
    y = Number(mm[3]);
  } else if (/^\d{8}$/.test(t)) {
    y = Number(t.slice(0, 4));
    m = Number(t.slice(4, 6));
    d = Number(t.slice(6, 8));
  } else {
    // fall back: maybe it is a full timestamp; take the date part
    const ts = tryParseTimestampParts(t);
    if (ts) {
      if (!isValidCivil(ts.y, ts.m, ts.d)) outOfRange("date", text);
      return civilToDays(ts.y, ts.m, ts.d);
    }
    bad("date", text);
  }
  if (!isValidCivil(y, m, d)) outOfRange("date", text);
  if (y === 0) bad("date", text);
  return civilToDays(y, m, d);
}

const TIME_RE = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(\.\d+)?)?$/;

/** Parse time -> micros since midnight. */
export function parseTime(text: string): bigint {
  const t = text.trim();
  // allow trailing timezone offset (ignored for `time`)
  const m = TIME_RE.exec(t.replace(/\s*[+-]\d{1,2}(:\d{2})?(:\d{2})?$/, "").replace(/\s*(UTC|GMT|Z|z)$/, ""));
  if (!m) bad("time", text);
  const hh = Number(m[1]);
  const mi = Number(m[2]);
  const ss = Number(m[3] ?? 0);
  const frac = m[4] ? Math.round(Number(m[4]) * 1_000_000) : 0;
  if (hh > 24 || mi > 59 || ss > 60) outOfRange("time", text);
  const total = BigInt(hh) * USECS_PER_HOUR + BigInt(mi) * USECS_PER_MIN + BigInt(ss) * USECS_PER_SEC + BigInt(frac);
  if (total > USECS_PER_DAY) outOfRange("time", text);
  return total;
}

interface TsParts {
  y: number;
  m: number;
  d: number;
  micros: bigint; // time-of-day
  offsetSec: number | null; // explicit zone offset if present
}

const TS_RE =
  /^(\d{1,7})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(\.\d+)?)?)?\s*(Z|z|UTC|GMT|[+-]\d{1,2}(?::?\d{2})?(?::\d{2})?)?\s*(BC|AD|bc|ad)?$/;

function tryParseTimestampParts(text: string): TsParts | null {
  const m = TS_RE.exec(text.trim());
  if (!m) return null;
  let y = Number(m[1]);
  if (m[9] && m[9].toLowerCase() === "bc") y = -(y - 1);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4] ?? 0);
  const mi = Number(m[5] ?? 0);
  const ss = Number(m[6] ?? 0);
  const frac = m[7] ? Math.round(Number(m[7]) * 1_000_000) : 0;
  if (hh > 24 || mi > 59 || ss > 60) return null;
  let offsetSec: number | null = null;
  const z = m[8];
  if (z) {
    if (z === "Z" || z === "z" || z === "UTC" || z === "GMT") offsetSec = 0;
    else {
      const zm = /^([+-])(\d{1,2})(?::?(\d{2}))?(?::(\d{2}))?$/.exec(z);
      if (!zm) return null;
      const sign = zm[1] === "-" ? -1 : 1;
      offsetSec = sign * (Number(zm[2]) * 3600 + Number(zm[3] ?? 0) * 60 + Number(zm[4] ?? 0));
    }
  }
  const micros = BigInt(hh) * USECS_PER_HOUR + BigInt(mi) * USECS_PER_MIN + BigInt(ss) * USECS_PER_SEC + BigInt(frac);
  return { y, m: mo, d, micros, offsetSec };
}

/** Parse timestamp (no tz interpretation) -> PG micros. */
export function parseTimestamp(text: string): bigint {
  const t = text.trim().toLowerCase();
  if (t === "infinity") return TS_POS_INF;
  if (t === "-infinity") return TS_NEG_INF;
  if (t === "epoch") return BigInt(civilToDays(1970, 1, 1)) * USECS_PER_DAY;
  const p = tryParseTimestampParts(text);
  if (!p) bad("timestamp", text);
  if (!isValidCivil(p.y, p.m, p.d)) outOfRange("timestamp", text);
  return BigInt(civilToDays(p.y, p.m, p.d)) * USECS_PER_DAY + p.micros;
}

/**
 * Parse timestamptz -> UTC micros. `sessionOffsetSec` applies when the input
 * has no explicit zone (session TimeZone; we default to UTC).
 */
export function parseTimestampTz(text: string, zoneOffsetForNaive: (naiveMicros: bigint) => number): bigint {
  const t = text.trim().toLowerCase();
  if (t === "infinity") return TS_POS_INF;
  if (t === "-infinity") return TS_NEG_INF;
  if (t === "epoch") return BigInt(civilToDays(1970, 1, 1)) * USECS_PER_DAY;
  const p = tryParseTimestampParts(text);
  if (!p) bad("timestamp with time zone", text);
  if (!isValidCivil(p.y, p.m, p.d)) outOfRange("timestamp with time zone", text);
  const naive = BigInt(civilToDays(p.y, p.m, p.d)) * USECS_PER_DAY + p.micros;
  const off = p.offsetSec !== null ? p.offsetSec : zoneOffsetForNaive(naive);
  return naive - BigInt(off) * USECS_PER_SEC;
}

// --- formatting ----------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

export function formatDate(days: number): string {
  if (days === DATE_POS_INF) return "infinity";
  if (days === DATE_NEG_INF) return "-infinity";
  const { y, m, d } = daysToCivil(days);
  if (y <= 0) return `${pad4(1 - y)}-${pad2(m)}-${pad2(d)} BC`;
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}

export function formatTimeOfDay(micros: bigint): string {
  const hh = Number(micros / USECS_PER_HOUR);
  const rem1 = micros % USECS_PER_HOUR;
  const mi = Number(rem1 / USECS_PER_MIN);
  const rem2 = rem1 % USECS_PER_MIN;
  const ss = Number(rem2 / USECS_PER_SEC);
  const frac = Number(rem2 % USECS_PER_SEC);
  let out = `${pad2(hh)}:${pad2(mi)}:${pad2(ss)}`;
  if (frac !== 0) {
    out += `.${String(frac).padStart(6, "0")}`.replace(/0+$/, "");
  }
  return out;
}

/** floor-divide micros into (days, timeOfDay) */
export function splitTs(micros: bigint): { days: number; tod: bigint } {
  let days = micros / USECS_PER_DAY;
  let tod = micros % USECS_PER_DAY;
  if (tod < 0n) {
    tod += USECS_PER_DAY;
    days -= 1n;
  }
  return { days: Number(days), tod };
}

export function formatTimestamp(micros: bigint): string {
  if (micros === TS_POS_INF) return "infinity";
  if (micros === TS_NEG_INF) return "-infinity";
  const { days, tod } = splitTs(micros);
  const { y, m, d } = daysToCivil(days);
  const datePart = y <= 0 ? `${pad4(1 - y)}-${pad2(m)}-${pad2(d)}` : `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
  const bc = y <= 0 ? " BC" : "";
  return `${datePart} ${formatTimeOfDay(tod)}${bc}`;
}

/** Format a UTC timestamptz in a fixed zone offset (seconds east of UTC). */
export function formatTimestampTz(micros: bigint, offsetSec: number): string {
  if (micros === TS_POS_INF) return "infinity";
  if (micros === TS_NEG_INF) return "-infinity";
  const local = micros + BigInt(offsetSec) * USECS_PER_SEC;
  const { days, tod } = splitTs(local);
  const { y, m, d } = daysToCivil(days);
  const abs = Math.abs(offsetSec);
  const oh = Math.floor(abs / 3600);
  const om = Math.floor((abs % 3600) / 60);
  const os = abs % 60;
  let zone = `${offsetSec < 0 ? "-" : "+"}${pad2(oh)}`;
  if (om !== 0 || os !== 0) zone += `:${pad2(om)}`;
  if (os !== 0) zone += `:${pad2(os)}`;
  const datePart = y <= 0 ? `${pad4(1 - y)}-${pad2(m)}-${pad2(d)}` : `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
  const bc = y <= 0 ? " BC" : "";
  return `${datePart} ${formatTimeOfDay(tod)}${zone}${bc}`;
}

// --- interval ------------------------------------------------------------

const INTERVAL_UNIT: Record<string, { months?: number; days?: number; micros?: bigint }> = {
  microsecond: { micros: 1n },
  microseconds: { micros: 1n },
  us: { micros: 1n },
  millisecond: { micros: 1000n },
  milliseconds: { micros: 1000n },
  ms: { micros: 1000n },
  second: { micros: USECS_PER_SEC },
  seconds: { micros: USECS_PER_SEC },
  sec: { micros: USECS_PER_SEC },
  secs: { micros: USECS_PER_SEC },
  s: { micros: USECS_PER_SEC },
  minute: { micros: USECS_PER_MIN },
  minutes: { micros: USECS_PER_MIN },
  min: { micros: USECS_PER_MIN },
  mins: { micros: USECS_PER_MIN },
  m: { micros: USECS_PER_MIN },
  hour: { micros: USECS_PER_HOUR },
  hours: { micros: USECS_PER_HOUR },
  h: { micros: USECS_PER_HOUR },
  hr: { micros: USECS_PER_HOUR },
  hrs: { micros: USECS_PER_HOUR },
  day: { days: 1 },
  days: { days: 1 },
  d: { days: 1 },
  week: { days: 7 },
  weeks: { days: 7 },
  w: { days: 7 },
  month: { months: 1 },
  months: { months: 1 },
  mon: { months: 1 },
  mons: { months: 1 },
  year: { months: 12 },
  years: { months: 12 },
  y: { months: 12 },
  yr: { months: 12 },
  yrs: { months: 12 },
  decade: { months: 120 },
  decades: { months: 120 },
  century: { months: 1200 },
  centuries: { months: 1200 },
  millennium: { months: 12000 },
  millenniums: { months: 12000 },
  millennia: { months: 12000 },
};

export function parseInterval(text: string): Interval {
  const t = text.trim();
  if (t === "") bad("interval", text);
  // ISO 8601: P1Y2M3DT4H5M6.7S
  if (/^[Pp]/.test(t)) {
    const iso =
      /^[Pp](?:(-?\d+(?:\.\d+)?)[Yy])?(?:(-?\d+(?:\.\d+)?)[Mm])?(?:(-?\d+(?:\.\d+)?)[Ww])?(?:(-?\d+(?:\.\d+)?)[Dd])?(?:[Tt](?:(-?\d+(?:\.\d+)?)[Hh])?(?:(-?\d+(?:\.\d+)?)[Mm])?(?:(-?\d+(?:\.\d+)?)[Ss])?)?$/.exec(
        t,
      );
    if (!iso) bad("interval", text);
    let months = 0;
    let days = 0;
    let micros = 0n;
    if (iso[1]) months += Math.trunc(Number(iso[1]) * 12);
    if (iso[2]) months += Math.trunc(Number(iso[2]));
    if (iso[3]) days += Math.trunc(Number(iso[3]) * 7);
    if (iso[4]) days += Math.trunc(Number(iso[4]));
    if (iso[5]) micros += BigInt(Math.round(Number(iso[5]) * 3_600_000_000));
    if (iso[6]) micros += BigInt(Math.round(Number(iso[6]) * 60_000_000));
    if (iso[7]) micros += BigInt(Math.round(Number(iso[7]) * 1_000_000));
    return makeInterval(months, days, micros);
  }
  let months = 0;
  let days = 0;
  let micros = 0n;
  let matchedAny = false;
  let rest = t;
  // "ago" suffix negates everything
  let ago = false;
  if (/\s+ago$/i.test(rest)) {
    ago = true;
    rest = rest.replace(/\s+ago$/i, "");
  }
  // consume leading sign applied to an HH:MM[:SS] chunk or quantity-unit pairs
  const tokens = rest.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    // time-of-day chunk [+-]HH:MM[:SS[.f]]
    const tm = /^([+-]?)(\d+):(\d{1,2})(?::(\d{1,2})(\.\d+)?)?$/.exec(tok);
    if (tm) {
      const sign = tm[1] === "-" ? -1n : 1n;
      const hh = BigInt(tm[2]!);
      const mi = BigInt(tm[3]!);
      const ss = BigInt(tm[4] ?? "0");
      const frac = tm[5] ? BigInt(Math.round(Number(tm[5]) * 1_000_000)) : 0n;
      micros += sign * (hh * USECS_PER_HOUR + mi * USECS_PER_MIN + ss * USECS_PER_SEC + frac);
      matchedAny = true;
      i += 1;
      continue;
    }
    // sql standard year-month: [+-]Y-M
    const ym = /^([+-]?)(\d+)-(\d{1,2})$/.exec(tok);
    if (ym) {
      const sign = ym[1] === "-" ? -1 : 1;
      months += sign * (Number(ym[2]) * 12 + Number(ym[3]));
      matchedAny = true;
      i += 1;
      continue;
    }
    // quantity unit
    const qm = /^([+-]?\d+(?:\.\d+)?)$/.exec(tok);
    if (qm && i + 1 < tokens.length) {
      const unit = INTERVAL_UNIT[tokens[i + 1]!.toLowerCase().replace(/,$/, "")];
      if (!unit) bad("interval", text);
      const qty = Number(qm[1]);
      if (unit.months) {
        const total = qty * unit.months;
        const wholeMonths = Math.trunc(total);
        months += wholeMonths;
        // fractional months spill into days (30 days per month)
        const fracMonths = total - wholeMonths;
        if (fracMonths !== 0) days += Math.trunc(fracMonths * 30);
      }
      if (unit.days) {
        const total = qty * unit.days;
        const whole = Math.trunc(total);
        days += whole;
        const frac = total - whole;
        if (frac !== 0) micros += BigInt(Math.round(frac * 86_400_000_000));
      }
      if (unit.micros) {
        micros += BigInt(Math.round(qty * Number(unit.micros)));
      }
      matchedAny = true;
      i += 2;
      continue;
    }
    // trailing bare number without a unit is taken as seconds (DecodeInterval)
    if (qm && i === tokens.length - 1) {
      micros += BigInt(Math.round(Number(qm[1]) * 1_000_000));
      matchedAny = true;
      i += 1;
      continue;
    }
    bad("interval", text);
  }
  if (!matchedAny) bad("interval", text);
  if (ago) return makeInterval(-months, -days, -micros);
  return makeInterval(months, days, micros);
}

/** Render interval in DateStyle 'postgres' (the default). */
export function formatInterval(v: Interval): string {
  // Mirrors PG's IntervalStyle=postgres output (AddPostgresIntPart): a positive
  // field following a negative one is prefixed with "+"; units are plural unless value == 1.
  const parts: string[] = [];
  let isBefore = false;
  const addPart = (value: number, unit: string): void => {
    if (value === 0) return;
    const sign = isBefore && value > 0 ? "+" : "";
    parts.push(`${sign}${value} ${unit}${value !== 1 ? "s" : ""}`);
    isBefore = value < 0;
  };
  addPart(Math.trunc(v.months / 12), "year");
  addPart(v.months % 12, "mon");
  addPart(v.days, "day");
  if (v.micros !== 0n || parts.length === 0) {
    const neg = v.micros < 0n;
    const abs = neg ? -v.micros : v.micros;
    const hh = abs / USECS_PER_HOUR;
    const rem1 = abs % USECS_PER_HOUR;
    const mi = Number(rem1 / USECS_PER_MIN);
    const rem2 = rem1 % USECS_PER_MIN;
    const ss = Number(rem2 / USECS_PER_SEC);
    const frac = Number(rem2 % USECS_PER_SEC);
    const sign = neg ? "-" : isBefore ? "+" : "";
    let time = `${sign}${hh < 10n ? `0${hh}` : String(hh)}:${pad2(mi)}:${pad2(ss)}`;
    if (frac !== 0) time += `.${String(frac).padStart(6, "0")}`.replace(/0+$/, "");
    parts.push(time);
  }
  return parts.join(" ");
}

export function intervalCmp(a: Interval, b: Interval): number {
  // PG compares on the equivalent total micros with 30-day months, 24h days
  const ta = intervalTotalMicros(a);
  const tb = intervalTotalMicros(b);
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

export function intervalTotalMicros(v: Interval): bigint {
  return (BigInt(v.months) * 30n + BigInt(v.days)) * USECS_PER_DAY + v.micros;
}

export function intervalAdd(a: Interval, b: Interval): Interval {
  return makeInterval(a.months + b.months, a.days + b.days, a.micros + b.micros);
}

export function intervalNeg(a: Interval): Interval {
  return makeInterval(-a.months, -a.days, -a.micros);
}

export function intervalJustifyHours(v: Interval): Interval {
  let days = v.days;
  let micros = v.micros;
  const extraDays = micros / USECS_PER_DAY;
  days += Number(extraDays);
  micros -= extraDays * USECS_PER_DAY;
  if (days > 0 && micros < 0n) {
    days -= 1;
    micros += USECS_PER_DAY;
  } else if (days < 0 && micros > 0n) {
    days += 1;
    micros -= USECS_PER_DAY;
  }
  return makeInterval(v.months, days, micros);
}

export function intervalJustifyDays(v: Interval): Interval {
  let months = v.months;
  let days = v.days;
  const extraMonths = Math.trunc(days / 30);
  months += extraMonths;
  days -= extraMonths * 30;
  if (months > 0 && days < 0) {
    months -= 1;
    days += 30;
  } else if (months < 0 && days > 0) {
    months += 1;
    days -= 30;
  }
  return makeInterval(months, days, v.micros);
}

/** date + interval => timestamp micros arithmetic (add months honoring month-end clamping) */
export function timestampAddInterval(ts: bigint, iv: Interval): bigint {
  if (ts === TS_POS_INF || ts === TS_NEG_INF) return ts;
  let result = ts;
  if (iv.months !== 0) {
    const { days, tod } = splitTs(result);
    const civil = daysToCivil(days);
    let totalMonths = civil.y * 12 + (civil.m - 1) + iv.months;
    const y = Math.floor(totalMonths / 12);
    const m = totalMonths - y * 12 + 1;
    totalMonths = 0;
    const d = Math.min(civil.d, daysInMonth(y, m));
    result = BigInt(civilToDays(y, m, d)) * USECS_PER_DAY + tod;
  }
  if (iv.days !== 0) result += BigInt(iv.days) * USECS_PER_DAY;
  result += iv.micros;
  return result;
}
