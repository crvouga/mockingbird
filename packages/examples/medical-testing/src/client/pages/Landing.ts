import { html } from "htm/preact"
import { useEffect, useState } from "preact/hooks"
import { ApiError, api, type OAuthProvider, type User } from "../api.js"
import { InboxHint } from "../components/InboxHint.js"
import { Logo } from "../components/Logo.js"
import { AppleButton, GoogleButton } from "../components/OAuthButtons.js"
import { OAuthModal } from "../components/OAuthModal.js"
import { message } from "../components/States.js"

const DEMO_ACCOUNTS = [
  ["Ada Lovelace", "Patient", "ada@example.test"],
  ["Morgan Chen", "Clinician", "clinician@example.test"],
  ["Alex Morgan", "Administrator", "admin@example.test"],
] as const

/** The emailed link carries `?sign-in=<token>`; pasting it into the code field works too. */
export const signInLinkToken = (value: string): string | null =>
  /[?&]sign-in=([\w.-]+)/.exec(value)?.[1] ?? null

/** Counts a resend cooldown down to zero, one second at a time. */
const useCountdown = (): [number, (seconds: number) => void] => {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => setLeft(left - 1), 1000)
    return () => clearTimeout(timer)
  }, [left])
  return [left, setLeft]
}

const RESEND_COOLDOWN_SECONDS = 30

export const Landing = ({ onSignedIn }: { onSignedIn: (user: User) => void }) => {
  const [provider, setProvider] = useState<OAuthProvider | null>(null)
  const [email, setEmail] = useState("")
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useCountdown()

  const send = async (address: string) => {
    setBusy(true)
    setError(null)
    try {
      const sent = await api.emailStart(address)
      setSentTo(sent.email)
      setCode("")
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (error) {
      if (error instanceof ApiError && error.retryAfterSeconds) setCooldown(error.retryAfterSeconds)
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  const verify = async (event: Event) => {
    event.preventDefault()
    if (!sentTo) return
    setBusy(true)
    setError(null)
    try {
      const token = signInLinkToken(code)
      const done = token ? await api.emailLink(token) : await api.emailVerify(sentTo, code)
      onSignedIn(done.user)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  const startOver = () => {
    setSentTo(null)
    setCode("")
    setError(null)
  }

  const emailStep = html`<form class="cove-email-form" onSubmit=${(event: Event) => {
    event.preventDefault()
    void send(email)
  }}><label class="cove-field">Email address<input class="cove-input" type="email" name="email" required autocomplete="email" placeholder="you@example.com" data-testid="sign-in-email" value=${email} onInput=${(
    event: Event,
  ) =>
    setEmail(
      (event.target as HTMLInputElement).value,
    )}/></label><button class="cove-btn cove-btn-primary cove-btn-block" data-testid="sign-in-email-submit" disabled=${busy || !email.trim()}>${busy ? "Sending…" : "Email me a sign-in code"}</button><p class="cove-muted cove-text-sm">No password. New here? Entering your email creates your account.</p></form>
    <div class="cove-divider"><span>or</span></div>
    <div class="cove-signin-box"><${GoogleButton} onClick=${() => setProvider("google")}/><${AppleButton} onClick=${() => setProvider("apple")}/></div>
    <div class="cove-demo-accounts"><h3>Explore the workspace</h3><p class="cove-muted cove-text-sm">Three fictional accounts are ready. Pick one to fill in its email, or find them in the Google account chooser.</p>${DEMO_ACCOUNTS.map(
      ([name, role, address]) =>
        html`<button type="button" class="cove-demo-account" key=${address} data-testid="demo-account" data-email=${address} onClick=${() => {
          setEmail(address)
          setError(null)
        }}><div><strong>${name}</strong><span class="cove-role">${role}</span></div><small>${address}</small></button>`,
    )}</div>`

  const codeStep =
    sentTo &&
    html`<${InboxHint} target=${{ channel: "email", to: sentTo }}>We sent a 6-digit code to <strong>${sentTo}</strong>. This is a demo, so nothing left this page: open Notifications to read it.<//>
    <form class="cove-email-form" onSubmit=${verify}><label class="cove-field">Sign-in code<input class="cove-input cove-code-input" name="code" required inputmode="numeric" autocomplete="one-time-code" placeholder="000000" data-testid="sign-in-code" value=${code} onInput=${(
      event: Event,
    ) =>
      setCode(
        (event.target as HTMLInputElement).value,
      )}/></label><button class="cove-btn cove-btn-primary cove-btn-block" data-testid="sign-in-code-submit" disabled=${busy || !code.trim()}>${busy ? "Checking…" : "Sign in"}</button><p class="cove-muted cove-text-sm">The code expires in 10 minutes. You can also paste the sign-in link from the email here.</p></form>
    <div class="cove-code-actions"><button type="button" class="cove-btn-link" data-testid="sign-in-resend" disabled=${busy || cooldown > 0} onClick=${() => send(sentTo)}>${cooldown > 0 ? `Send a new code in ${cooldown}s` : "Send a new code"}</button><button type="button" class="cove-btn-link" onClick=${startOver}>Use a different email</button></div>`

  return html`<div class="cove-signin-layout"><section class="cove-signin-intro"><span class="cove-wordmark"><${Logo}/></span><p class="cove-eyebrow">Your testing workspace</p><h1>From your first test<br/>to your next step.</h1><p class="cove-lede">Order lab tests, follow their progress, and explore detailed results in one place.</p><div class="cove-signin-features">${[
    ["01", "Order with confidence", "Browse tests and review clear, itemized pricing."],
    ["02", "Follow every step", "Email, text and push updates from kit to clinician review."],
    ["03", "Keep your records", "Compare measurements and download your reports."],
  ].map(
    ([number, title, detail]) =>
      html`<div key=${number}><span>${number}</span><div><h2>${title}</h2><p>${detail}</p></div></div>`,
  )}</div></section><section class="cove-card cove-signin-card"><p class="cove-eyebrow">${sentTo ? "Check your email" : "Welcome"}</p><h2>${sentTo ? "Enter your sign-in code" : "Sign in to your account"}</h2>${!sentTo && html`<p class="cove-muted">Get a one-time code by email, or continue with a provider.</p>`}
    ${error && html`<p class="cove-alert cove-alert-error" role="alert" data-testid="sign-in-error">${error}</p>`}
    ${sentTo ? codeStep : emailStep}
    <p class="cove-disclaimer">Fictional demonstration data. No real email, charges or clinical advice. Changes last for this running instance.</p></section>${
      provider &&
      html`<${OAuthModal} provider=${provider} onClose=${() => setProvider(null)} onDone=${(
        user: User,
      ) => {
        setProvider(null)
        onSignedIn(user)
      }}/>`
    }</div>`
}
