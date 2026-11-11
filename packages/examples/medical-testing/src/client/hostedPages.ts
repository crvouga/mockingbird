/**
 * A provider's hosted page ships a small inline script: the OAuth pages remember a theme and
 * follow their own redirect, the Stripe checkout page formats the card fields and fills test
 * cards. A pasted page's scripts never run (see `pasteHtml`), because running one means
 * evaluating a string, which a Content Security Policy without `'unsafe-eval'` refuses. The
 * same behaviour is implemented here as ordinary code and attached after the paste.
 *
 * Each function returns a cleanup. Listeners on the pasted elements go away with them; the
 * cleanup only has to stop anything still pending.
 */

const byId = <T extends HTMLElement>(host: HTMLElement, id: string): T | null =>
  host.querySelector<T>(`#${CSS.escape(id)}`)

const OAUTH_THEME_KEY = "oauth-mock-theme"

/** The OAuth emulator's pages: account chooser, consent, and the two callback handoffs. */
export const attachOAuthPage = (host: HTMLElement): (() => void) => {
  const page = host.querySelector<HTMLElement>(":scope > .page")
  const inputs = [...host.querySelectorAll<HTMLInputElement>('input[name="oauth-theme"]')]
  const apply = (value: string): void => {
    if (page) page.dataset.theme = value
    for (const input of inputs) input.checked = input.value === value
    try {
      sessionStorage.setItem(OAUTH_THEME_KEY, value)
    } catch {}
  }
  try {
    const saved = sessionStorage.getItem(OAUTH_THEME_KEY)
    if (saved && ["system", "light", "dark"].includes(saved)) apply(saved)
  } catch {}
  for (const input of inputs) input.addEventListener("change", () => apply(input.value))

  // The handoff pages send the browser back to the app by themselves. Both go through the
  // paste's submit and link interceptor, so neither navigates the surrounding page.
  let cancelled = false
  queueMicrotask(() => {
    if (cancelled) return
    const callback = byId(host, "callback")
    if (
      callback instanceof HTMLFormElement &&
      callback.querySelector('[data-testid="oauth-mock-form-post-continue"]')
    )
      callback.requestSubmit()
    else if (
      callback instanceof HTMLAnchorElement &&
      callback.dataset.testid === "oauth-mock-redirect-continue"
    )
      callback.click()
  })
  return () => {
    cancelled = true
  }
}

const AUTOPAY_KEY = "mockingbird.checkout.autopay"

const cardBrand = (digits: string): string =>
  /^3[47]/.test(digits)
    ? "amex"
    : /^(6011|65|64[4-9])/.test(digits)
      ? "discover"
      : /^(5[1-5]|2[2-7])/.test(digits)
        ? "mastercard"
        : /^4/.test(digits)
          ? "visa"
          : ""

/** `4242424242424242` → `4242 4242 4242 4242`, in the groups that card brand prints. */
export const formatCardNumber = (value: string): { text: string; brand: string } => {
  const digits = value.replace(/\D/g, "").slice(0, 19)
  const brand = cardBrand(digits)
  const parts: string[] = []
  let at = 0
  for (const size of brand === "amex" ? [4, 6, 5] : [4, 4, 4, 4, 3]) {
    if (at >= digits.length) break
    parts.push(digits.slice(at, at + size))
    at += size
  }
  return { text: parts.join(" "), brand }
}

/** `1234` → `12 / 34`. A first digit above 1 is a month, so it gets its leading zero. */
export const formatCardExpiry = (value: string, deleting = false): string => {
  let digits = value.replace(/\D/g, "").slice(0, 4)
  if (digits.length === 1 && Number(digits) > 1) digits = `0${digits}`
  return digits.length > 2 || (digits.length === 2 && !deleting)
    ? `${digits.slice(0, 2)} / ${digits.slice(2)}`
    : digits
}

