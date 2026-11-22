import { Chip } from "@heroui/react"

const COLOR = {
  GET: "success",
  POST: "accent",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "danger",
} as const

/** An HTTP method, colored by what it does: reads green, writes blue, updates amber, deletes red. */
export function MethodChip({ method }: { method: string }) {
  const m = method.toUpperCase()
  return (
    <Chip
      size="sm"
      variant="soft"
      color={COLOR[m as keyof typeof COLOR] ?? "default"}
      className="min-w-14 shrink-0 justify-center font-mono text-[11px]"
    >
      <Chip.Label>{m}</Chip.Label>
    </Chip>
  )
}
