/**
 * Drives the app the way its Preact client does, through `client/api.ts` and
 * whatever `Fetcher` the test installed (usually `createInProcessFetcher`).
 * Shared by the in-process tests.
 */

import type { User } from "../src/app/model.js"
import { api } from "../src/client/api.js"

type ParsedForm = {
  method: string
  action: string
  fields: Record<string, string>
  submitters: { name: string; value: string }[]
}

const decodeEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

/** A form with no `action` attribute (the hosted checkout page's form) submits to its own URL — see the caller. */
const extractForms = (html: string): ParsedForm[] => {
  const forms: ParsedForm[] = []
  for (const match of html.matchAll(
    /<form\s+method="([^"]+)"(?:\s+action="([^"]*)")?[^>]*>([\s\S]*?)<\/form>/gi,
  )) {
    const [, method, action, inner] = match
    if (!method || inner === undefined) continue
    const fields: Record<string, string> = {}
    for (const field of inner.matchAll(/<input[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"/gi))
      fields[field[1] as string] = decodeEntities(field[2] as string)
    const submitters: { name: string; value: string }[] = []
    for (const btn of inner.matchAll(/<button[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]+)"/gi))
      submitters.push({ name: btn[1] as string, value: decodeEntities(btn[2] as string) })
    forms.push({ method, action: action ?? "", fields, submitters })
  }
  return forms
}

/**
 * Drives the real Google login through `client/api.ts`'s
 * `api.oauthStart`/`api.oauthStep` — the exact calls the Preact `OAuthModal`
 * component makes — so this proves the whole in-process OAuth wiring works
 * through the same `Fetcher` seam `composition/browser.ts`'s `mount()`
 * installs.
 */
export const signInWithGoogle = async (account = "ada"): Promise<User> => {
  const start = await api.oauthStart("google")
  if (!("flowId" in start) || !start.html) throw new Error("Expected the chooser HTML from /start")

  const chooserForms = extractForms(start.html)
  const isAccount = (s: { name: string; value: string }) =>
    s.name === "account" && s.value === account
  const selectForm = chooserForms.find((form) => form.submitters.some(isAccount))
  if (!selectForm) throw new Error(`No "${account}" account in the chooser page`)
  const accountSubmitter = selectForm.submitters.find(isAccount)
  if (!accountSubmitter) throw new Error("No account submitter")

  const afterSelect = await api.oauthStep(
    "google",
    start.flowId,
    selectForm.action,
    selectForm.method,
    new URLSearchParams({
      ...selectForm.fields,
      [accountSubmitter.name]: accountSubmitter.value,
    }).toString(),
  )
  if (!("flowId" in afterSelect) || !afterSelect.html) throw new Error("Expected the consent HTML")

  const consentForms = extractForms(afterSelect.html)
  const allowForm = consentForms.find((form) => form.submitters.some((s) => s.value === "allow"))
  if (!allowForm) throw new Error("No consent form with an allow submitter")
  const allowSubmitter = allowForm.submitters.find((s) => s.value === "allow")
  if (!allowSubmitter) throw new Error("No allow submitter")

  const done = await api.oauthStep(
    "google",
    afterSelect.flowId,
    allowForm.action,
    allowForm.method,
    new URLSearchParams({
      ...allowForm.fields,
      [allowSubmitter.name]: allowSubmitter.value,
    }).toString(),
  )
  if (!done.user) throw new Error("Expected a signed-in user after consent")
  return done.user
}

/** Stripe's test card that is always declined. */
export const DECLINED_CARD = "4000000000000002"

/** Drives a real hosted-checkout payment through `client/api.ts`'s public surface — the exact calls `CheckoutModal` makes. */
export const payWithHostedCheckout = async (
  checkoutSessionId: string,
  card = "4242424242424242",
): Promise<void> => {
  const start = await api.hostedCheckoutStart(checkoutSessionId)
  if (!("flowId" in start) || !start.html) throw new Error("Expected the hosted checkout page HTML")

  const forms = extractForms(start.html)
  const payForm = forms.find((form) => form.submitters.some((s) => s.value === "pay"))
  if (!payForm) throw new Error("No payment form on the hosted checkout page")
  const paySubmitter = payForm.submitters.find((s) => s.value === "pay")
  if (!paySubmitter) throw new Error("No pay submitter")

  const done = await api.hostedCheckoutStep(
    start.flowId,
    payForm.action,
    payForm.method,
    new URLSearchParams({
      ...payForm.fields,
      [paySubmitter.name]: paySubmitter.value,
      card,
    }).toString(),
  )
  // A declined card re-renders the payment page instead of finishing.
  if (card === DECLINED_CARD) return
  if (!done.done) throw new Error("Expected the hosted checkout flow to finish")
}

export const waitUntil = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for condition")
}
