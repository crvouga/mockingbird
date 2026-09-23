/**
 * Shared by every modal that renders a real, provider-hosted HTML page
 * inline (OAuth sign-in, Stripe hosted checkout) and drives it by
 * intercepting its own form submits/link clicks instead of letting the
 * iframe actually navigate — there's nowhere real to navigate to, and
 * intercepting keeps the whole flow in-process. Returns a cleanup function.
 */
export const attachFormInterceptor = (
  doc: Document,
  onSubmit: (action: string, method: string, body: string) => void,
): (() => void) => {
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const form = event.target as HTMLFormElement
    const submitter = event.submitter as HTMLButtonElement | null
    const formData = new FormData(form)
    if (submitter?.name) formData.set(submitter.name, submitter.value)
    const params = new URLSearchParams()
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") params.append(key, value)
    }
    // `form.action`/`form.method` are unreliable here: these hosted pages
    // carry a hidden `<input name="action" value="…">` for their own
    // protocol, and a same-named form control shadows the form element's
    // own `action`/`method` IDL properties ("DOM clobbering") — `form.action`
    // then resolves to that <input>, not a URL string. Read the raw
    // attributes instead, which are immune.
    onSubmit(
      form.getAttribute("action") ?? "",
      form.getAttribute("method") ?? "GET",
      params.toString(),
    )
  }

  const click = (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement)?.closest?.("a")
    if (!anchor?.href) return
    event.preventDefault()
    onSubmit(anchor.href, "GET", "")
  }

  doc.addEventListener("submit", submit, { capture: true })
  doc.addEventListener("click", click, { capture: true })
  return () => {
    doc.removeEventListener("submit", submit, { capture: true })
    doc.removeEventListener("click", click, { capture: true })
  }
}
