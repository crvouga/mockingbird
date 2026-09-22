/**
 * Wall-clock formatting in an IANA zone, over `Intl` so it runs anywhere the mock does. AHA
 * reports every event time as separate local date / time / zone fields, and our handler
 * rebuilds the instant with `moment.tz(localString, zone)`.
 */

/** Whether `zone` is an IANA time zone this runtime knows. */
export const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export type ZonedParts = {
  /** `YYYY-MM-DD` */
  date: string
  /** `HH:mm` */
  time: string
  /** `HH:mm:ss` */
  timeWithSeconds: string
}

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatter = (zone: string): Intl.DateTimeFormat => {
  let found = formatters.get(zone)
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatters.set(zone, found)
  }
  return found
}

/** The local date and time of `epochMs` in `zone`. */
export const zonedParts = (epochMs: number, zone: string): ZonedParts => {
  const parts: Record<string, string> = {}
  for (const part of formatter(zone).formatToParts(new Date(epochMs))) parts[part.type] = part.value
  const hour = parts.hour === "24" ? "00" : parts.hour
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    timeWithSeconds: `${hour}:${parts.minute}:${parts.second}`,
  }
}

/** The instant a local `YYYY-MM-DD` + `HH:mm[:ss]` names in `zone` (the earlier one in a DST fold). */
export const zonedToEpoch = (date: string, time: string, zone: string): number | undefined => {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time)
  if (!d || !t) return undefined
  const asUtc = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
    Number(t[3] ?? 0),
  )
  // Two passes of "how far is local wall time from UTC here" settle every offset change.
  let guess = asUtc
  for (let i = 0; i < 2; i++) {
    const local = zonedParts(guess, zone)
    const localAsUtc = Date.parse(`${local.date}T${local.timeWithSeconds}Z`)
    guess += asUtc - localAsUtc
  }
  return guess
}
