/**
 * The dashboard's design rules, as a check on a drawn surface:
 *
 * 1. A surface is a query or a mutation, never both.
 * 2. A mutation is exactly one form with exactly one submit button; a query has no form and no
 *    control that changes anything on the server.
 * 3. Feedback is inline: nothing announces itself outside the place it is about.
 *
 * `auditSurface` is pure and refers to nothing outside itself, so a browser test can run it in the
 * page: `page.evaluate(`(${auditSurface})(document.querySelector("#app"))`)`.
 */

export type SurfaceKind = "query" | "mutation"

/**
 * What is wrong with the surface drawn inside `root`, in plain sentences; empty when nothing is.
 * `kind` defaults to what the surface says it is (`data-surface` on its `<main>`).
 */
export function auditSurface(root: Element, kind?: SurfaceKind): string[] {
  const problems: string[] = []
  const surfaces = [...root.querySelectorAll("[data-surface]")]
  const surface = surfaces[0]
  if (surfaces.length !== 1 || !surface)
    return [`expected one surface (an element with data-surface), found ${surfaces.length}`]
  const declared = surface.getAttribute("data-surface")
  if (declared !== "query" && declared !== "mutation")
    return [`data-surface is "${declared}", not "query" or "mutation"`]
  const expected = kind ?? declared
  if (declared !== expected) problems.push(`drawn as a ${declared}, expected a ${expected}`)

  const name = (element: Element) =>
    `<${element.tagName.toLowerCase()}> "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}"`
  const all = (selector: string) => [...root.querySelectorAll(selector)]
  const forms = all("form")
  const buttons = all("button, input[type=submit], input[type=button], input[type=image]")
  // A button does something to this page only (copy a value, download a file) when it says so.
  const local = (button: Element) =>
    button.getAttribute("type") === "button" && button.hasAttribute("data-local")
  const submits = buttons.filter((button) => !local(button))

  if (expected === "query") {
    for (const form of forms) problems.push(`a query surface has a form: ${name(form)}`)
    for (const button of submits)
      problems.push(`a query surface has a control that is not a link: ${name(button)}`)
    // The one field a query may have is a search box that filters what is already on screen.
    for (const field of all("select, textarea, input, [contenteditable]"))
      if (field.getAttribute("type") !== "search")
        problems.push(`a query surface has an input: ${name(field)}`)
    for (const control of all("[role=switch], [role=checkbox], [role=radio], [aria-pressed]"))
      problems.push(`a query surface has a toggle: ${name(control)}`)
  } else {
    if (forms.length !== 1)
      problems.push(`a mutation surface has ${forms.length} forms, expected exactly 1`)
    const form = forms[0]
    const inForm = submits.filter((button) => form?.contains(button))
    if (inForm.length !== 1)
      problems.push(`a mutation form has ${inForm.length} submit buttons, expected exactly 1`)
    for (const button of submits)
      if (!form?.contains(button)) problems.push(`a button outside the form: ${name(button)}`)
    for (const button of buttons.filter(local))
      problems.push(`a mutation surface has a second action: ${name(button)}`)
    for (const field of all("select, textarea, input"))
      if (!form?.contains(field)) problems.push(`a field outside the form: ${name(field)}`)
    if (form && !form.querySelector("a[data-cancel]"))
      problems.push("the form has no Cancel link (a[data-cancel])")
    for (const field of all("[aria-invalid=true]")) {
      const described = (field.getAttribute("aria-describedby") ?? "").split(/\s+/)
      if (!described.some((id) => id && root.querySelector(`#${id}.field-error`)))
        problems.push(`an invalid field is not described by its error: ${name(field)}`)
    }
  }

  // Feedback belongs where it happened: in the form, or beside the thing it is about.
  for (const live of all("[role=alert], [role=status], [role=log], [aria-live]")) {
    const where = live.closest("form") ? "form" : surface.contains(live) ? "surface" : "page"
    if (where === "page")
      problems.push(`feedback outside the surface (a toast or banner): ${name(live)}`)
    else if (expected === "mutation" && where !== "form")
      problems.push(`feedback outside the form: ${name(live)}`)
    if (/toast|snackbar|flash|banner/i.test(live.getAttribute("class") ?? ""))
      problems.push(`a toast by name: ${name(live)}`)
    const position = live.ownerDocument.defaultView?.getComputedStyle(live).position
    if (position === "fixed" || position === "sticky")
      problems.push(`floating feedback (position: ${position}): ${name(live)}`)
  }
  return problems
}
