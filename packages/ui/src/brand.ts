/**
 * Mockingbird's identity as every UI shows it. The docs site's `IDENTITY`
 * (sites/docs/src/lib/content.ts) is the source of the copy; this package cannot import a private
 * site, so the few values a UI draws are repeated here and kept equal by brand.test.ts.
 */
export const MOCKINGBIRD = {
  name: "Mockingbird",
  /** The project mark: the black bird emoji, drawn natively (no image to load). */
  icon: "🐦‍⬛",
  tagline: "Local emulators. Real API contracts.",
  docs: "https://mockingbird.chrisvouga.dev",
  repo: "https://github.com/crvouga/mockingbird",
} as const

/** The emoji fonts the mark is drawn with, so it is the same bird on every platform that has one. */
export const MARK_FONT_FAMILY =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
