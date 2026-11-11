/**
 * The one layout every mutation screen uses: a heading that names the action and its object, a
 * sentence of consequence, labelled fields, one submit button and a Cancel link.
 *
 * Feedback stays in the form. A problem with a field is written under that field and tied to it
 * with `aria-describedby` and `aria-invalid`; anything else is a summary at the top of the form
 * (`role="alert"`). While the request is in flight the submit button is disabled and says so.
 */
import { type Child, h, type Props } from "./dom.js"
import { ApiError, busy, link, MANAGED_BY_DECLARATION } from "./runtime.js"

export type Values = Record<string, string>

type Common = {
  name: string
  label: string
  hint?: Child
  /** What to say when it is left empty; absent means it may be. */
  required?: string
}
export type Field =
  | (Common & {
      kind: "text"
      type?: "text" | "email" | "password" | "number"
      value?: string
      attrs?: Props
    })
  | (Common & { kind: "select"; value: string; options: { value: string; label: string }[] })
  | (Common & {
      kind: "choice"
      value: string
      options: { value: string; label: string; description?: string; note?: string }[]
    })

export type MutationSpec = {
  title: string
  crumbs?: Child
  /** What submitting does, where that is not obvious from the title. */
  lead?: Child
  /** A better way to do this than the form, said once above it. */
  note?: Child
  /** The action destroys something: the consequence and the button are marked. */
  danger?: boolean
  /** Facts about the thing acted on, shown read-only above the fields. */
  facts?: Child
  fields?: Field[]
  submit: string
  /** The button's label while the request is in flight: "Creating…". */
  pending: string
  /** Where Cancel goes: the screen this one was opened from. */
  cancel: string
  /** The summary's first line when the API refuses: "The project was not created." */
  failed: string
  /** Problems the browser can see without asking: field name → message. */
  check?: (values: Values) => Record<string, string>
  /** The field a refusal without `details` is about, if it is about one. */
  place?: (error: ApiError) => string | undefined
  /** Make the one API call, then `land` on the screen its result lives on. */
  run: (values: Values) => Promise<unknown>
}

const fieldId = (name: string) => `field-${name}`

