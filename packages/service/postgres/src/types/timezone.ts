import { pgError } from "../errors/error.ts";
import { UNIX_EPOCH_MICROS_FROM_PG } from "./datetime.ts";

/**
 * Time zone offset resolution. The engine pins the session default to UTC.
 * Fixed offsets and IANA names (via Intl) are supported; POSIX-style
 * `UTC+N` / `Etc/GMT+N` have inverted signs per POSIX.
 */

const intlCache = new Map<string, Intl.DateTimeFormat>();

function intlFor(zone: string): Intl.DateTimeFormat | null {
  const cached = intlCache.get(zone);
  if (cached) return cached;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
      year: "numeric",
    });
    intlCache.set(zone, fmt);
    return fmt;
  } catch {
    return null;
  }
}

/** parse fixed offsets: "+05", "-08:30", "05:30:10" (east positive) */
function parseFixedOffset(zone: string): number | null {
  const m = /^([+-]?)(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(zone.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0));
}

/** POSIX style: UTC+5 / GMT-3 → sign inverted (west positive in POSIX) */
function parsePosixOffset(zone: string): number | null {
  const m = /^(?:utc|gmt)([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(zone.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? 1 : -1;
  return sign * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60);
}

function pgMicrosToUnixMs(utcMicros: bigint): number {
  return Number((utcMicros - UNIX_EPOCH_MICROS_FROM_PG) / 1000n);
}

/** Offset (seconds east of UTC) of `zone` at the given UTC instant. */
export function zoneOffsetAtUtc(zone: string, utcMicros: bigint): number {
  const z = zone.trim();
  const lower = z.toLowerCase();
  if (lower === "utc" || lower === "gmt" || lower === "z" || lower === "zulu" || lower === "universal") return 0;
  const posix = parsePosixOffset(z);
  if (posix !== null) return posix;
  const fixed = parseFixedOffset(z);
  if (fixed !== null) return fixed;
  const fmt = intlFor(z);
  if (fmt) {
    const ms = clampDateMs(pgMicrosToUnixMs(utcMicros));
    const parts = fmt.formatToParts(new Date(ms));
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = /GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?/.exec(tzName);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0));
  }
  throw pgError("invalid_parameter_value", `time zone "${zone}" not recognized`);
}

function clampDateMs(ms: number): number {
  const MAX = 8.64e15;
  return Math.max(-MAX, Math.min(MAX, ms));
}

/**
 * Offset for interpreting a naive local timestamp in `zone`
 * (two-pass refinement over {@link zoneOffsetAtUtc}).
 */
export function zoneOffsetForNaive(zone: string, naiveMicros: bigint): number {
  const first = zoneOffsetAtUtc(zone, naiveMicros);
  const second = zoneOffsetAtUtc(zone, naiveMicros - BigInt(first) * 1_000_000n);
  return second;
}

/** Validate a zone string (throws when unrecognized). */
export function validateZone(zone: string): void {
  zoneOffsetAtUtc(zone, 0n);
}
