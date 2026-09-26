import { ELEMENTS, type ElementDef } from "./catalog.js"

/** One result as ODX returns it (`OdxElement` in our consumer). */
export type ResultElement = {
  elementValue: number
  /** `""` for an exact value, `<` / `>` (or `<=` / `>=`) for a bound. Never null. */
  comparison: string
  unit: string
  elementId: number
  elementName: string
  optimalRangeLow: number
  optimalRangeHigh: number
  standardRangeLow: number
  standardRangeHigh: number
}

export type ImportLog = {
  observationIdentifier: string | null
  observationIdentifierText: string | null
  status: string | null
}

export type Imported = { results: ResultElement[]; importLogs: ImportLog[] }

/** One HL7 v2 OBX segment, reduced to what an import reads. PID/NTE are never kept. */
export type Observation = {
  code: string
  text: string
  value: string
  units: string
  range: string
}

/**
 * The OBX segments of an HL7 v2 message (segments split on CR or LF, fields on `|`,
 * components on `^`): OBX-3 identifier `code^text`, OBX-5 value, OBX-6 units, OBX-7 range.
 * Returns `undefined` when the text is not an HL7 message (no MSH header).
 */
export const parseObservations = (hl7: string): Observation[] | undefined => {
  const segments = hl7.split(/\r\n|\r|\n/).filter((s) => s.trim() !== "")
  if (!segments[0]?.startsWith("MSH|")) return undefined
  return segments
    .filter((segment) => segment.startsWith("OBX|"))
    .map((segment) => {
      const fields = segment.split("|")
      const [code = "", text = ""] = (fields[3] ?? "").split("^")
      return {
        code: code.trim(),
        text: text.trim(),
        value: (fields[5] ?? "").trim(),
        units: (fields[6] ?? "").trim(),
        range: (fields[7] ?? "").trim(),
      }
    })
}

const VALUE = /^(<=|>=|<|>)?\s*(-?\d+(?:\.\d+)?)$/

/** Pick the element an observation maps to: by lab code, `EL<id>`, or name; gendered by the patient. */
export const matchElement = (
  code: string,
  text: string,
  gender: string,
): ElementDef | undefined => {
  const byCode = ELEMENTS.filter(
    (e) =>
      e.codes.some((c) => c.toLowerCase() === code.toLowerCase()) ||
      `EL${e.elementId}` === code.toUpperCase(),
  )
  const candidates =
    byCode.length > 0
      ? byCode
      : ELEMENTS.filter((e) => e.elementName.toLowerCase() === text.toLowerCase())
  if (candidates.length <= 1) return candidates[0]
  const sex = gender.toLowerCase() === "female" ? "Female" : "Male"
  return candidates.find((e) => e.elementGenderType === sex) ?? candidates[0]
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** The result row for `value` of `element`, in the test's unit system. */
export const resultFor = (
  element: ElementDef,
  value: number,
  comparison: string,
  unitType: string,
): ResultElement => {
  const si = unitType.toUpperCase() === "SI"
  const k = si ? element.cuToSiConversionFactor : 1
  return {
    elementValue: value,
    comparison,
    unit: si ? element.siUnit : element.cuUnit,
    elementId: element.elementId,
    elementName: element.elementName,
    optimalRangeLow: round(element.optimal[0] * k),
    optimalRangeHigh: round(element.optimal[1] * k),
    standardRangeLow: round(element.standard[0] * k),
    standardRangeHigh: round(element.standard[1] * k),
  }
}

/** Import HL7 observations: mapped numeric values become results; everything else is logged. */
export const importObservations = (
  observations: Observation[],
  gender: string,
  unitType: string,
): Imported => {
  const results: ResultElement[] = []
  const importLogs: ImportLog[] = []
  for (const obs of observations) {
    const log = (status: string) =>
      importLogs.push({
        observationIdentifier: obs.code || null,
        observationIdentifierText: obs.text || null,
        status,
      })
    const element = matchElement(obs.code, obs.text, gender)
    if (!element) {
      log("NotMapped")
      continue
    }
    const parsed = VALUE.exec(obs.value)
    if (!parsed) {
      log("InvalidValue")
      continue
    }
    results.push(resultFor(element, Number(parsed[2]), parsed[1] ?? "", unitType))
    log("Imported")
  }
  return { results, importLogs }
}

/** Where a value sits against the element's ranges. */
export const band = (
  r: ResultElement,
): "low" | "belowOptimal" | "optimal" | "aboveOptimal" | "high" => {
  if (r.elementValue < r.standardRangeLow) return "low"
  if (r.elementValue > r.standardRangeHigh) return "high"
  if (r.elementValue < r.optimalRangeLow) return "belowOptimal"
  if (r.elementValue > r.optimalRangeHigh) return "aboveOptimal"
  return "optimal"
}
