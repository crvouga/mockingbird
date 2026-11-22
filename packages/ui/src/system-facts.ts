/**
 * The framework-free half of the System screen's facts sections (#903): telling them apart from
 * mount-based sections, and the filter over their grouped rows.
 */
import type { SystemFactGroup, SystemFactsSection, SystemSection } from "./system-types.js"

/** A section the screen draws from data (`load`), not one that draws itself (`mount`). */
export const isFactsSection = (
  section: SystemSection | SystemFactsSection,
): section is SystemFactsSection =>
  typeof (section as Partial<SystemFactsSection>).load === "function" &&
  typeof (section as Partial<SystemSection>).mount !== "function"

/** Every row in every group. */
export const countFacts = (groups: readonly SystemFactGroup[]) =>
  groups.reduce((total, group) => total + group.rows.length, 0)

/**
 * The groups and rows matching `query`: every word of it, ignoring case, somewhere in the row's
 * label, value or note, or in its group's name (which keeps the whole group). Groups left with
 * no row are dropped; an empty query keeps everything.
 */
export function filterFacts(
  groups: readonly SystemFactGroup[],
  query: string,
): readonly SystemFactGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return groups
  const matches = (text: string) => {
    const haystack = text.toLowerCase()
    return words.every((word) => haystack.includes(word))
  }
  return groups.flatMap((group) => {
    const rows = group.rows.filter((row) =>
      matches([group.group, row.label, row.value, row.note ?? ""].join("\n")),
    )
    return rows.length ? [{ group: group.group, rows }] : []
  })
}
