/**
 * The fork's response validation (`modules/api/lib/validation.ts` → `validateBlockResponses`
 * in `packages/surveys/src/lib/validation/evaluator.ts`), trimmed to what our surveys use:
 * required elements, and the implicit email / url / phone rules of openText elements. When the
 * response is finished every element is checked (including ones logic would skip); when it is
 * not, only the elements present in `data`.
 */
import type { Survey } from "./state.js"

type Element = {
  id: string
  type?: string
  required?: boolean
  inputType?: string
  rows?: unknown[]
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

/** Every element of a survey: from `blocks[].elements`, else the legacy `questions[]`. */
export const surveyElements = (survey: Survey): Element[] => {
  const blocks = Array.isArray(survey.blocks) ? (survey.blocks as { elements?: unknown }[]) : []
  const fromBlocks = blocks.flatMap((b) =>
    Array.isArray(b.elements) ? (b.elements as Element[]) : [],
  )
  if (fromBlocks.length > 0) return fromBlocks
  return Array.isArray(survey.questions) ? (survey.questions as Element[]) : []
}

/** `{<elementId>: [messages]}`, or `null` when the response passes. */
export const validateResponseData = (
  survey: Survey,
  data: Record<string, unknown>,
  finished: boolean,
): Record<string, string[]> | null => {
  const all = surveyElements(survey)
  const elements = finished ? all : all.filter((e) => Object.keys(data).includes(e.id))
  const errors: Record<string, string[]> = {}
  for (const element of elements) {
    const value = data[element.id]
    const messages: string[] = []
    if (element.required) {
      if (element.type === "matrix") {
        const answered = value && typeof value === "object" ? Object.values(value) : []
        if (!answered.some((v) => !isEmpty(v))) messages.push("Please fill out this field")
      } else if (isEmpty(value)) {
        messages.push("Please fill out this field")
      }
    }
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
