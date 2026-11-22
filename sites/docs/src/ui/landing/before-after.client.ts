/**
 * Replays the landing page's before-and-after figure (`before-after.tsx`) while it is on screen:
 * both runs from the top, side by side, from the same data the page rendered them finished with.
 */
import {
  type Attempt,
  formatDuration,
  noteOf,
  type Outcome,
  outcomeOf,
  summarize,
} from "../../lib/test-run.ts"

/** How long both finished runs stay on screen before they start over. */
const HOLD_MS = 3500
/** How long a failed try shows its reason before the retry starts. */
const FAILED_MS = 500

const still = matchMedia("(prefers-reduced-motion: reduce)")
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Call `paint` with 0 → 1 over `ms`, on animation frames. */
const tween = (ms: number, paint: (progress: number) => void) =>
  new Promise<void>((resolve) => {
    const started = performance.now()
    const frame = (now: number) => {
      const progress = Math.min(1, (now - started) / ms)
      paint(progress)
      if (progress < 1) requestAnimationFrame(frame)
      else resolve()
    }
    requestAnimationFrame(frame)
  })

const suite = (card: HTMLElement) => {
  const rows = [...card.querySelectorAll<HTMLElement>("[data-test]")].map((el) => ({
    el,
    attempts: JSON.parse(el.dataset.attempts ?? "[]") as Attempt[],
    note: el.querySelector("[data-note]") as HTMLElement,
    time: el.querySelector("[data-time]") as HTMLElement,
  }))
  const result = card.querySelector("[data-result]") as HTMLElement
  const summary = card.querySelector("[data-summary]") as HTMLElement
  const total = card.querySelector("[data-total]") as HTMLElement
  const fill = card.querySelector("[data-fill]") as HTMLElement

  /** Play the run from the top. `current` turns false when a newer run has replaced this one. */
  return async (current: () => boolean) => {
    const counts: Record<Outcome, number> = { passed: 0, flaky: 0, failed: 0 }
    let elapsed = 0
    for (const row of rows) {
      row.el.dataset.state = "queued"
      row.note.textContent = ""
      row.time.textContent = ""
    }
    result.dataset.state = "running"
    summary.textContent = `0 of ${rows.length}`
    total.textContent = formatDuration(0)
    // Empty at once: only progress eases, not the rewind.
    fill.style.transition = "none"
    fill.style.setProperty("--done", "0")
    void fill.offsetWidth
    fill.style.transition = ""

    for (const [index, row] of rows.entries()) {
      let spent = 0
      for (const [tries, attempt] of row.attempts.entries()) {
        row.el.dataset.state = tries === 0 ? "running" : "retrying"
        row.note.textContent = tries === 0 ? "" : `retry ${tries}`
        await tween(attempt.play, (progress) => {
          row.time.textContent = formatDuration(spent + attempt.shown * progress)
          total.textContent = formatDuration(elapsed + attempt.shown * progress)
        })
        if (!current()) return
        spent += attempt.shown
        elapsed += attempt.shown
        if (attempt.end === "failed" && tries < row.attempts.length - 1) {
          row.el.dataset.state = "failed"
          row.note.textContent = attempt.note ?? ""
          await wait(FAILED_MS)
          if (!current()) return
        }
      }
      const outcome = outcomeOf(row.attempts)
      counts[outcome]++
      row.el.dataset.state = outcome
      row.note.textContent = noteOf(row.attempts)
      summary.textContent = `${index + 1} of ${rows.length}`
      fill.style.setProperty("--done", String((index + 1) / rows.length))
      if (counts.failed > 0) result.dataset.state = "failing"
    }
    result.dataset.state = counts.failed > 0 ? "failed" : "passed"
    summary.textContent = summarize(counts)
  }
}

for (const figure of document.querySelectorAll<HTMLElement>("[data-before-after]")) {
  const runs = [...figure.querySelectorAll<HTMLElement>("[data-run]")].map(suite)
  let visible = false
  let looping = false
  let generation = 0
  // Both runs start together and start over together, so the gap between them is the point.
  const loop = async () => {
    if (looping) return
    looping = true
    while (visible && !still.matches) {
      const mine = ++generation
      await Promise.all(runs.map((run) => run(() => mine === generation)))
      await wait(HOLD_MS)
    }
    looping = false
  }
  new IntersectionObserver(
    ([entry]) => {
      visible = entry?.isIntersecting ?? false
      if (visible) void loop()
    },
    { threshold: 0.3 },
  ).observe(figure)
  still.addEventListener("change", () => void loop())
}