/** The Stripe emulator's hosted checkout page: card formatting, test cards, and the pay spinner. */
export const attachCheckoutPage = (host: HTMLElement): (() => void) => {
  const form = byId<HTMLFormElement>(host, "stripe-mock-form")
  if (!form) return () => {}
  form.addEventListener("submit", (event) => {
    const submitter = event.submitter
    if (submitter instanceof HTMLButtonElement && submitter.value === "cancel") return
    form.classList.add("processing")
  })
  const card = byId<HTMLInputElement>(host, "card")
  const exp = byId<HTMLInputElement>(host, "exp")
  const cvc = byId<HTMLInputElement>(host, "cvc")
  const zip = byId<HTMLInputElement>(host, "zip")
  const country = byId<HTMLSelectElement>(host, "country")
  const icons = byId(host, "card-icons")
  if (!card || !exp || !cvc || !zip || !country) return () => {}

  const formatCard = (event?: Event): void => {
    const { text, brand } = formatCardNumber(card.value)
    card.value = text
    if (event) card.closest(".row")?.classList.remove("invalid")
    if (brand) icons?.setAttribute("data-brand", brand)
    else icons?.removeAttribute("data-brand")
    for (const icon of icons?.querySelectorAll<SVGElement>("svg") ?? [])
      icon.classList.toggle("active", icon.dataset.brand === brand)
    cvc.placeholder = brand === "amex" ? "CVV" : "CVC"
    cvc.maxLength = brand === "amex" ? 4 : 3
  }
  const formatExp = (event?: Event): void => {
    exp.value = formatCardExpiry(
      exp.value,
      (event as InputEvent | undefined)?.inputType === "deleteContentBackward",
    )
  }
  const formatZip = (): void => {
    const us = country.value === "US"
    zip.placeholder = us ? "ZIP" : "Postal code"
    zip.inputMode = us ? "numeric" : "text"
    zip.maxLength = us ? 5 : 10
  }
  card.addEventListener("input", formatCard)
  exp.addEventListener("input", formatExp)
  cvc.addEventListener("input", () => {
    cvc.value = cvc.value.replace(/\D/g, "")
  })
  country.addEventListener("change", formatZip)
  formatCard()
  formatExp()
  formatZip()

  const autopay = byId<HTMLInputElement>(host, "stripe-mock-autopay")
  if (autopay) {
    try {
      autopay.checked = localStorage.getItem(AUTOPAY_KEY) === "1"
    } catch {}
    autopay.addEventListener("change", () => {
      try {
        localStorage.setItem(AUTOPAY_KEY, autopay.checked ? "1" : "0")
      } catch {}
    })
  }
  const set = (input: HTMLInputElement | HTMLSelectElement | null, value: string): void => {
    if (!input || (input instanceof HTMLInputElement && input.readOnly)) return
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }
  const timers = new Set<ReturnType<typeof setTimeout>>()
  for (const button of host.querySelectorAll<HTMLElement>("[data-test-card]")) {
    button.addEventListener("click", () => {
      const number = button.getAttribute("data-test-card") ?? ""
      const email = byId<HTMLInputElement>(host, "email")
      set(email, email?.value ? email.value : "jenny.rosen@example.com")
      set(card, number)
      set(exp, "12 / 34")
      set(cvc, /^3[47]/.test(number) ? "1234" : "123")
      set(byId<HTMLInputElement>(host, "name"), "Jenny Rosen")
      set(country, "US")
      set(zip, "94107")
      button.classList.add("flash")
      const timer = setTimeout(() => {
        timers.delete(timer)
        button.classList.remove("flash")
      }, 400)
      timers.add(timer)
      const pay = host.querySelector<HTMLElement>("[data-testid='stripe-mock-pay']")
      if (autopay?.checked && pay) form.requestSubmit(pay)
      else pay?.focus()
    })
  }
  return () => {
    for (const timer of timers) clearTimeout(timer)
  }
}
