/**
 * The framework-free half of the Backends section's start-up timings (#903): how a duration
 * reads, and the timeline's steps in order with the time each one took.
 */
import type { SystemTimelineStep } from "./system-types.js"

/** A duration as people read it: "412 ms", "1.2 s", "2 min 5 s". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) {
    const seconds = ms / 1000
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
  }
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`
}

/** A timeline step as drawn: when, how long since the step before, and where on the bar. */
export type TimelineRow = SystemTimelineStep & {
  /** Milliseconds since the step before (or since the start, for the first). */
  sinceMs: number
  /** Where this step's bar starts (the step before) and how wide it is, as fractions of the total. */
  bar: { from: number; width: number }
}

/**
 * The steps in time order (a tie keeps the host's order), without ones whose time is not a
 * finite, non-negative number.
 */
export function timelineRows(steps: readonly SystemTimelineStep[]): TimelineRow[] {
  const valid = steps
    .filter((step) => Number.isFinite(step.atMs) && step.atMs >= 0)
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.atMs - b.step.atMs || a.index - b.index)
    .map(({ step }) => step)
  const total = valid.at(-1)?.atMs ?? 0
  let previous = 0
  return valid.map((step) => {
    const sinceMs = step.atMs - previous
    const row = {
      label: step.label,
      atMs: step.atMs,
      sinceMs,
      bar: total > 0 ? { from: previous / total, width: sinceMs / total } : { from: 0, width: 0 },
    }
    previous = step.atMs
    return row
  })
}
