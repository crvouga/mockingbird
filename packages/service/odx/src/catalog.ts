/**
 * The partner labs and biomarker elements ODX answers from `/v1/partner/labs` and
 * `/v1/elements/{labId}`. Element ids are the ones our QA harness and backend rely on
 * (`packages/qa/src/world/http/odx-client.ts` PHENO_AGE_*: the nine phenotypic-age inputs our
 * biological-age service requires by name), mapped from the lab's LOINC codes so an HL7 OBX-3
 * of `1751-7^Albumin` imports as element 506. No live recording exists (the vendor is retired);
 * names, units and ranges follow ODX's conventional-US defaults.
 */

export type OdxLab = { labId: number; name: string; isCurrentLab: boolean }

export type ElementDef = {
  elementId: number
  elementName: string
  elementGenderType: "Both" | "Male" | "Female"
  cuUnit: string
  siUnit: string
  cuToSiConversionFactor: number
  /** LOINC / lab codes an HL7 OBX-3 may carry for this element. */
  codes: string[]
  optimal: [number, number]
  standard: [number, number]
}

export const LABS: readonly OdxLab[] = [
  { labId: 1, name: "Access Health Alliance (AHA)", isCurrentLab: true },
  { labId: 2, name: "Quest Diagnostics", isCurrentLab: false },
  { labId: 3, name: "LabCorp", isCurrentLab: false },
]

export const ELEMENTS: readonly ElementDef[] = [
  {
    elementId: 460,
    elementName: "Total Cholesterol",
    elementGenderType: "Both",
    cuUnit: "mg/dL",
    siUnit: "mmol/L",
    cuToSiConversionFactor: 0.0259,
    codes: ["2093-3"],
    optimal: [160, 199],
    standard: [125, 199],
  },
  {
    elementId: 494,
    elementName: "Glucose Fasting",
    elementGenderType: "Both",
    cuUnit: "mg/dL",
    siUnit: "mmol/L",
    cuToSiConversionFactor: 0.0555,
    codes: ["2345-7", "1558-6"],
    optimal: [75, 86],
    standard: [65, 99],
  },
  {
    elementId: 496,
    elementName: "Creatinine",
    elementGenderType: "Both",
    cuUnit: "mg/dL",
    siUnit: "µmol/L",
    cuToSiConversionFactor: 88.4,
    codes: ["2160-0"],
    optimal: [0.8, 1.1],
    standard: [0.6, 1.3],
  },
  {
    elementId: 506,
    elementName: "Albumin",
    elementGenderType: "Both",
    cuUnit: "g/dL",
    siUnit: "g/L",
    cuToSiConversionFactor: 10,
    codes: ["1751-7"],
    optimal: [4, 5],
    standard: [3.5, 5.5],
  },
  {
    elementId: 511,
    elementName: "Alk Phos",
    elementGenderType: "Both",
    cuUnit: "U/L",
    siUnit: "U/L",
    cuToSiConversionFactor: 1,
    codes: ["6768-6"],
    optimal: [70, 100],
    standard: [40, 129],
  },
  {
    elementId: 537,
    elementName: "Hs CRP - Male",
    elementGenderType: "Male",
    cuUnit: "mg/L",
    siUnit: "mg/L",
    cuToSiConversionFactor: 1,
    codes: ["30522-7"],
    optimal: [0, 0.55],
    standard: [0, 3],
  },
  {
    elementId: 538,
    elementName: "Hs CRP - Female",
    elementGenderType: "Female",
    cuUnit: "mg/L",
    siUnit: "mg/L",
    cuToSiConversionFactor: 1,
    codes: ["30522-7"],
    optimal: [0, 1.5],
    standard: [0, 3],
  },
  {
    elementId: 556,
    elementName: "Total WBCs",
    elementGenderType: "Both",
    cuUnit: "k/cumm",
    siUnit: "10E9/L",
    cuToSiConversionFactor: 1,
    codes: ["6690-2"],
    optimal: [5, 8],
    standard: [3.8, 10.8],
  },
  {
    elementId: 564,
    elementName: "MCV",
    elementGenderType: "Both",
    cuUnit: "fL",
    siUnit: "fL",
    cuToSiConversionFactor: 1,
    codes: ["787-2"],
    optimal: [82, 89.9],
    standard: [80, 100],
  },
  {
    elementId: 568,
    elementName: "RDW",
    elementGenderType: "Both",
    cuUnit: "%",
    siUnit: "%",
    cuToSiConversionFactor: 1,
    codes: ["788-0"],
    optimal: [11.7, 13],
    standard: [11, 15],
  },
  {
    elementId: 571,
    elementName: "Lymphocytes - %",
    elementGenderType: "Both",
    cuUnit: "%",
    siUnit: "%",
    cuToSiConversionFactor: 1,
    codes: ["736-9"],
    optimal: [25, 40],
    standard: [20, 40],
  },
  {
    elementId: 580,
    elementName: "Testosterone Total - Male",
    elementGenderType: "Male",
    cuUnit: "ng/dL",
    siUnit: "nmol/L",
    cuToSiConversionFactor: 0.0347,
    codes: ["2986-8"],
    optimal: [600, 900],
    standard: [250, 1100],
  },
  {
    elementId: 590,
    elementName: "TSH",
    elementGenderType: "Both",
    cuUnit: "µIU/mL",
    siUnit: "mIU/L",
    cuToSiConversionFactor: 1,
    codes: ["3016-3", "11580-8"],
    optimal: [1, 2],
    standard: [0.4, 4.5],
  },
]

/** The `/v1/elements/{labId}` row for one element. */
export const labElement = (labId: number, element: ElementDef) => ({
  labId,
  elementId: element.elementId,
  elementName: element.elementName,
  elementGenderType: element.elementGenderType,
  cuUnit: element.cuUnit,
  siUnit: element.siUnit,
  cuToSiConversionFactor: element.cuToSiConversionFactor,
  elementReferences: element.codes.map((code) => ({
    elementCode: code,
    elementName: element.elementName,
  })),
})