/** "must be at most 80 characters" → "Name must be at most 80 characters." */
function phrase(label: string, problem: string) {
  if (problem === "required") return `Enter ${label.charAt(0).toLowerCase()}${label.slice(1)}.`
  const sentence = /^[a-z]/.test(problem) ? `${label} ${problem}` : problem
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/** Sort a refusal into the fields it is about and whatever belongs to none of them. */
export function sortProblems(error: unknown, fields: Field[], place?: MutationSpec["place"]) {
  const byField: Record<string, string> = {}
  const rest: string[] = []
  if (!(error instanceof ApiError))
    return {
      byField,
      rest: ["The server could not be reached. Check your connection and try again."],
    }
  const details = Array.isArray(error.details)
    ? error.details.filter((detail): detail is string => typeof detail === "string")
    : []
  for (const detail of details) {
    const [, name, problem] = /^body\.([A-Za-z0-9_]+)[^:]*:\s*(.*)$/.exec(detail) ?? []
    const field = fields.find((entry) => entry.name === name)
    if (field && problem) byField[field.name] ??= phrase(field.label, problem)
    else rest.push(detail)
  }
  if (details.length === 0) {
    // The organization came under a mockingbird.yaml meanwhile: no field's value is at fault.
    const about = error.code === MANAGED_BY_DECLARATION ? undefined : place?.(error)
    const field = fields.find((entry) => entry.name === about)
    // The API names the field by its JSON key ("requestsPerMinute cannot exceed…"): use its label.
    if (field)
      byField[field.name] = phrase(
        field.label,
        error.message.startsWith(`${field.name} `)
          ? error.message.slice(field.name.length + 1)
          : error.message.replace(/^[a-z]/, (letter) => letter.toUpperCase()),
      )
    else rest.push(error.message)
  }
  return { byField, rest }
}

function control(field: Field): HTMLElement {
  const id = fieldId(field.name)
  const hint = field.hint && h("p.hint", { id: `${id}-hint` }, field.hint)
  const described = hint ? { "aria-describedby": `${id}-hint` } : {}
  if (field.kind === "choice")
    return h(
      "fieldset.field.choices",
      { "data-field": field.name, id, tabindex: "-1", ...described },
      h("legend", {}, field.label),
      hint,
      h(
        ".choice-list",
        {},
        field.options.map((option) =>
          h(
            "label.choice",
            {},
            h("input", {
              type: "radio",
              name: field.name,
              value: option.value,
              checked: option.value === field.value,
            }),
            h(
              "span.choice-text",
              {},
              h(
                "span.choice-title",
                {},
                option.label,
                option.note && h("span.tag", {}, option.note),
              ),
              option.description && h("span.choice-about", {}, option.description),
            ),
          ),
        ),
      ),
    )
  const input =
    field.kind === "select"
      ? h(
          "select",
          { id, name: field.name, ...described },
          field.options.map((option) =>
            h(
              "option",
              { value: option.value, selected: option.value === field.value },
              option.label,
            ),
          ),
        )
      : h("input", {
          id,
          name: field.name,
          type: field.type ?? "text",
          value: field.value ?? "",
          autocomplete: "off",
          ...described,
          ...field.attrs,
        })
  return h(
    ".field",
    { "data-field": field.name },
    h("label", { for: id }, field.label),
    hint,
    input,
  )
}

export function mutation(spec: MutationSpec): Child {
  const fields = spec.fields ?? []
  const submit = h(
    `button.${spec.danger ? "danger-solid" : "primary"}`,
    { type: "submit" },
    spec.submit,
  ) as HTMLButtonElement
  const form = h(
    "form.mutation",
    { novalidate: true, "aria-labelledby": "surface-title" },
    fields.map(control),
    h(
      ".form-actions",
      {},
      submit,
      link(spec.cancel, { class: "cancel", "data-cancel": "" }, "Cancel"),
    ),
  ) as HTMLFormElement

  const read = (): Values =>
    Object.fromEntries(
      fields.map((field) => {
        const value = new FormData(form).get(field.name)
        return [field.name, typeof value === "string" ? value.trim() : ""]
      }),
    )
  /** The element a field's problem is announced on: the input, or each radio of a choice. */
  const inputs = (name: string) => [
    ...form.querySelectorAll<HTMLElement>(`[data-field="${name}"] :is(input, select)`),
  ]

  function clear() {
    form.querySelector(".form-error")?.remove()
    for (const stale of form.querySelectorAll(".field-error")) stale.remove()
    for (const field of fields)
      for (const input of inputs(field.name)) {
        input.removeAttribute("aria-invalid")
        const hint = form.querySelector(`#${fieldId(field.name)}-hint`)
        if (hint) input.setAttribute("aria-describedby", hint.id)
        else input.removeAttribute("aria-describedby")
      }
  }

  function show(byField: Record<string, string>, rest: string[]) {
    for (const [name, message] of Object.entries(byField)) {
      const holder = form.querySelector(`[data-field="${name}"]`)
      const error = h("p.field-error", { id: `${fieldId(name)}-error` }, message)
      holder?.append(error)
      for (const input of inputs(name)) {
        input.setAttribute("aria-invalid", "true")
        const described = input.getAttribute("aria-describedby")
        input.setAttribute("aria-describedby", described ? `${described} ${error.id}` : error.id)
      }
    }
    if (rest.length > 0) {
      const summary = h(
        ".form-error",
        { role: "alert", tabindex: "-1", id: "form-error" },
        h("strong", {}, spec.failed),
        rest.length === 1
          ? h("p", {}, rest[0])
          : h(
              "ul",
              {},
              rest.map((line) => h("li", {}, line)),
            ),
      )
      form.prepend(summary)
      summary.focus()
    } else {
      const first = fields.find((field) => byField[field.name])
      if (first)
        inputs(first.name)
          .find((input) => !input.matches("[type=radio]:not(:checked)"))
          ?.focus()
    }
  }

  function setPending(pending: boolean) {
    submit.disabled = pending
    submit.textContent = pending ? spec.pending : spec.submit
    if (pending) {
      form.setAttribute("aria-busy", "true")
      submit.setAttribute("data-pending", "")
    } else {
      form.removeAttribute("aria-busy")
      submit.removeAttribute("data-pending")
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    clear()
    const values = read()
    const missing = Object.fromEntries(
      fields
        .filter((field) => field.required && !values[field.name])
        .map((field) => [field.name, field.required as string]),
    )
    const wrong = { ...spec.check?.(values), ...missing }
    if (Object.keys(wrong).length > 0) return show(wrong, [])
    setPending(true)
    try {
      await busy(() => spec.run(values))
    } catch (error) {
      setPending(false)
      const { byField, rest } = sortProblems(error, fields, spec.place)
      show(byField, rest)
    }
  })

  return [
    spec.crumbs,
    h(
      `.mutation-surface${spec.danger ? ".is-danger" : ""}`,
      {},
      h("h1", { id: "surface-title", tabindex: "-1" }, spec.title),
      spec.lead && h("p.lead", {}, spec.lead),
      spec.note,
      spec.facts,
      form,
    ),
  ]
}
