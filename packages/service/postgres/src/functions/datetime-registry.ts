import { pgError } from "../errors/error.ts";
import type { EngineCtx } from "../expressions/context.ts";
import { castTo } from "../types/cast.ts";
import {
  civilToDays,
  dayOfWeek,
  daysToCivil,
  formatInterval,
  type Interval,
  intervalTotalMicros,
  makeInterval,
  splitTs,
  TS_NEG_INF,
  TS_POS_INF,
  USECS_PER_DAY,
  USECS_PER_HOUR,
  USECS_PER_MIN,
  USECS_PER_SEC,
} from "../types/datetime.ts";
import { isNumeric, numericToNumber } from "../types/numeric.ts";
import { zoneOffsetAtUtc, zoneOffsetForNaive } from "../types/timezone.ts";
import { datumFromText, type TypedValue, tv } from "../types/value.ts";
import {
  dateTruncDays,
  dateTruncInterval,
  dateTruncMicros,
  extractDatePart,
  isoWeek,
  justifyDays,
  justifyHours,
  justifyInterval,
  makeDateDatum,
  makeTimeDatum,
  numericSecondsToMicros,
  timestampAge,
} from "./datetime-fns.ts";
import { argFloat, argInt, argNumeric, argText, type ScalarFn, strict } from "./util.ts";

