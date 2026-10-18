import type { ServeTarget } from "./cli.js"

/** Run a target's settings schema over a settings object, or refuse a target that has none. */
export const checkSettings = (
  target: Pick<ServeTarget, "name" | "parseSettings">,
  settings: Record<string, unknown>,
  label: string,
): Record<string, unknown> => {
  if (!target.parseSettings) throw new Error(`${label}: ${target.name} takes no boot settings`)
  try {
    return target.parseSettings(settings)
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}
