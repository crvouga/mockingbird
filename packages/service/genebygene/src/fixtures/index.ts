import { ANCESTRY_REPORT, NORMAL_REPORT, PGX_REPORT, RAW_DATA_CSV } from "./reports.js"

export { ANCESTRY_REPORT, NORMAL_REPORT, PGX_REPORT, RAW_DATA_CSV } from "./reports.js"

/** Named result fixtures `POST /__admin/kits/:kitNumber/transition {"to": "Completed", "fixture"}` takes. */
export const RESULT_FIXTURES = ["normal", "pgx", "ancestry"] as const
export type ResultFixture = (typeof RESULT_FIXTURES)[number]

/** A custom payload from `PUT /__admin/results/:kitNumber`. */
export type CustomResults = {
  /** The JSON report (any JSON value). */
  json?: unknown
  /** The raw-data CSV text. */
  csv?: string
  /** The PDF, base64. Default: a generated one-page PDF. */
  pdfBase64?: string
}

/** One published result file. `resultType` / `resultTypeName` match the recorded `Kit.Completed` samples. */
export type ResultFile = {
  resultType: string
  resultTypeName: string
  extension: "json" | "pdf" | "csv"
  contentType: string
  bytes: Uint8Array
}

const encoder = new TextEncoder()

/** A valid one-page PDF showing `lines` (xref offsets computed, so strict readers accept it). */
export const minimalPdf = (lines: readonly string[]): Uint8Array => {
  const escapeText = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`)
  const stream = [
    "BT /F1 14 Tf 72 720 Td 18 TL",
    ...lines.map((line) => `(${escapeText(line)}) Tj T*`),
    "ET",
  ].join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return encoder.encode(body)
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

const reportFor = (fixture: ResultFixture): Record<string, unknown> =>
  fixture === "pgx" ? PGX_REPORT : fixture === "ancestry" ? ANCESTRY_REPORT : NORMAL_REPORT

/**
 * The files a completed kit publishes: the comprehensive JSON report, its PDF, and the raw-data
 * CSV. The JSON's `barcode` / `lab_identifier` are the kit number, as the vendor's are.
 */
export const resultFiles = (
  kitNumber: string,
  source: { fixture: ResultFixture } | { custom: CustomResults },
  reportDate: string,
): ResultFile[] => {
  const custom = "custom" in source ? source.custom : undefined
  const report =
    custom?.json !== undefined
      ? custom.json
      : {
          ...reportFor("fixture" in source ? source.fixture : "normal"),
          barcode: kitNumber,
          lab_identifier: kitNumber,
          report_date: reportDate,
        }
  const name = "fixture" in source ? source.fixture : "custom"
  return [
    {
      resultType: "nutrigenomics_comprehensive_report_json",
      resultTypeName: "Comprehensive JSON Report",
      extension: "json",
      contentType: "application/json",
      bytes: encoder.encode(JSON.stringify(report)),
    },
    {
      resultType: "nutrigenomics_comprehensive_report_pdf",
      resultTypeName: "Comprehensive PDF Report",
      extension: "pdf",
      contentType: "application/pdf",
      bytes: custom?.pdfBase64
        ? fromBase64(custom.pdfBase64)
        : minimalPdf([
            "Gene by Gene - Comprehensive Wellness Report",
            `Kit ${kitNumber}`,
            `Report date ${reportDate}`,
            `Fixture: ${name} (Mockingbird)`,
          ]),
    },
    {
      resultType: "nt_custom_agena_panel_data",
      resultTypeName: "NT Custom Agena Data File",
      extension: "csv",
      contentType: "text/csv",
      bytes: encoder.encode(custom?.csv ?? RAW_DATA_CSV),
    },
  ]
}