export function getDatetimeFunctions(): Map<string, ScalarFn> {
  const m = new Map<string, ScalarFn>();

  m.set("now", (ctx) => tv("timestamptz", ctx.txNow));
  m.set("transaction_timestamp", (ctx) => tv("timestamptz", ctx.txNow));
  m.set("statement_timestamp", (ctx) => tv("timestamptz", ctx.stmtNow));
  m.set("clock_timestamp", (ctx) => tv("timestamptz", ctx.stmtNow));
  m.set("current_timestamp", (ctx) => tv("timestamptz", ctx.txNow));
  m.set("current_date", (ctx) => {
    const offset = ctx.zoneOffsetAt(ctx.txNow);
    const local = ctx.txNow + BigInt(offset) * USECS_PER_SEC;
    return tv("date", splitTs(local).days);
  });
  m.set("current_time", (ctx) => {
    const offset = ctx.zoneOffsetAt(ctx.txNow);
    const local = ctx.txNow + BigInt(offset) * USECS_PER_SEC;
    return tv("timetz", { micros: splitTs(local).tod, offsetSec: offset } as never);
  });
  m.set("localtimestamp", (ctx) => {
    const offset = ctx.zoneOffsetAt(ctx.txNow);
    return tv("timestamp", ctx.txNow + BigInt(offset) * USECS_PER_SEC);
  });
  m.set("localtime", (ctx) => {
    const offset = ctx.zoneOffsetAt(ctx.txNow);
    const local = ctx.txNow + BigInt(offset) * USECS_PER_SEC;
    return tv("time", splitTs(local).tod);
  });

  m.set(
    "date_trunc",
    strict("timestamp", (ctx, args) => {
      const field = argText(ctx, args[0]!).toLowerCase();
      const src = args[1]!;
      if (src.t === "interval") return tv("interval", dateTruncInterval(field, src.v as Interval));
      if (src.t === "date") {
        const days = src.v as number;
        return tv("timestamp", BigInt(dateTruncDays(field, days)) * USECS_PER_DAY);
      }
      if (src.t === "timestamptz" || (src.t === "unknown" && args.length === 2)) {
        const cast = castTo(ctx, src, src.t === "unknown" ? "timestamptz" : "timestamptz", { explicit: true });
        const micros = cast.v as bigint;
        if (micros === TS_POS_INF || micros === TS_NEG_INF) return tv("timestamptz", micros);
        const zone = args.length > 2 ? argText(ctx, args[2]!) : ctx.timezone();
        const offset = zoneOffsetAtUtc(zone, micros);
        const local = micros + BigInt(offset) * USECS_PER_SEC;
        const truncLocal = dateTruncMicros(field, local);
        const offset2 = zoneOffsetForNaive(zone, truncLocal);
        return tv("timestamptz", truncLocal - BigInt(offset2) * USECS_PER_SEC);
      }
      const cast = castTo(ctx, src, "timestamp", { explicit: true });
      const micros = cast.v as bigint;
      if (micros === TS_POS_INF || micros === TS_NEG_INF) return tv("timestamp", micros);
      return tv("timestamp", dateTruncMicros(field, micros));
    }),
  );

  m.set(
    "date_part",
    strict("float8", (ctx, args) => extractDatePart(ctx, argText(ctx, args[0]!), args[1]!, false)),
  );
  m.set(
    "extract",
    strict("numeric", (ctx, args) => extractDatePart(ctx, argText(ctx, args[0]!), args[1]!, true)),
  );

  m.set(
    "age",
    strict("interval", (ctx, args) => {
      if (args.length === 1) {
        const b = castTo(ctx, args[0]!, "timestamp", { explicit: true }).v as bigint;
        // age(x) = age(current_date::timestamp, x)
        const offset = ctx.zoneOffsetAt(ctx.txNow);
        const local = ctx.txNow + BigInt(offset) * USECS_PER_SEC;
        const midnight = BigInt(splitTs(local).days) * USECS_PER_DAY;
        return tv("interval", timestampAge(midnight, b));
      }
      const a = castTo(ctx, args[0]!, "timestamp", { explicit: true }).v as bigint;
      const b = castTo(ctx, args[1]!, "timestamp", { explicit: true }).v as bigint;
      return tv("interval", timestampAge(a, b));
    }),
  );

  m.set(
    "make_date",
    strict("date", (ctx, args) => {
      const y = argInt(ctx, args[0]!);
      const mo = argInt(ctx, args[1]!);
      const d = argInt(ctx, args[2]!);
      return tv("date", makeDateDatum(y, mo, d));
    }),
  );
  m.set(
    "make_time",
    strict("time", (ctx, args) => {
      const h = argInt(ctx, args[0]!);
      const min = argInt(ctx, args[1]!);
      const sec = argFloat(ctx, args[2]!);
      return tv("time", makeTimeDatum(h, min, sec));
    }),
  );
  m.set(
    "make_timestamp",
    strict("timestamp", (ctx, args) => {
      const y = argInt(ctx, args[0]!);
      const mo = argInt(ctx, args[1]!);
      const d = argInt(ctx, args[2]!);
      const h = argInt(ctx, args[3]!);
      const min = argInt(ctx, args[4]!);
      const sec = argFloat(ctx, args[5]!);
      const days = makeDateDatum(y, mo, d);
      const tod = makeTimeDatum(h, min, sec);
      return tv("timestamp", BigInt(days) * USECS_PER_DAY + tod);
    }),
  );
  m.set(
    "make_timestamptz",
    strict("timestamptz", (ctx, args) => {
      const y = argInt(ctx, args[0]!);
      const mo = argInt(ctx, args[1]!);
      const d = argInt(ctx, args[2]!);
      const h = argInt(ctx, args[3]!);
      const min = argInt(ctx, args[4]!);
      const sec = argFloat(ctx, args[5]!);
      const days = makeDateDatum(y, mo, d);
      const tod = makeTimeDatum(h, min, sec);
      const naive = BigInt(days) * USECS_PER_DAY + tod;
      const zone = args.length > 6 ? argText(ctx, args[6]!) : ctx.timezone();
      const offset = zoneOffsetForNaive(zone, naive);
      return tv("timestamptz", naive - BigInt(offset) * USECS_PER_SEC);
    }),
  );
  m.set("make_interval", (ctx, args) => {
    // named-arg style not supported at parse level; positional: years, months, weeks, days, hours, mins, secs
    const get = (i: number): number => (args[i] === undefined || args[i]!.v === null ? 0 : argInt(ctx, args[i]!));
    if (args.some((a) => a.v === null)) return tv("interval", null);
    const years = get(0);
    const months = get(1);
    const weeks = get(2);
    const days = get(3);
    const hours = get(4);
    const mins = get(5);
    const secs = args[6] === undefined ? 0 : argFloat(ctx, args[6]!);
    return tv(
      "interval",
      makeInterval(
        years * 12 + months,
        weeks * 7 + days,
        BigInt(hours) * USECS_PER_HOUR + BigInt(mins) * USECS_PER_MIN + BigInt(Math.round(secs * 1e6)),
      ),
    );
  });

  m.set(
    "justify_hours",
    strict("interval", (_ctx, args) => tv("interval", justifyHours(args[0]!.v as Interval))),
  );
  m.set(
    "justify_days",
    strict("interval", (_ctx, args) => tv("interval", justifyDays(args[0]!.v as Interval))),
  );
  m.set(
    "justify_interval",
    strict("interval", (_ctx, args) => tv("interval", justifyInterval(args[0]!.v as Interval))),
  );

  m.set(
    "to_timestamp",
    strict("timestamptz", (ctx, args) => {
      if (args.length === 1) {
        const a = args[0]!;
        if (
          a.t === "numeric" ||
          a.t === "float8" ||
          a.t === "float4" ||
          a.t === "int4" ||
          a.t === "int8" ||
          a.t === "int2" ||
          a.t === "unknown"
        ) {
          const n = argNumeric(ctx, a);
          if (n.special === "nan") throw pgError("invalid_datetime", "timestamp cannot be NaN", "22008");
          if (n.special === "inf") return tv("timestamptz", TS_POS_INF);
          if (n.special === "-inf") return tv("timestamptz", TS_NEG_INF);
          const micros = numericSecondsToMicros(n) - 946_684_800_000_000n;
          return tv("timestamptz", micros);
        }
      }
      const input = argText(ctx, args[0]!);
      const fmt = argText(ctx, args[1]!);
      const f = parseByFormat(input, fmt);
      const frac = f.us > 0 ? `.${String(f.us).padStart(6, "0")}` : "";
      const iso = `${String(f.y).padStart(4, "0")}-${String(f.mo).padStart(2, "0")}-${String(f.d).padStart(2, "0")} ${String(f.h).padStart(2, "0")}:${String(f.mi).padStart(2, "0")}:${String(f.s).padStart(2, "0")}${frac}`;
      return tv("timestamptz", datumFromText("timestamptz", iso, ctx) as bigint);
    }),
  );

  m.set(
    "timezone",
    strict("timestamp", (ctx, args) => {
      const zoneArg = args[0]!;
      const src = args[1]!;
      if (zoneArg.t === "interval") {
        const iv = zoneArg.v as Interval;
        const offsetSec = Number(intervalTotalMicros(iv) / USECS_PER_SEC);
        return timezoneConvertFixed(ctx, offsetSec, src);
      }
      const zone = argText(ctx, zoneArg);
      return timezoneConvert(ctx, zone, src);
    }),
  );

  m.set(
    "date_bin",
    strict("timestamp", (ctx, args) => {
      const stride = args[0]!.v as Interval;
      const src = castTo(ctx, args[1]!, args[1]!.t === "timestamptz" ? "timestamptz" : "timestamp", { explicit: true });
      const origin = castTo(ctx, args[2]!, src.t, { explicit: true });
      if (stride.months !== 0) {
        throw pgError(
          "feature_not_supported",
          "timestamps cannot be binned into intervals containing months or years",
          "0A000",
        );
      }
      const strideMicros = BigInt(stride.days) * USECS_PER_DAY + stride.micros;
      if (strideMicros <= 0n) {
        throw pgError("invalid_parameter_value", "stride must be greater than zero", "22023");
      }
      const s = src.v as bigint;
      const o = origin.v as bigint;
      const delta = s - o;
      let bins = delta / strideMicros;
      if (delta < 0n && delta % strideMicros !== 0n) bins -= 1n;
      return tv(src.t, o + bins * strideMicros);
    }),
  );

  m.set(
    "to_char",
    strict("text", (ctx, args) => {
      const src = args[0]!;
      const fmt = argText(ctx, args[1]!);
      if (src.t === "interval") return tv("text", toCharInterval(src.v as Interval, fmt));
      if (src.t === "date") {
        const days = src.v as number;
        return tv("text", toCharTimestamp(ctx, BigInt(days) * USECS_PER_DAY, fmt, null));
      }
      if (src.t === "timestamptz") {
        const micros = src.v as bigint;
        const offset = ctx.zoneOffsetAt(micros);
        return tv("text", toCharTimestamp(ctx, micros + BigInt(offset) * USECS_PER_SEC, fmt, offset));
      }
      if (src.t === "timestamp") {
        return tv("text", toCharTimestamp(ctx, src.v as bigint, fmt, null));
      }
      if (src.t === "time") {
        return tv("text", toCharTimestamp(ctx, src.v as bigint, fmt, null));
      }
      // numeric to_char
      return tv("text", toCharNumeric(ctx, src, fmt));
    }),
  );

  m.set(
    "to_date",
    strict("date", (ctx, args) => {
      const input = argText(ctx, args[0]!);
      const fmt = argText(ctx, args[1]!);
      const f = parseByFormat(input, fmt);
      return tv("date", makeDateDatum(f.y, f.mo, f.d));
    }),
  );

  m.set(
    "to_number",
    strict("numeric", (ctx, args) => {
      const input = argText(ctx, args[0]!);
      // subset: strip grouping/currency/space characters, keep digits, sign, decimal point
      const cleaned = input.replace(/[,\s$]/g, "");
      const m2 = /^[+-]?\d*(?:\.\d*)?/.exec(cleaned);
      if (!m2 || m2[0] === "" || m2[0] === "+" || m2[0] === "-") {
        throw pgError("invalid_text_representation", `invalid input syntax for type numeric: "${input}"`, "22P02");
      }
      return castTo(ctx, tv("unknown", m2[0]), "numeric", { explicit: true });
    }),
  );

  return m;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Minimal to_date/to_timestamp format parser: YYYY MM DD Mon Month HH24 HH12 MI SS MS US AM/PM. */
function parseByFormat(
  input: string,
  fmt: string,
): { y: number; mo: number; d: number; h: number; mi: number; s: number; us: number } {
  const res = { y: 1, mo: 1, d: 1, h: 0, mi: 0, s: 0, us: 0 };
  let pm: boolean | null = null;
  let i = 0;
  let j = 0;
  const skipInputSeparators = (): void => {
    while (i < input.length && /[^0-9A-Za-z]/.test(input[i]!)) i++;
  };
  const readNum = (maxLen: number): number => {
    skipInputSeparators();
    const start = i;
    while (i < input.length && /[0-9]/.test(input[i]!) && i - start < maxLen) i++;
    if (i === start) {
      throw pgError("invalid_datetime", `invalid value for field in source string "${input}"`, "22007");
    }
    return Number(input.slice(start, i));
  };
  const readMonthName = (): number => {
    skipInputSeparators();
    const rest = input.slice(i).toLowerCase();
    for (let k = 0; k < MONTH_NAMES.length; k++) {
      const full = MONTH_NAMES[k]!;
      if (rest.startsWith(full)) {
        i += full.length;
        return k + 1;
      }
      if (rest.startsWith(full.slice(0, 3))) {
        i += 3;
        return k + 1;
      }
    }
    throw pgError("invalid_datetime", `invalid value for month in source string "${input}"`, "22007");
  };
  const upperFmt = fmt.toUpperCase();
  while (j < fmt.length) {
    const rest = upperFmt.slice(j);
    if (rest.startsWith("FM") || rest.startsWith("FX")) {
      j += 2;
    } else if (rest.startsWith("YYYY")) {
      res.y = readNum(4);
      j += 4;
    } else if (rest.startsWith("YY")) {
      const v = readNum(2);
      res.y = v < 70 ? 2000 + v : 1900 + v;
      j += 2;
    } else if (rest.startsWith("MONTH")) {
      res.mo = readMonthName();
      j += 5;
    } else if (rest.startsWith("MON")) {
      res.mo = readMonthName();
      j += 3;
    } else if (rest.startsWith("MM")) {
      res.mo = readNum(2);
      j += 2;
    } else if (rest.startsWith("DD")) {
      res.d = readNum(2);
      j += 2;
    } else if (rest.startsWith("HH24")) {
      res.h = readNum(2);
      j += 4;
    } else if (rest.startsWith("HH12") || rest.startsWith("HH")) {
      res.h = readNum(2);
      j += rest.startsWith("HH12") ? 4 : 2;
    } else if (rest.startsWith("MI")) {
      res.mi = readNum(2);
      j += 2;
    } else if (rest.startsWith("SS")) {
      res.s = readNum(2);
      j += 2;
    } else if (rest.startsWith("MS")) {
      res.us = readNum(3) * 1000;
      j += 2;
    } else if (rest.startsWith("US")) {
      res.us = readNum(6);
      j += 2;
    } else if (rest.startsWith("A.M.") || rest.startsWith("P.M.")) {
      skipInputSeparators();
      pm = input
        .slice(i, i + 4)
        .toLowerCase()
        .startsWith("p");
      i += 4;
      j += 4;
    } else if (rest.startsWith("AM") || rest.startsWith("PM")) {
      skipInputSeparators();
      pm = input
        .slice(i, i + 2)
        .toLowerCase()
        .startsWith("p");
      i += 2;
      j += 2;
    } else {
      j++;
    }
  }
  if (pm !== null) {
    if (pm && res.h < 12) res.h += 12;
    if (!pm && res.h === 12) res.h = 0;
  }
  return res;
}

/** timezone(zone, ts): tz→local timestamp; timestamp→timestamptz interpreting in zone. */
function timezoneConvert(ctx: EngineCtx, zone: string, src: TypedValue): TypedValue {
  if (src.t === "timestamptz" || src.t === "unknown") {
    const cast = castTo(ctx, src, "timestamptz", { explicit: true });
    const micros = cast.v as bigint;
    if (micros === TS_POS_INF || micros === TS_NEG_INF) return tv("timestamp", micros);
    const offset = zoneOffsetAtUtc(zone, micros);
    return tv("timestamp", micros + BigInt(offset) * USECS_PER_SEC);
  }
  if (src.t === "timestamp") {
    const micros = src.v as bigint;
    if (micros === TS_POS_INF || micros === TS_NEG_INF) return tv("timestamptz", micros);
    const offset = zoneOffsetForNaive(zone, micros);
    return tv("timestamptz", micros - BigInt(offset) * USECS_PER_SEC);
  }
  if (src.t === "time") {
    // time -> timetz using zone's current offset
    const offset = zoneOffsetAtUtc(zone, 0n);
    return tv("timetz", { micros: src.v as bigint, offsetSec: offset } as never);
  }
  throw pgError("datatype_mismatch", `function timezone(text, ${src.t}) does not exist`, "42883");
}

function timezoneConvertFixed(ctx: EngineCtx, offsetSec: number, src: TypedValue): TypedValue {
  if (src.t === "timestamptz" || src.t === "unknown") {
    const cast = castTo(ctx, src, "timestamptz", { explicit: true });
    return tv("timestamp", (cast.v as bigint) + BigInt(offsetSec) * USECS_PER_SEC);
  }
  if (src.t === "timestamp") {
    return tv("timestamptz", (src.v as bigint) - BigInt(offsetSec) * USECS_PER_SEC);
  }
  throw pgError("datatype_mismatch", `function timezone(interval, ${src.t}) does not exist`, "42883");
}

// --- to_char ------------------------------------------------------------------

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function toCharTimestamp(ctx: EngineCtx, localMicros: bigint, fmt: string, tzOffsetSec: number | null): string {
  void ctx;
  const { days, tod } = splitTs(localMicros);
  const { y, m, d } = daysToCivil(days);
  const hour24 = Number(tod / USECS_PER_HOUR);
  const minute = Number((tod / USECS_PER_MIN) % 60n);
  const second = Number((tod / USECS_PER_SEC) % 60n);
  const micros = Number(tod % USECS_PER_SEC);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const dow = dayOfWeek(days);
  const doy = days - civilToDays(y, 1, 1) + 1;
  const iso = isoWeek(days);

  let out = "";
  let i = 0;
  const push = (s: string, fill: boolean): void => {
    out += s;
    void fill;
  };
  let fillMode = false;

  while (i < fmt.length) {
    const rest = fmt.slice(i);
    const tryPat = (pat: string): boolean => {
      if (rest.startsWith(pat)) {
        i += pat.length;
        return true;
      }
      return false;
    };
    if (tryPat("FM")) {
      fillMode = !fillMode;
      continue;
    }
    if (tryPat('"')) {
      // literal until closing quote
      let lit = "";
      while (i < fmt.length && fmt[i] !== '"') {
        lit += fmt[i];
        i++;
      }
      i++;
      out += lit;
      continue;
    }
    const pad = (n: number, w: number): string => (fillMode ? String(n) : String(n).padStart(w, "0"));
    if (tryPat("HH24")) push(pad(hour24, 2), fillMode);
    else if (tryPat("HH12")) push(pad(hour12, 2), fillMode);
    else if (tryPat("HH")) push(pad(hour12, 2), fillMode);
    else if (tryPat("MI")) push(pad(minute, 2), fillMode);
    else if (tryPat("SSSS") || tryPat("SSSSS")) push(String(hour24 * 3600 + minute * 60 + second), fillMode);
    else if (tryPat("SS")) push(pad(second, 2), fillMode);
    else if (tryPat("MS")) push(String(Math.trunc(micros / 1000)).padStart(3, "0"), fillMode);
    else if (tryPat("US")) push(String(micros).padStart(6, "0"), fillMode);
    else if (tryPat("AM") || tryPat("PM")) push(hour24 < 12 ? "AM" : "PM", fillMode);
    else if (tryPat("am") || tryPat("pm")) push(hour24 < 12 ? "am" : "pm", fillMode);
    else if (tryPat("A.M.") || tryPat("P.M.")) push(hour24 < 12 ? "A.M." : "P.M.", fillMode);
    else if (tryPat("YYYY")) push(fillMode ? String(y) : String(Math.abs(y)).padStart(4, "0"), fillMode);
    else if (tryPat("YYY")) push(String(Math.abs(y) % 1000).padStart(3, "0"), fillMode);
    else if (tryPat("YY")) push(String(Math.abs(y) % 100).padStart(2, "0"), fillMode);
    else if (tryPat("Y,YYY")) push(commaYear(y), fillMode);
    else if (tryPat("Y")) push(String(Math.abs(y) % 10), fillMode);
    else if (tryPat("IYYY")) push(String(iso.year).padStart(4, "0"), fillMode);
    else if (tryPat("IW")) push(pad(iso.week, 2), fillMode);
    else if (tryPat("MONTH")) push(MONTHS[m - 1]!.toUpperCase().padEnd(fillMode ? 0 : 9), fillMode);
    else if (tryPat("Month")) push(fillMode ? MONTHS[m - 1]! : MONTHS[m - 1]!.padEnd(9), fillMode);
    else if (tryPat("month")) push((fillMode ? MONTHS[m - 1]! : MONTHS[m - 1]!.padEnd(9)).toLowerCase(), fillMode);
    else if (tryPat("MON")) push(MONTHS[m - 1]!.slice(0, 3).toUpperCase(), fillMode);
    else if (tryPat("Mon")) push(MONTHS[m - 1]!.slice(0, 3), fillMode);
    else if (tryPat("mon")) push(MONTHS[m - 1]!.slice(0, 3).toLowerCase(), fillMode);
    else if (tryPat("MM")) push(pad(m, 2), fillMode);
    else if (tryPat("DAY")) push(DAYS[dow]!.toUpperCase().padEnd(fillMode ? 0 : 9), fillMode);
    else if (tryPat("Day")) push(fillMode ? DAYS[dow]! : DAYS[dow]!.padEnd(9), fillMode);
    else if (tryPat("day")) push((fillMode ? DAYS[dow]! : DAYS[dow]!.padEnd(9)).toLowerCase(), fillMode);
    else if (tryPat("DY")) push(DAYS[dow]!.slice(0, 3).toUpperCase(), fillMode);
    else if (tryPat("Dy")) push(DAYS[dow]!.slice(0, 3), fillMode);
    else if (tryPat("dy")) push(DAYS[dow]!.slice(0, 3).toLowerCase(), fillMode);
    else if (tryPat("DDD")) push(fillMode ? String(doy) : String(doy).padStart(3, "0"), fillMode);
    else if (tryPat("DD")) push(pad(d, 2), fillMode);
    else if (tryPat("D")) push(String(dow + 1), fillMode);
    else if (tryPat("WW")) push(pad(Math.floor((doy - 1) / 7) + 1, 2), fillMode);
    else if (tryPat("W")) push(String(Math.floor((d - 1) / 7) + 1), fillMode);
    else if (tryPat("Q")) push(String(Math.floor((m - 1) / 3) + 1), fillMode);
    else if (tryPat("CC")) push(String(Math.floor((y - 1) / 100) + 1).padStart(2, "0"), fillMode);
    else if (tryPat("J")) push(String(days + 2451545), fillMode);
    else if (tryPat("BC") || tryPat("AD")) push(y > 0 ? "AD" : "BC", fillMode);
    else if (tryPat("bc") || tryPat("ad")) push(y > 0 ? "ad" : "bc", fillMode);
    else if (tryPat("TZ")) push(tzOffsetSec === null ? "" : formatTzAbbrev(tzOffsetSec), fillMode);
    else if (tryPat("OF")) push(tzOffsetSec === null ? "+00" : formatTzOf(tzOffsetSec), fillMode);
    else if (tryPat("TH") || tryPat("th")) {
      // ordinal suffix for the previous number
      const prev = /(\d+)$/.exec(out);
      const n = prev ? Number.parseInt(prev[1]!, 10) : 0;
      const suffix = ordinalSuffix(n);
      out += rest.startsWith("TH") ? suffix.toUpperCase() : suffix;
    } else {
      out += fmt[i];
      i++;
    }
  }
  return out;
}

function commaYear(y: number): string {
  const a = Math.abs(y);
  const thousands = Math.floor(a / 1000);
  const rem = a % 1000;
  return `${thousands},${String(rem).padStart(3, "0")}`;
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function formatTzOf(offsetSec: number): string {
  const sign = offsetSec >= 0 ? "+" : "-";
  const abs = Math.abs(offsetSec);
  const h = Math.floor(abs / 3600);
  const min = Math.floor((abs % 3600) / 60);
  return min === 0
    ? `${sign}${String(h).padStart(2, "0")}`
    : `${sign}${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function formatTzAbbrev(offsetSec: number): string {
  if (offsetSec === 0) return "UTC";
  return formatTzOf(offsetSec);
}

function toCharInterval(v: Interval, fmt: string): string {
  // reuse timestamp renderer on the interval's time part; day/month fields from months/days
  const totalMicros = v.micros;
  const hours = Number(totalMicros / USECS_PER_HOUR);
  const minutes = Number((totalMicros / USECS_PER_MIN) % 60n);
  const seconds = Number((totalMicros / USECS_PER_SEC) % 60n);
  let out = "";
  let i = 0;
  while (i < fmt.length) {
    const rest = fmt.slice(i);
    if (rest.startsWith("HH24")) {
      out += String(hours).padStart(2, "0");
      i += 4;
    } else if (rest.startsWith("HH12") || rest.startsWith("HH")) {
      out += String(hours % 12 === 0 ? 12 : hours % 12).padStart(2, "0");
      i += rest.startsWith("HH12") ? 4 : 2;
    } else if (rest.startsWith("MI")) {
      out += String(minutes).padStart(2, "0");
      i += 2;
    } else if (rest.startsWith("SS")) {
      out += String(seconds).padStart(2, "0");
      i += 2;
    } else if (rest.startsWith("DD")) {
      out += String(v.days).padStart(2, "0");
      i += 2;
    } else if (rest.startsWith("MM")) {
      out += String(v.months % 12).padStart(2, "0");
      i += 2;
    } else if (rest.startsWith("YYYY")) {
      out += String(Math.trunc(v.months / 12)).padStart(4, "0");
      i += 4;
    } else {
      out += fmt[i];
      i++;
    }
  }
  void formatInterval;
  return out;
}

function toCharNumeric(ctx: EngineCtx, src: TypedValue, fmt: string): string {
  const n = argNumeric(ctx, src);
  const isNeg = n.coef < 0n || n.special === "-inf";
  const absText = isNumeric(n) ? numericAbsText(n) : "0";
  void numericToNumber;

  // parse format: count digit positions before/after decimal point
  const fm = fmt.includes("FM");
  const clean = fmt.replaceAll("FM", "");
  const dotIdx = clean.search(/[.D]/);
  const intFmt = dotIdx === -1 ? clean : clean.slice(0, dotIdx);
  const fracFmt = dotIdx === -1 ? "" : clean.slice(dotIdx + 1);
  const fracDigits = (fracFmt.match(/[09]/g) ?? []).length;

  const [intPartRaw, fracPartRaw = ""] = absText.split(".");
  let fracPart = fracPartRaw.slice(0, fracDigits).padEnd(fracDigits, "0");
  if (fracPartRaw.length > fracDigits && fracDigits >= 0) {
    // round
    const scaled = `${intPartRaw}${fracPartRaw}`;
    void scaled;
    const roundedNum = roundDecimalText(absText, fracDigits);
    const [ip, fp = ""] = roundedNum.split(".");
    fracPart = fp.padEnd(fracDigits, "0");
    return assembleToChar(ip!, fracPart, intFmt, fracFmt, isNeg, fm, clean);
  }
  return assembleToChar(intPartRaw!, fracPart, intFmt, fracFmt, isNeg, fm, clean);
}

function numericAbsText(n: { coef: bigint; dscale: number; special: string | null }): string {
  if (n.special === "nan") return "NaN";
  if (n.special) return "Infinity";
  const abs = n.coef < 0n ? -n.coef : n.coef;
  const s = abs.toString().padStart(n.dscale + 1, "0");
  if (n.dscale === 0) return s;
  return `${s.slice(0, -n.dscale)}.${s.slice(-n.dscale)}`;
}

function roundDecimalText(text: string, digits: number): string {
  const [ip = "0", fp = ""] = text.split(".");
  if (fp.length <= digits) return text;
  const keep = fp.slice(0, digits);
  const nextDigit = Number(fp[digits] ?? "0");
  let coef = BigInt(ip + keep);
  if (nextDigit >= 5) coef += 1n;
  const s = coef.toString().padStart(digits + 1, "0");
  if (digits === 0) return s;
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

function assembleToChar(
  intPart: string,
  fracPart: string,
  intFmt: string,
  fracFmt: string,
  isNeg: boolean,
  fm: boolean,
  fullFmt: string,
): string {
  const groups = intFmt.includes(",") || intFmt.includes("G");
  const intDigitsAvail = (intFmt.match(/[09]/g) ?? []).length;
  let intStr = intPart.replace(/^0+(?=\d)/, "");
  if (intStr.length > intDigitsAvail) {
    // overflow -> hash marks
    const width = fullFmt.replace(/[^09.,DG]/g, "").length + 1;
    return "#".repeat(Math.max(width, 1));
  }
  if (groups) {
    intStr = addThousands(intStr);
  }
  // zero-pad according to '0' positions
  const zeroPad = intFmt.indexOf("0");
  if (zeroPad !== -1 && !fm) {
    const minDigits = (intFmt.slice(zeroPad).match(/[09]/g) ?? []).length;
    const digitsOnly = intStr.replaceAll(",", "");
    if (digitsOnly.length < minDigits) {
      const padded = digitsOnly.padStart(minDigits, "0");
      intStr = groups ? addThousands(padded) : padded;
    }
  }
  if (intStr === "" && (fracFmt === "" || fracPart === "")) intStr = "0";
  if (intStr === "" && intFmt.includes("9") && !fm) intStr = "0";

  let body = intStr;
  if (fracFmt !== "") {
    let frac = fracPart;
    if (fm) frac = frac.replace(/0+$/, "");
    body = frac === "" && fm ? intStr : `${intStr}.${frac}`;
  }

  const hasMinusCap =
    fullFmt.includes("MI") || fullFmt.includes("S") || fullFmt.includes("PL") || fullFmt.includes("SG");
  let result: string;
  if (fullFmt.includes("MI")) {
    result = body + (isNeg ? "-" : fm ? "" : " ");
  } else if (fullFmt.includes("S")) {
    result = (isNeg ? "-" : "+") + body;
  } else {
    result = (isNeg ? "-" : fm ? "" : " ") + body;
  }
  void hasMinusCap;
  return result;
}

function addThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += ",";
  }
  return out;
}
