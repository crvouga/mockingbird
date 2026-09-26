/**
 * Formbricks' response validation (`validateResponseData` in `apps/web/modules/api/lib/validation.ts`
 * → `validateBlockResponses` in `packages/surveys/src/lib/validation/evaluator.ts`), trimmed to the
 * structural checks: required elements, choice membership for choice elements without an "other"
 * option, and the implicit email / url / phone rules of openText elements. Only the elements
 * present in `data` are checked, finished or not (upstream never checks absent elements).
 * Custom `validation.rules` are not evaluated.
 */
import type { Survey } from "./state.js"

type Element = {
  id: string
  type?: string
  required?: boolean
  inputType?: string
  rows?: unknown[]
  choices?: { id: string; label?: { default?: string } & Record<string, string> }[]
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)

const EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const PHONE = /^[\d+][\d+\- ]*\d$/
const validUrl = (value: string) => {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

const REQUIRED = "Please fill out this field"
const INVALID_FORMAT = "Please enter a valid format"

/** Every element of a survey: from `blocks[].elements`, else the legacy `questions[]`. */
export const surveyElements = (survey: Survey): Element[] => {
  const blocks = Array.isArray(survey.blocks) ? (survey.blocks as { elements?: unknown }[]) : []
  const fromBlocks = blocks.flatMap((b) =>
    b && Array.isArray(b.elements) ? (b.elements as Element[]) : [],
  )
  const elements =
    fromBlocks.length > 0
      ? fromBlocks
      : Array.isArray(survey.questions)
        ? (survey.questions as Element[])
        : []
  return elements.filter((e) => typeof e === "object" && e !== null)
}

const requiredError = (element: Element, value: unknown): boolean => {
  if (!element.required || element.type === "cta") return false
  if (element.type === "ranking") return !Array.isArray(value) || value.length < 1
  if (element.type === "matrix") {
    if (isEmpty(value)) return true
    if (typeof value === "object" && value !== null && !Array.isArray(value) && element.rows) {
      return !Object.values(value).some((v) => v !== "" && v !== null && v !== undefined)
    }
    return false
  }
  return isEmpty(value)
}

/** `validateChoiceMembership`: a choice element without "other" only takes its choice ids / labels. */
const invalidOption = (element: Element, value: unknown, language: string): boolean => {
  if (element.type !== "multipleChoiceSingle" && element.type !== "multipleChoiceMulti")
    return false
  if (!Array.isArray(element.choices)) return false
  if (element.choices.some((c) => c.id === "other") || isEmpty(value)) return false
  const known = new Set<string>()
  for (const choice of element.choices) {
    known.add(choice.id)
    const label = choice.label?.[language] ?? choice.label?.default
    if (label) known.add(label)
  }
  const submitted = Array.isArray(value) ? value : [value]
  return submitted.some((v) => v !== "" && (typeof v !== "string" || !known.has(v)))
}

/** `{<elementId>: [messages]}`, or `null` when the response passes. */
export const validateResponseData = (
  survey: Survey,
  data: Record<string, unknown>,
  language = "en",
): Record<string, string[]> | null => {
  const present = surveyElements(survey).filter((e) => Object.keys(data).includes(e.id))
  const errors: Record<string, string[]> = {}
  for (const element of present) {
    const value = data[element.id]
    const messages: string[] = []
    if (requiredError(element, value)) messages.push(REQUIRED)
    if (invalidOption(element, value, language)) messages.push(INVALID_FORMAT)
    if (element.type === "openText" && typeof value === "string" && value !== "") {
      if (element.inputType === "email" && !EMAIL.test(value)) {
        messages.push("Please enter a valid email address")
      } else if (element.inputType === "url" && !validUrl(value)) {
        messages.push("Please enter a valid URL")
      } else if (element.inputType === "phone" && !PHONE.test(value)) {
        messages.push("Please enter a valid phone number")
      }
    }
    if (messages.length > 0) errors[element.id] = messages
  }
  return Object.keys(errors).length === 0 ? null : errors
}
