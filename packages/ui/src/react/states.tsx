import { Alert, Button, EmptyState as HeroEmptyState, Spinner } from "@heroui/react"
import type { ReactNode } from "react"

export type EmptyStateProps = {
  title: ReactNode
  description?: ReactNode
  /** A 24px icon (from @gravity-ui/icons) above the title. */
  icon?: ReactNode
  /** What to do about it: usually one Button. */
  action?: ReactNode
}

/** Nothing to show yet (no rows, no messages, no results), and what would fill it. */
export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <HeroEmptyState className="flex flex-col items-center gap-2 px-4 py-12 text-center">
      {icon ? <div className="mb-1 text-muted [&_svg]:size-6">{icon}</div> : null}
      <p className="text-base font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </HeroEmptyState>
  )
}

export type ErrorStateProps = {
  /** Default "Something went wrong". */
  title?: ReactNode
  /** What failed. An Error shows its message. */
  error?: unknown
  /** Shows a Retry button. */
  onRetry?: () => void
  retryLabel?: string
}

const describe = (error: unknown): string | undefined =>
  error === undefined || error === null
    ? undefined
    : error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error)

/** A load or action failed: the error, and a retry when there is one. */
export function ErrorState({
  title = "Something went wrong",
  error,
  onRetry,
  retryLabel = "Retry",
}: ErrorStateProps) {
  const message = describe(error)
  return (
    <Alert status="danger" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        {message ? <Alert.Description className="break-words">{message}</Alert.Description> : null}
        {onRetry ? (
          <Button size="sm" variant="danger-soft" className="mt-2" onPress={onRetry}>
            {retryLabel}
          </Button>
        ) : null}
      </Alert.Content>
    </Alert>
  )
}

export type LoadingStateProps = {
  /** Default "Loading…". Read by screen readers too. */
  label?: ReactNode
}

/** Waiting on data: a spinner and what is loading, centered in the space the content will take. */
export function LoadingState({ label = "Loading…" }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-sm text-muted"
    >
      <Spinner size="md" />
      <span>{label}</span>
    </div>
  )
}
