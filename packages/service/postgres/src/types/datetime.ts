import { pgError, unsupported } from "../errors/error.ts";

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

/** time with time zone: local time of day plus the zone's offset in seconds east of UTC. */
export interface TimeTz {
  micros: bigint;
  offsetSec: number;
}

/** timetz_cmp: by the UTC instant, then by zone (the zone further west sorts higher). */
export function timetzCmp(a: TimeTz, b: TimeTz): number {
  const ua = a.micros - BigInt(a.offsetSec) * USECS_PER_SEC;
  const ub = b.micros - BigInt(b.offsetSec) * USECS_PER_SEC;
  if (ua !== ub) return ua < ub ? -1 : 1;
  return a.offsetSec === b.offsetSec ? 0 : a.offsetSec > b.offsetSec ? -1 : 1;
}

/** Wrap micros into one day, as timetz arithmetic and AT TIME ZONE do. */
export function wrapTimeOfDay(micros: bigint): bigint {
  let m = micros % USECS_PER_DAY;
  if (m < 0n) m += USECS_PER_DAY;
  return m;
}

/** The naive local timestamp of `tod` on the current date (the PG epoch date without a clock). */
export function todayAt(now: DatetimeNow | undefined, tod: bigint): bigint {
  if (!now) return tod;
  const day = splitTs(now.utc + BigInt(now.offsetSec) * USECS_PER_SEC).days;
  return BigInt(day) * USECS_PER_DAY + tod;
}

const TIMETZ_RE =
  /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(\.\d*)?)?\s*(?:(z|utc|gmt)|([+-])(\d{1,2})(?::?(\d{2}))?(?::(\d{2}))?|([a-z][a-z0-9_/+-]*))?$/i;

/**
 * Parse timetz input: a time of day and an optional zone (numeric offset, Z / UTC / GMT). Without a
 * zone the session TimeZone's offset applies, taken on the current date as PG does; `zoneOffsetToday`
 * resolves it for a time of day.
 */
export function parseTimeTz(text: string, zoneOffsetToday: (todMicros: bigint) => number): TimeTz {
  const t = text.trim();
  const m = TIMETZ_RE.exec(t);
  if (!m)
    throw pgError(
      "invalid_text_representation",
      `invalid input syntax for type time with time zone: "${text}"`,
      "22007",
    );
  if (m[10] !== undefined) {
    // a full zone name needs a date; abbreviations (EST, CEST, ...) are not modelled
    if (m[10].includes("/")) {
      throw pgError(
        "invalid_text_representation",
        `invalid input syntax for type time with time zone: "${text}"`,
        "22007",
      );
    }
    throw unsupported(`time zone abbreviation "${m[10]}" in time with time zone input`);
  }
  const hh = Number(m[1]);
  const mi = Number(m[2]);
  const ss = Number(m[3] ?? 0);
  const frac = m[4] && m[4] !== "." ? Math.round(Number(`0${m[4]}`) * 1_000_000) : 0;
  const range = (): never => {
    throw pgError("invalid_datetime", `date/time field value out of range: "${text}"`, "22008");
  };
  if (hh > 24 || mi > 59 || ss > 60) range();
  const micros = BigInt(hh) * USECS_PER_HOUR + BigInt(mi) * USECS_PER_MIN + BigInt(ss) * USECS_PER_SEC + BigInt(frac);
  if (micros > USECS_PER_DAY) range();
  let offsetSec: number;
  if (m[5] !== undefined) offsetSec = 0;
  else if (m[6] !== undefined) {
    const oh = Number(m[7]);
    const om = Number(m[8] ?? 0);
    const os = Number(m[9] ?? 0);
    if (om > 59 || os > 59) range();
    if (oh > 15) {
      throw pgError("invalid_datetime", `time zone displacement out of range: "${text}"`, "22009");
    }
    offsetSec = (m[6] === "-" ? -1 : 1) * (oh * 3600 + om * 60 + os);
  } else offsetSec = zoneOffsetToday(micros);
  return { micros, offsetSec };
}

/** The transaction timestamp and the session zone's offset at it: what 'now' / 'today' input reads. */
export interface DatetimeNow {
  utc: bigint;
  offsetSec: number;
}

export type SpecialDatetimeType = "date" | "time" | "timetz" | "timestamp" | "timestamptz";

const DAY_WORDS: Record<string, number> = { today: 0, tomorrow: 1, yesterday: -1 };
const SPECIAL_REST_RE = /^(?:(\d{1,2}):(\d{1,2})(?::(\d{1,2})(\.\d+)?)?)?\s*(z|utc|gmt|[+-]\d{1,2}(?::?\d{2})?)?$/;

