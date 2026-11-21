/**
 * The pages of Persona's hosted inquiry flow as the emulator serves it: the test controls that
 * finish an inquiry with an outcome, how it ended (when there is no `redirect-uri` to return to),
 * and the not-found and conflict pages. Server-rendered with React into complete HTML (the
 * outcomes are plain links, so nothing needs JavaScript) and prebuilt into `dist-ui/server.js`
 * (see packages/ui/README.md, "Pages served as strings"), which `src/index.ts` imports lazily
 * through `#ui/server`, so React never loads on the inquiry API's path.
 */
import { CenteredCard, type Status, StatusChip } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { Alert, buttonVariants } from "@heroui/react"
import type { ReactNode } from "react"

const PRODUCT = "Persona"
const NOTICE = "A Mockingbird emulator: no real account is used."

const document = (title: string, element: ReactNode): string =>
  renderPage(element, {
    title: `${title} · ${PRODUCT}`,
    css: MOCKINGBIRD_CSS,
    rememberTheme: true,
  })

const card = (props: { title: ReactNode; description?: ReactNode; children?: ReactNode }) => (
  <CenteredCard product={PRODUCT} notice={NOTICE} {...props} />
)

/** One outcome the test controls offer. */
export type Outcome = {
  /** The `outcome` query value, on the link as `data-outcome`. */
  outcome: string
  label: string
  /** The link, relative to `…/verify`. */
  href: string
}

const OUTCOME_STYLE: Record<string, "primary" | "danger-soft" | "secondary"> = {
  approve: "primary",
  decline: "danger-soft",
  fail: "danger-soft",
}

/** `GET /verify?inquiry-id=`: the inquiry, and a link per outcome. */
export function hostedFlowPage(props: {
  inquiryId: string
  /** The public namespace, when it is not `default`. */
  namespace?: string | undefined
  outcomes: readonly Outcome[]
}): string {
  return document(
    "Verify your identity",
    card({
      title: "Verify your identity",
      description: (
        <>
          Mock Persona hosted flow for{" "}
          <code className="font-mono text-[13px] break-all text-foreground">{props.inquiryId}</code>
          {props.namespace ? ` (namespace ${props.namespace})` : ""}. Choose how it ends.
        </>
      ),
      children: (
        <ul className="flex flex-col gap-2" aria-label="Outcomes">
          {props.outcomes.map((outcome) => (
            <li key={outcome.outcome}>
              <a
                data-outcome={outcome.outcome}
                href={outcome.href}
                className={buttonVariants({
                  variant: OUTCOME_STYLE[outcome.outcome] ?? "secondary",
                  fullWidth: true,
                })}
              >
                {outcome.label}
              </a>
            </li>
          ))}
        </ul>
      ),
    }),
  )
}

const STATUS: Record<string, Status> = {
  approved: "ok",
  completed: "ok",
  declined: "error",
  failed: "error",
  needs_review: "warning",
}

/** How the inquiry ended, when there is no `redirect-uri` to send the member back to. */
export function donePage(status: string): string {
  return document(
    "Done",
    card({
      title: `Done: ${status}`,
      description: "The inquiry is finished. You can close this page.",
      children: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted">Inquiry status</span>
          <StatusChip status={STATUS[status] ?? "neutral"}>{status}</StatusChip>
        </div>
      ),
    }),
  )
}

/** No inquiry has this id. */
export function notFoundPage(): string {
  return document(
    "Inquiry not found",
    card({
      title: "Inquiry not found",
      description: "Check the inquiry-id in the link, or create the inquiry again.",
    }),
  )
}

/** The outcome cannot be applied: unknown, or not reachable from the inquiry's status. */
export function conflictPage(message: string): string {
  return document(
    "Inquiry not finished",
    card({
      title: "The inquiry could not be finished",
      children: (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title className="break-words">{message}</Alert.Title>
          </Alert.Content>
        </Alert>
      ),
    }),
  )
}
