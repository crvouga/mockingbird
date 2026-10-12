/**
 * The test run the landing page's before-and-after figure plays. The page renders the finished
 * run from these; the browser replays it with the same functions, so the two cannot disagree.
 */

/** One try at a test: the time it is shown to take, how long the figure spends on it, how it ends. */
export type Attempt = {
  /** Milliseconds the test reports. */
  shown: number
  /** Milliseconds of animation. A thirty-second timeout is not thirty seconds of figure. */
  play: number
  end: "passed" | "failed"
  /** Why it failed, as a runner would print it: `429`, `timeout`. */
  note?: string
}

export type Outcome = "passed" | "flaky" | "failed"

/** A test that needed a second try and then passed is flaky, not passed. */
export const outcomeOf = (attempts: readonly Attempt[]): Outcome =>
  attempts.at(-1)?.end === "failed" ? "failed" : attempts.length > 1 ? "flaky" : "passed"

/** What a finished row says beside its time. */
export const noteOf = (attempts: readonly Attempt[]): string => {
  const outcome = outcomeOf(attempts)
  return outcome === "flaky" ? "retried" : outcome === "failed" ? (attempts.at(-1)?.note ?? "") : ""
}

export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`

/** `4 passed · 1 flaky · 1 failed`, leaving out what did not happen. */
export const summarize = (counts: Readonly<Record<Outcome, number>>): string =>
  (["passed", "flaky", "failed"] as const)
    .filter((outcome) => counts[outcome] > 0)
    .map((outcome) => `${counts[outcome]} ${outcome}`)
    .join(" · ")