/**
 * The special datetime input words of datetktbl that depend on the clock — `now`, `today`,
 * `tomorrow`, `yesterday` (optionally followed by a time and/or numeric zone, as in
 * `'today 10:00'` or `'today +02'`) — plus `allballs` (midnight UTC) for time. `epoch` and
 * `±infinity` are clock-independent and handled by the regular parsers. Returns null when `text`
 * is not one of these words; the caller then parses it normally.
 */
export function parseSpecialDatetime(
  type: SpecialDatetimeType,
  text: string,
  now: () => DatetimeNow,
  zoneOffsetForNaive: (naiveMicros: bigint) => number,
): bigint | number | { micros: bigint; offsetSec: number } | null {
  const lower = text.trim().toLowerCase();
  if (lower === "allballs") {
    if (type === "time") return 0n;
    if (type === "timetz") return { micros: 0n, offsetSec: 0 };
    return null;
  }
  if (lower === "now") {
    const { utc, offsetSec } = now();
    const local = utc + BigInt(offsetSec) * USECS_PER_SEC;
    switch (type) {
      case "timestamptz":
        return utc;
      case "timestamp":
        return local;
      case "date":
        return splitTs(local).days;
      case "time":
        return splitTs(local).tod;
      case "timetz":
        return { micros: splitTs(local).tod, offsetSec };
    }
  }
  const word = /^[a-z]+/.exec(lower)?.[0];
  if (word === undefined || !(word in DAY_WORDS)) return null;
  const rest = SPECIAL_REST_RE.exec(lower.slice(word.length).trim());
  // PG rejects the day words for the time types
  if (!rest || type === "time" || type === "timetz") return null;
  const { utc, offsetSec } = now();
  const day = splitTs(utc + BigInt(offsetSec) * USECS_PER_SEC).days + DAY_WORDS[word]!;
  if (type === "date") return day;
  const hh = Number(rest[1] ?? 0);
  const mi = Number(rest[2] ?? 0);
  const ss = Number(rest[3] ?? 0);
  if (hh > 24 || mi > 59 || ss > 60) return null;
  const frac = rest[4] ? Math.round(Number(rest[4]) * 1_000_000) : 0;
  const naive =
    BigInt(day) * USECS_PER_DAY +
    BigInt(hh) * USECS_PER_HOUR +
    BigInt(mi) * USECS_PER_MIN +
    BigInt(ss) * USECS_PER_SEC +
    BigInt(frac);
  if (type === "timestamp") return naive;
  const zone = rest[5];
  let off: number;
  if (zone === undefined) off = zoneOffsetForNaive(naive);
  else if (zone === "z" || zone === "utc" || zone === "gmt") off = 0;
  else {
    const zm = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone)!;
    off = (zm[1] === "-" ? -1 : 1) * (Number(zm[2]) * 3600 + Number(zm[3] ?? 0) * 60);
  }
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

type DeltaUnit = "us" | "ms" | "s" | "min" | "h" | "d" | "w" | "mon" | "y" | "dec" | "c" | "mil";

/**
 * PostgreSQL's deltatktbl (src/backend/utils/adt/datetime.c): the unit words interval input accepts.
 * Lookups truncate the word to TOKMAXLEN (10) characters, as PG does, so "milliseconds" finds
 * "millisecon". `quarter` / `qtr` and `timezone*` are in the table but rejected by DecodeInterval.
 */
const DELTA_UNITS: Record<string, DeltaUnit | "ago" | "ignore"> = {
  "@": "ignore",
  ago: "ago",
  c: "c",
  cent: "c",
  centuries: "c",
  century: "c",
  d: "d",
  day: "d",
  days: "d",
  dec: "dec",
  decade: "dec",
  decades: "dec",
  decs: "dec",
  h: "h",
  hour: "h",
  hours: "h",
  hr: "h",
  hrs: "h",
  m: "min",
  microsecon: "us",
  mil: "mil",
  millennia: "mil",
  millennium: "mil",
  millisecon: "ms",
  mils: "mil",
  min: "min",
  mins: "min",
  minute: "min",
  minutes: "min",
  mon: "mon",
  mons: "mon",
  month: "mon",
  months: "mon",
  ms: "ms",
  msec: "ms",
  mseconds: "ms",
  msecs: "ms",
  s: "s",
  sec: "s",
  second: "s",
  seconds: "s",
  secs: "s",
  us: "us",
  usec: "us",
  useconds: "us",
  usecs: "us",
  w: "w",
  week: "w",
  weeks: "w",
  y: "y",
  year: "y",
  years: "y",
  yr: "y",
  yrs: "y",
  // datetktbl words DecodeInterval skips
  at: "ignore",
  on: "ignore",
};

