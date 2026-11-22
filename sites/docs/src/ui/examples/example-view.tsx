import { buttonVariants } from "@heroui/react"
import { Icon } from "../icon.tsx"

/**
 * The fullscreen window a live example runs in: a native modal `<dialog>` (the top layer), driven
 * by `client/exampleModal.ts`, which mounts the example into `[data-example-host]`. The body is its
 * own containing block (`contain: layout paint`), so an example's `position: fixed` overlays stack
 * inside the window instead of over the docs page. Native rather than a HeroUI Modal because the
 * examples mount their own apps into the host, outside React.
 */
export function ExampleView({
  title,
  titleId,
  fit = "panel",
}: {
  title: string
  /** Unique on the page: each Astro-rendered React root numbers its own ids from zero. */
  titleId: string
  fit?: "app" | "panel"
}) {
  return (
    <dialog
      data-example-modal
      data-fit={fit}
      aria-labelledby={titleId}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overscroll-contain border-0 bg-background p-0 text-foreground backdrop:bg-(--backdrop) open:flex open:flex-col"
    >
      <header className="flex min-w-0 shrink-0 items-center gap-2.5 border-b border-separator bg-surface py-2 pr-2 pl-4">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />
        <strong id={titleId} className="mr-auto truncate text-sm font-semibold sm:mr-0">
          {title}
        </strong>
        <span className="ml-auto hidden text-xs whitespace-nowrap text-muted sm:inline">
          Running in this tab · no server required
        </span>
        <button
          type="button"
          data-example-close
          aria-label="Close example"
          className={buttonVariants({ variant: "ghost", size: "sm", isIconOnly: true })}
        >
          <Icon name="x" />
        </button>
      </header>
      <div className="relative isolate flex min-h-0 flex-1 flex-col [contain:layout_paint]">
        <div data-example-state className="flex flex-col items-start gap-3 p-6 text-sm text-muted">
          <p data-example-status role="status" aria-live="polite" />
          <button
            type="button"
            data-example-retry
            hidden
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            Try again
          </button>
        </div>
        <div
          data-example-host
          className={`min-h-0 flex-1 overflow-auto overscroll-contain ${fit === "panel" ? "sm:p-4" : ""}`}
        />
      </div>
    </dialog>
  )
}

/** The card that opens an example: what happens, and the button. */
export function ExampleLaunch({ label = "Launch example" }: { label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface-secondary p-5">
      <button
        type="button"
        data-example-open
        aria-haspopup="dialog"
        className={buttonVariants({ variant: "primary" })}
      >
        <Icon name="play" />
        {label}
      </button>
      <p className="text-sm text-muted">Opens fullscreen. The example runs in this tab.</p>
    </div>
  )
}
