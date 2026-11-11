import { html } from "htm/preact"
import { useCallback, useEffect, useRef, useState } from "preact/hooks"
import { api, type OAuthProvider, type OAuthStepResponse, type User } from "../api.js"
import { attachOAuthPage } from "../hostedPages.js"
import { pasteHtml } from "../pasteHtml.js"
import { useEscapeKey } from "./useEscapeKey.js"

type Props = {
  provider: OAuthProvider
  onDone: (user: User) => void
  onClose: () => void
}

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", apple: "Apple" }

/**
 * Renders the identity provider's real hosted sign-in screen (account
 * chooser → consent) inline. The HTML is fetched and pasted into the modal,
 * and the flow is driven by intercepting its form submits and link clicks —
 * each one dispatched through our own server, in-process. Nothing here
 * performs a real navigation or network request.
 */
export const OAuthModal = ({ provider, onDone, onClose }: Props) => {
  const [flowId, setFlowId] = useState<string | null>(null)
  const [pageHtml, setPageHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const pageRef = useRef<HTMLDivElement>(null)
  const stepRef = useRef<(action: string, method: string, body: string) => void>(() => {})
  useEscapeKey(onClose)

  const applyResult = useCallback(
    (result: OAuthStepResponse) => {
      setBusy(false)
      if (result.user) {
        onDone(result.user)
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
  }, [provider, attempt])

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

  stepRef.current = (action, method, body) => void step(action, method, body)

  useEffect(() => {
    const page = pageRef.current
    if (!page || pageHtml === null) return
    const unpaste = pasteHtml(page, pageHtml, {
      onSubmit: (action, method, body) => stepRef.current(action, method, body),
    })
    const detach = attachOAuthPage(page)
    return () => {
      detach()
      unpaste()
    }
  }, [pageHtml, error])

  return html`
    <div class="cove-modal-backdrop" onClick=${(e: Event) => e.target === e.currentTarget && onClose()}>
      <div class="cove-modal" role="dialog" aria-modal="true" aria-label="Sign in with ${PROVIDER_LABEL[provider]}">
        <div class="cove-modal-header">
          <span class="cove-modal-header-text">Signing in with ${PROVIDER_LABEL[provider]}</span>
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
            html`<div class="hosted-page" inert=${busy} ref=${pageRef} role="region" aria-label="${PROVIDER_LABEL[provider]} sign-in"></div>`
          }
        </div>
      </div>
    </div>
  `
}