/**
 * The core datetktbl words (datetime.c). ParseDateTime keeps a word glued to the digits after it
 * ("w2d") as one date field unless the word is one of these, which is why "1h30m" splits but
 * "3w2d" is rejected.
 */
const DATE_WORDS = new Set(
  (
    "-infinity ad allballs am apr april at aug august bc d dec december dow doy dst epoch feb february fri friday h " +
    "infinity isodow isoyear j jan january jd jul julian july jun june m mar march may mm mon monday nov november now " +
    "oct october on pm s sat saturday sep sept september sun sunday t thu thur thurs thursday today tomorrow tue tues " +
    "tuesday wed wednesday weds y yesterday"
  ).split(" "),
);

type IntervalField = { kind: "number" | "time" | "date" | "string" | "tz"; text: string };

/** ParseDateTime's field splitter, restricted to what interval input needs. */
function intervalFields(text: string): IntervalField[] | null {
  const fields: IntervalField[] = [];
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const isAlpha = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c);
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(c)) {
      while (isDigit(text[i])) i++;
      if (text[i] === ":") {
        i++;
        while (isDigit(text[i]) || text[i] === ":" || text[i] === ".") i++;
        fields.push({ kind: "time", text: text.slice(start, i) });
        continue;
      }
      if (text[i] === "-" || text[i] === "/" || text[i] === ".") {
        const delim = text[i]!;
        i++;
        if (isDigit(text[i])) {
          let kind: IntervalField["kind"] = delim === "." ? "number" : "date";
          while (isDigit(text[i])) i++;
          if (text[i] === delim) {
            kind = "date";
            i++;
            while (isDigit(text[i]) || text[i] === delim) i++;
          }
          fields.push({ kind, text: text.slice(start, i) });
        } else {
          while (i < text.length && (/[A-Za-z0-9]/.test(text[i]!) || text[i] === delim)) i++;
          fields.push({ kind: "date", text: text.slice(start, i).toLowerCase() });
        }
        continue;
      }
      fields.push({ kind: "number", text: text.slice(start, i) });
      continue;
    }
    if (c === ".") {
      i++;
      while (isDigit(text[i])) i++;
      fields.push({ kind: "number", text: text.slice(start, i) });
      continue;
    }
    if (isAlpha(c)) {
      while (isAlpha(text[i])) i++;
      const word = text.slice(start, i).toLowerCase();
      const next = text[i];
      const isDate =
        next === "-" || next === "/" || next === "." || ((next === "+" || isDigit(next)) && !DATE_WORDS.has(word));
      if (isDate) {
        while (i < text.length && /[A-Za-z0-9+\-/.]/.test(text[i]!)) i++;
        fields.push({ kind: "date", text: text.slice(start, i).toLowerCase() });
      } else fields.push({ kind: "string", text: word });
      continue;
    }
    if (c === "+" || c === "-") {
      i++;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (isDigit(text[i])) {
        const body = i;
        while (isDigit(text[i]) || text[i] === ":" || text[i] === "." || text[i] === "-") i++;
        fields.push({ kind: "tz", text: c + text.slice(body, i) });
      } else if (isAlpha(text[i])) {
        const body = i;
        while (isAlpha(text[i])) i++;
        fields.push({ kind: "string", text: c + text.slice(body, i).toLowerCase() });
      } else return null;
      continue;
    }
    if (/[!-/:-@[-`{-~]/.test(c)) {
      i++;
      continue;
    }
    return null;
  }
  return fields;
}

const MASK: Record<DeltaUnit | "ym" | "time", number> = {
  us: 1,
  ms: 2,
  s: 4,
  min: 8,
  h: 16,
  d: 32,
  w: 64,
  mon: 128,
  y: 256,
  dec: 512,
  c: 1024,
  mil: 2048,
  ym: 128 | 256,
  time: 1 | 2 | 4 | 8 | 16,
};

const INT32_MAX = 2_147_483_647;

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
  const fields = intervalFields(t);
  if (!fields || fields.length === 0) bad("interval", text);
  const overflow = (): never => {
    throw pgError("invalid_datetime", `interval field value out of range: "${text}"`, "22015");
  };
  let months = 0;
  let days = 0;
  let micros = 0n;
  let fmask = 0;
  // null: no unit yet (a bare number is seconds); "none": right after "ago", where a bare number is rejected
  let type: DeltaUnit | "none" | null = null;
  let parsingUnit = false;
  let ago = false;
  const addMicros = (val: number, frac: number, scale: number): void => {
    micros += BigInt(val) * BigInt(scale) + BigInt(Math.round(frac * scale));
  };
  const addFractDays = (frac: number, scale: number): void => {
    if (frac === 0) return;
    const f = frac * scale;
    const extra = Math.trunc(f);
    days += extra;
    micros += BigInt(Math.round((f - extra) * 86_400_000_000));
  };
  const addYears = (val: number, frac: number, scale: number): void => {
    months += val * scale * 12 + Math.round(frac * scale * 12);
  };
  // DecodeInterval reads the fields right to left so a unit word applies to the number before it
  for (let i = fields.length - 1; i >= 0; i--) {
    const field = fields[i]!;
    let tmask = 0;
    let numberText: string | null = null;
    if (field.kind === "time" || (field.kind === "tz" && field.text.includes(":"))) {
      const negative = field.text.startsWith("-");
      const body = field.kind === "tz" ? field.text.slice(1) : field.text;
      const tm = /^(\d+):(\d+)(?::(\d+))?(\.\d*)?$/.exec(body);
      if (!tm) bad("interval", text);
      let hh = Number(tm[1]);
      let mi = Number(tm[2]);
      let ss = Number(tm[3] ?? 0);
      // mm:ss.fff is MINUTE TO SECOND
      if (tm[3] === undefined && tm[4] !== undefined) {
        ss = mi;
        mi = hh;
        hh = 0;
      }
      const fracUs = tm[4] ? Math.round(Number(`0${tm[4]}`) * 1_000_000) : 0;
      if (mi > 59 || ss > 60 || fracUs > 1_000_000) overflow();
      const total =
        BigInt(hh) * USECS_PER_HOUR + BigInt(mi) * USECS_PER_MIN + BigInt(ss) * USECS_PER_SEC + BigInt(fracUs);
      micros += negative ? -total : total;
      tmask = MASK.time;
      type = "d";
    } else if (field.kind === "number" || field.kind === "date" || field.kind === "tz") {
      numberText = field.text;
    } else {
      if (parsingUnit) bad("interval", text);
      const unit = DELTA_UNITS[field.text.slice(0, 10)];
      if (unit === "ignore") continue;
      if (unit === undefined) {
        if (field.text === "infinity" || field.text === "-infinity" || field.text === "+infinity") {
          throw unsupported("interval infinity");
        }
        bad("interval", text);
      }
      if (unit === "ago") {
        if (i !== fields.length - 1) bad("interval", text);
        ago = true;
        type = "none";
      } else {
        type = unit;
        parsingUnit = true;
      }
    }
    if (numberText !== null) {
      if (type === "none") bad("interval", text);
      const unit: DeltaUnit = type ?? "s";
      const nm = /^([+-]?)(\d*)(?:(-)(\d+)|(\.\d*))?$/.exec(numberText);
      if (!nm || (nm[2] === "" && nm[5] === undefined)) bad("interval", text);
      const negative = nm[1] === "-";
      let val = Number(nm[2] || "0");
      let frac = nm[5] !== undefined && nm[5] !== "." ? Number(`0${nm[5]}`) : 0;
      if (!Number.isSafeInteger(val) || val > INT32_MAX * 1000) overflow();
      let effective: DeltaUnit = unit;
      if (nm[3] !== undefined) {
        // SQL "years-months"
        const m2 = Number(nm[4]);
        val = val * 12 + m2;
        frac = 0;
        effective = "mon";
        tmask = MASK.ym;
      }
      if (negative) {
        val = -val;
        frac = -frac;
      }
      switch (effective) {
        case "us":
          addMicros(val, frac, 1);
          break;
        case "ms":
          addMicros(val, frac, 1000);
          break;
        case "s":
          addMicros(val, frac, 1_000_000);
          break;
        case "min":
          addMicros(val, frac, 60_000_000);
          break;
        case "h":
          addMicros(val, frac, 3_600_000_000);
          break;
        case "d":
          days += val;
          micros += BigInt(Math.round(frac * 86_400_000_000));
          break;
        case "w":
          days += val * 7;
          addFractDays(frac, 7);
          break;
        case "mon":
          months += val;
          addFractDays(frac, 30);
          break;
        case "y":
          addYears(val, frac, 1);
          break;
        case "dec":
          addYears(val, frac, 10);
          break;
        case "c":
          addYears(val, frac, 100);
          break;
        case "mil":
          addYears(val, frac, 1000);
          break;
      }
      if (tmask === 0) tmask = effective === "s" && frac !== 0 ? MASK.s | MASK.ms | MASK.us : MASK[effective];
      type = null;
      parsingUnit = false;
    }
    if (tmask & fmask) bad("interval", text);
    fmask |= tmask;
  }
  if (fmask === 0 || parsingUnit) bad("interval", text);
  if (Math.abs(months) > INT32_MAX || Math.abs(days) > INT32_MAX) overflow();
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
