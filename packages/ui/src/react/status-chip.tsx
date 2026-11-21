import { Chip } from "@heroui/react"
import type { ReactNode } from "react"

/** What a status means, independent of the words on it. */
export type Status = "ok" | "warning" | "error" | "info" | "neutral"

const COLOR = {
  ok: "success",
  warning: "warning",
  error: "danger",
  info: "accent",
  neutral: "default",
} as const satisfies Record<Status, "success" | "warning" | "danger" | "accent" | "default">

export type StatusChipProps = {
  status: Status
  children: ReactNode
  size?: "sm" | "md" | "lg"
  /** A leading dot, for live states ("Running", "Connected"). */
  dot?: boolean
}

/**
 * A short status label ("Succeeded", "Pending", "Failed", "Test mode"). The one mapping from
 * meaning to color, so a warning is the same amber on every surface.
 */
export function StatusChip({ status, children, size = "sm", dot = false }: StatusChipProps) {
  return (
    <Chip color={COLOR[status]} variant="soft" size={size} data-status={status}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      <Chip.Label>{children}</Chip.Label>
    </Chip>
  )
}
