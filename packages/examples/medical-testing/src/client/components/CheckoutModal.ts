import { html } from "htm/preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"
import { api, type HostedCheckoutStepResponse } from "../api.js"
import { attachFormInterceptor } from "./hostedFrame.js"

type Props = {
  checkoutSessionId: string
  onDone: () => void
  onClose: () => void
}

/**
 * Renders the payments provider's real hosted checkout page inline, in a
 * sandboxed iframe, driven the same way `OAuthModal` drives a sign-in
 * screen — intercepting its form submit and dispatching it through our own
 * server, in-process. When it redirects back to us, we're done; fulfillment
 * itself lands separately and asynchronously, via a webhook.
 */
export const CheckoutModal = ({ checkoutSessionId, onDone, onClose }: Props) => {
  const [flowId, setFlowId] = useState<string | null>(null)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const applyResult = useCallback(
    (result: HostedCheckoutStepResponse) => {
      setBusy(false)
      if (result.done) {
        onDone()
        return
      }
      setFlowId(result.flowId)
      setSrcdoc(result.html)
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
  }, [checkoutSessionId])

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

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || srcdoc === null) return

    let detach: (() => void) | undefined
    const attach = () => {
      const doc = iframe.contentDocument
      if (!doc) return
      detach?.()
      detach = attachFormInterceptor(doc, (action, method, body) => void step(action, method, body))
    }

    iframe.addEventListener("load", attach)
    attach()
    return () => {
      iframe.removeEventListener("load", attach)
      detach?.()
    }
  }, [srcdoc, step])

  return html`
    <div class="cove-modal-backdrop" onClick=${(e: Event) => e.target === e.currentTarget && onClose()}>
      <div class="cove-modal" role="dialog" aria-modal="true" aria-label="Payment">
        <div class="cove-modal-header">
          <span class="cove-modal-header-text">Checkout</span>
          <button class="cove-modal-close" aria-label="Close" onClick=${onClose}>✕</button>
        </div>
        <div class="cove-modal-body">
          ${busy && html`<div class="cove-modal-loading">Loading…</div>`}
          ${
            error &&
            html`<div class="cove-modal-error">
            <p class="cove-alert cove-alert-error">${error}</p>
            <button class="cove-btn cove-btn-ghost" onClick=${onClose}>Close</button>
          </div>`
          }
          ${
            !error &&
            srcdoc !== null &&
            html`<iframe ref=${iframeRef} srcdoc=${srcdoc} title="Payment" />`
          }
        </div>
      </div>
    </div>
  `
}
