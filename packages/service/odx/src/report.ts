import { LABS } from "./catalog.js"
import { band, type ResultElement } from "./results.js"
import type { PatientTestRecord } from "./state.js"

const RECIPIENTS: Record<string, string> = {
  "15": "Patient (Geviti)",
  "16": "Practitioner (Geviti)",
  "1": "Patient",
  "2": "Practitioner",
}

const describe = (r: ResultElement) =>
  `${r.elementName} ${r.elementValue} ${r.unit} is outside the optimal range ${r.optimalRangeLow}-${r.optimalRangeHigh}`

/**
 * The Functional Health Report as `outputType: Json` returns it, with the sections our
 * storeHealthData reads (groups, aboveOptimal/belowOptimal, "Functional Body Systems"
 * conditions, health concerns). Conditions are derived deterministically from which results
 * fall outside their optimal range; no clinical logic is modelled.
 */
export const jsonReport = (
  test: PatientTestRecord,
  request: { reports?: unknown; recipientId?: unknown; unitType?: unknown },
) => {
  const results = test.results
  const outside = results.filter((r) => band(r) !== "optimal")
  const above = results.filter((r) => ["aboveOptimal", "high"].includes(band(r)))
  const below = results.filter((r) => ["belowOptimal", "low"].includes(band(r)))
  const lab = LABS.find((l) => l.labId === test.labId) ?? {
    labId: test.labId,
    name: `Lab ${test.labId}`,
    isCurrentLab: false,
  }
  const alarm = (r: ResultElement) => band(r) === "low" || band(r) === "high"
  const rationale = (r: ResultElement) => ({
    elementId: r.elementId,
    status: ["aboveOptimal", "high"].includes(band(r)) ? "Above Optimal" : "Below Optimal",
  })
  const probability = results.length === 0 ? 0 : Math.round((outside.length / results.length) * 100)
  return {
    metadata: {
      practiceId: test.practiceId,
      patientId: test.patientId,
      patientTestId: test.patientTestId,
      recipient: RECIPIENTS[String(request.recipientId ?? "")] ?? "0",
      reports: Array.isArray(request.reports) ? request.reports.map(String) : [],
      unitType: typeof request.unitType === "string" ? request.unitType : test.unitType,
    },
    labs: [lab],
    elements: results,
    sections: [
      {
        name: "Blood Test Results",
        reports: [
          {
            reportId: 1,
            name: "Blood Test Results",
            content: {
              tests: [{ labId: String(test.labId), testDate: test.testDate }],
              groups: [
                {
                  name: "Results",
                  results: results.map((r) => ({
                    elementId: r.elementId,
                    values: [{ comparison: r.comparison, value: r.elementValue, alarm: alarm(r) }],
                  })),
                },
              ],
              aboveOptimal: above.map((r) => ({
                elementId: r.elementId,
                value: r.elementValue,
                alarm: alarm(r),
                description: describe(r),
              })),
              belowOptimal: below.map((r) => ({
                elementId: r.elementId,
                value: r.elementValue,
                alarm: alarm(r),
                description: describe(r),
              })),
            },
          },
        ],
      },
      {
        name: "Functional Health",
        reports: [
          {
            reportId: 2,
            name: "Functional Body Systems",
            content: {
              conditions: [
                {
                  conditionId: 1,
                  name: "Overall Functional Health",
                  probabilityOfDysfunction: probability,
                  description: null,
                  rationales: outside.map(rationale),
                  elementIdsConsidered: results.map((r) => r.elementId),
                  elementIdsMissing: [],
                },
              ],
            },
          },
          {
            reportId: 3,
            name: "Health Concerns",
            content: {
              healthConcerns: outside.length
                ? [
                    {
                      healthConcernId: 1,
                      name: "Biomarkers outside optimal range",
                      description: `${outside.length} of ${results.length} results are outside their optimal range.`,
                      needOfSupportProbability: probability,
                      rationales: outside.map(rationale),
                    },
                  ]
                : [],
            },
          },
        ],
      },
    ],
  }
}

/** A small, valid single-page PDF (correct xref offsets) naming the test it reports on. */
export const pdfReport = (test: PatientTestRecord): Uint8Array => {
  const text =
    `Functional Health Report - patient test ${test.patientTestId} (${test.results.length} results)`.replace(
      /[()\\]/g,
      "",
    )
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}
