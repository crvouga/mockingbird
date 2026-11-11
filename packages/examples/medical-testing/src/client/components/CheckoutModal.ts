import { html } from "htm/preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"
import { api, type HostedCheckoutStepResponse } from "../api.js"
import { attachCheckoutPage } from "../hostedPages.js"
import { pasteHtml } from "../pasteHtml.js"
import { useEscapeKey } from "./useEscapeKey.js"

type Props = {
  checkoutSessionId: string
  onDone: () => void
  onClose: () => void
}

/**
 * Renders the payments provider's real hosted checkout page inline, the same
 * way `OAuthModal` drives a sign-in screen: fetch the page, paste it, and
 * intercept its form submit through our own server, in-process. When it
 * redirects back to us, we're done; fulfillment lands separately, via a webhook.
 */
export const CheckoutModal = ({ checkoutSessionId, onDone, onClose }: Props) => {
  const [flowId, setFlowId] = useState<string | null>(null)
  const [pageHtml, setPageHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const pageRef = useRef<HTMLDivElement>(null)
  const stepRef = useRef<(action: string, method: string, body: string) => void>(() => {})
  useEscapeKey(onClose)

  const applyResult = useCallback(
    (result: HostedCheckoutStepResponse) => {
      setBusy(false)
      if (result.done) {
        onDone()
        return
      }
      setFlowId(result.flowId)
      setPageHtml(result.html)
    },
    [onDone],
  )

  const fail = useCallback((err: unknown) => {
    setBusy(false)
    setError(err instanceof Error ? err.message : String(err))
  }, [])

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    setError(null)
    setPageHtml(null)
    api
      .hostedCheckoutStart(checkoutSessionId)
      .then((result) => {
        if (!cancelled) applyResult(result)
      })
      .catch((err) => {
        if (!cancelled) fail(err)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutSessionId, attempt])

  const step = useCallback(
    async (action: string, method: string, body: string) => {
      if (!flowId) return
      setBusy(true)
      setError(null)
      try {
        applyResult(await api.hostedCheckoutStep(flowId, action, method, body))
      } catch (err) {
        fail(err)
      }
    },
    [flowId, applyResult, fail],
  )

  stepRef.current = (action, method, body) => void step(action, method, body)

  useEffect(() => {
    const page = pageRef.current
    if (!page || pageHtml === null) return
    const unpaste = pasteHtml(page, pageHtml, {
      onSubmit: (action, method, body) => stepRef.current(action, method, body),
    })
    const detach = attachCheckoutPage(page)
    return () => {
      detach()
      unpaste()
    }
  }, [pageHtml, error])

  return html`
    <div class="cove-modal-backdrop" onClick=${(e: Event) => e.target === e.currentTarget && onClose()}>
      <div class="cove-modal" role="dialog" aria-modal="true" aria-label="Payment">
        <div class="cove-modal-header">
          <span class="cove-modal-header-text">Checkout</span>
          <button class="cove-modal-close" aria-label="Close" onClick=${onClose}>✕</button>
        </div>
        <div class="cove-modal-body" aria-busy=${busy}>
          ${busy && html`<div class="cove-modal-loading" role="status">Loading…</div>`}
          ${
            error &&
            html`<div class="cove-modal-error">
            <p class="cove-alert cove-alert-error" role="alert">${error}</p>
            <button class="cove-btn cove-btn-primary" onClick=${() => setAttempt((value) => value + 1)}>Try again</button>
          </div>`
          }
          ${
            !error &&
            pageHtml !== null &&
            html`<div class="hosted-page" inert=${busy} ref=${pageRef} role="region" aria-label="Payment"></div>`
          }
        </div>
      </div>
    </div>
  `
}
