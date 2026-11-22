/**
 * HeroUI Chip classes for markup built outside React (the notifications demo's call line, which
 * `client/notificationsDemo/mount.ts` rewrites on every request). The same look as `<Chip>`.
 */
import { chipVariants } from "@heroui/styles"

type ChipColor = "default" | "accent" | "success" | "warning" | "danger"

export const chipClass = (color: ChipColor): string =>
  chipVariants({ color, variant: "soft", size: "sm" }).base()

/** An HTTP method's color, as every Mockingbird surface draws one. */
export const methodColor = (method: string): ChipColor =>
  (({ GET: "success", POST: "accent", PUT: "warning", PATCH: "warning", DELETE: "danger" })[
    method.toUpperCase()
  ] as ChipColor | undefined) ?? "default"

/** A method chip: monospace, so a column of them lines up. */
export const methodChipClass = (method: string): string =>
  `${chipClass(methodColor(method))} shrink-0 font-mono`
