import { ErrorState, LoadingState } from "@crvouga/mockingbird-ui/react"
import { Modal } from "@heroui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { pasteHtml } from "../pasteHtml.js"
import { message, usePortalContainer } from "./States.js"

/** One step of a provider's hosted flow: its next page, or the end of the flow. */
export type HostedStep<Done> = { flowId: string; html: string } | { done: Done }

type Props<Done> = {
  /** The modal's heading: "Signing in with Google", "Checkout". */
  title: string
  /** The pasted page's landmark name. */
  regionLabel: string
  /** Changing it restarts the flow. */
  flowKey: string
  start: () => Promise<HostedStep<Done>>
  step: (flowId: string, action: string, method: string, body: string) => Promise<HostedStep<Done>>
  /** Re-implements the page's own inline script (`hostedPages.ts`); returns a cleanup. */
  attach: (host: HTMLElement) => () => void
  onDone: (done: Done) => void
  onClose: () => void
}

/**
 * A provider's real hosted page (sign-in, checkout) in the app's modal: fetch the page, paste it,
 * and send its form submits and link clicks through the app's own server, in-process. Nothing
 * here performs a real navigation or network request.
 */
export function HostedPageModal<Done>({
  title,
  regionLabel,
  flowKey,
  start,
  step,
  attach,
  onDone,
  onClose,
}: Props<Done>) {
  const [flowId, setFlowId] = useState<string | null>(null)
  const [pageHtml, setPageHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const pageRef = useRef<HTMLElement>(null)
  const stepRef = useRef<(action: string, method: string, body: string) => void>(() => {})
  const latest = useRef({ start, step, attach, onDone })
  latest.current = { start, step, attach, onDone }
  const portal = usePortalContainer()

  const apply = useCallback((result: HostedStep<Done>) => {
    setBusy(false)
    if ("done" in result) {
      latest.current.onDone(result.done)
      return
    }
    setFlowId(result.flowId)
    setPageHtml(result.html)
  }, [])

  const fail = useCallback((err: unknown) => {
    setBusy(false)
    setError(message(err))
  }, [])

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    setPageHtml(null)
    latest.current
      .start()
      .then((result) => {
        if (!cancelled) apply(result)
      })
      .catch((err) => {
        if (!cancelled) fail(err)
      })
    return () => {
      cancelled = true
    }
  }, [flowKey, attempt, apply, fail])

  stepRef.current = (action, method, body) => {
    if (!flowId) return
    setBusy(true)
    setError(null)
    latest.current.step(flowId, action, method, body).then(apply, fail)
  }

  useEffect(() => {
    const page = pageRef.current
    if (!page || pageHtml === null) return
    const unpaste = pasteHtml(page, pageHtml, {
      onSubmit: (action, method, body) => stepRef.current(action, method, body),
    })
    const detach = latest.current.attach(page)
    return () => {
      detach()
      unpaste()
    }
  }, [pageHtml, error])

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      className="h-full"
      {...portal}
    >
      <Modal.Container size="md" className="h-full p-0 sm:p-6">
        <Modal.Dialog
          aria-label={title}
          className="h-full max-h-[760px] gap-0 overflow-hidden p-0 max-sm:max-h-none max-sm:rounded-none"
        >
          <Modal.Header className="flex-row items-center gap-3 border-b border-separator px-4 py-3">
            <Modal.Heading className="flex-1 text-sm font-semibold">{title}</Modal.Heading>
            <Modal.CloseTrigger aria-label="Close" className="static" />
          </Modal.Header>
          <Modal.Body className="relative m-0 min-h-0 flex-1 overflow-hidden p-0" aria-busy={busy}>
            {busy ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-overlay">
                <LoadingState />
              </div>
            ) : null}
            {error ? (
              <div className="p-4" data-testid="hosted-page-error">
                <ErrorState
                  title="This step could not load"
                  error={error}
                  onRetry={() => setAttempt((value) => value + 1)}
                  retryLabel="Try again"
                />
              </div>
            ) : null}
            {!error && pageHtml !== null ? (
              <section
                ref={pageRef}
                inert={busy}
                aria-label={regionLabel}
                data-testid="hosted-page"
                className="block size-full min-w-0 overflow-y-auto overflow-x-clip"
              />
            ) : null}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
