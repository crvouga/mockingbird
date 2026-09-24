import { html } from "htm/preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"
import { api, type OAuthProvider, type OAuthStepResponse, type User } from "../api.js"
import { attachFormInterceptor } from "./hostedFrame.js"
import { useEscapeKey } from "./useEscapeKey.js"

type Props = {
  provider: OAuthProvider
  onDone: (user: User) => void
  onClose: () => void
}

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", apple: "Apple" }

/**
 * Renders the identity provider's real hosted sign-in screen (account
 * chooser → consent) inline, in a sandboxed iframe, and drives the flow by
 * intercepting its form submits/link clicks — dispatching each one through
 * our own server, in-process. Nothing here ever performs a real navigation
 * or network request.
 */
export const OAuthModal = ({ provider, onDone, onClose }: Props) => {
  const [flowId, setFlowId] = useState<string | null>(null)
  const [srcdoc, setSrcdoc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  useEscapeKey(onClose)

  const applyResult = useCallback(
    (result: OAuthStepResponse) => {
      setBusy(false)
      if (result.user) {
        onDone(result.user)
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
      .oauthStart(provider)
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
  }, [provider])

  const step = useCallback(
    async (action: string, method: string, body: string) => {
      if (!flowId) return
      setBusy(true)
      setError(null)
      try {
        applyResult(await api.oauthStep(provider, flowId, action, method, body))
      } catch (err) {
        fail(err)
      }
    },
    [flowId, provider, applyResult, fail],
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
    // The initial srcdoc load may have already fired before this listener
    // attached (fast in-process response) — attach eagerly too.
    attach()
    return () => {
      iframe.removeEventListener("load", attach)
      detach?.()
    }
  }, [srcdoc, step])

  return html`
    <div class="cove-modal-backdrop" onClick=${(e: Event) => e.target === e.currentTarget && onClose()}>
      <div class="cove-modal" role="dialog" aria-modal="true" aria-label="Sign in with ${PROVIDER_LABEL[provider]}">
        <div class="cove-modal-header">
          <span class="cove-modal-header-text">Signing in with ${PROVIDER_LABEL[provider]}</span>
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
            html`<iframe ref=${iframeRef} srcdoc=${srcdoc} title="${PROVIDER_LABEL[provider]} sign-in" />`
          }
        </div>
      </div>
    </div>
  `
}
