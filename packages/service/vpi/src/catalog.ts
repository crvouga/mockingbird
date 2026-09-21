/**
 * The seed every namespace starts with: one clinic, one location, the authenticated clinic
 * user, two providers, a small product catalog in VPI's own field names, and one patient.
 * Synthesised in the shapes our client's zod contracts accept (no sandbox recording exists);
 * pass `seed` to `createRuntime` to replace any of it.
 */

/** The clinic user every authenticated account resolves to unless `accounts` names others. */
export const DEFAULT_USER_ID = "65a1c0de00000000000000a1"
export const DEFAULT_CLINIC_ID = "65a1c0de00000000000000c1"
export const DEFAULT_CLINIC_LOCATION_ID = "65a1c0de00000000000000d1"
export const DEFAULT_PROVIDER_ID = "65a1c0de00000000000000e1"
export const DEFAULT_PATIENT_ID = "65a1c0de00000000000000f1"

/** A product as VPI stores it; the list, details and discount endpoints project from it. */
export type Product = {
  /** Mongo id: what every endpoint (details, discounts, day supply, save) keys on. */
  id: string
  /** VPI catalog code, e.g. `2185_INJ`. */
  productId: string
  name: string
  unitPrice: number
  family: string
  subCategory1: string
  subCategory2: string
  commonName: string
  sigOptions: string[]
  productSize: string
  medicalAccessories: "0" | "1"
  coldShipped: "0" | "1"
  controlledSubstance: "0" | "1"
  dispenseType: string
  reasonForCompoundedMedication: string[] | null
  isReasonForCompoundedMedicationNeeded: boolean
  productType: "S" | "NS"
  patientPayAmount: number | null
  ndc: number | null
  /** The clinic's discount, in percent. */
  discountedPercentage: number
}

export type Provider = {
  id: string
  firstName: string
  lastName: string
  npi: string | null
  clinicLocationId: string
}

export type ClinicLocation = {
  id: string
  clinicId: string
  locationName: string
  email: string | null
  fax: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  zipcode: string | null
  state: string | null
}

export type PatientAddress = {
  id: string
  addressLine1: string
  addressLine2: string | null
  city: string
  state: string
  zipcode: string
}

/** A clinic patient; VPI patient creation is not captured by our client, so suites seed them. */
export type Patient = {
  id: string
  clinicId: string
  firstName: string
  lastName: string
  dateOfBirth: string
  email: string | null
  phoneNumber: string | null
  cellPhone: string | null
  addresses: PatientAddress[]
}

const REASONS = [
  "Product Discontinued - commercial product no longer available or in shortage",
  "Dosage Form Change - patient needs a different dosage form",
  "Different Strength - patient needs a strength not commercially available",
  "Excipient Allergy - patient is allergic to an inactive ingredient",
  "Other - reason not otherwise listed",
]

export const DEFAULT_PRODUCTS: readonly Product[] = [
  {
    id: "64f1c2a9e4b0a1b2c3d4e5f6",
    productId: "2185_INJ",
    name: "Testosterone Cypionate",
    unitPrice: 45.5,
    family: "Hormone Restoration",
    subCategory1: "Testosterone",
    subCategory2: "Injectables",
    commonName: "Testosterone Cypionate",
    sigOptions: ["Inject 0.5 mL intramuscularly once weekly"],
    productSize: "10mL",
    medicalAccessories: "0",
    coldShipped: "0",
    controlledSubstance: "0",
    dispenseType: "Vial",
    reasonForCompoundedMedication: REASONS,
    isReasonForCompoundedMedicationNeeded: true,
    productType: "S",
    patientPayAmount: 62.5,
    ndc: 12345678901,
    discountedPercentage: 10,
  },
  {
    id: "64f1c2a9e4b0a1b2c3d4e5f7",
    productId: "3097_POW",
    name: "Semaglutide / B6 Troche",
    unitPrice: 7.5,
    family: "Weight Management",
    subCategory1: "GLP-1",
    subCategory2: "Troches",
    commonName: "Semaglutide",
    sigOptions: ["Dissolve 1 troche under the tongue daily"],
    productSize: "30ea",
    medicalAccessories: "0",
    coldShipped: "1",
    controlledSubstance: "0",
    dispenseType: "Troche",
    reasonForCompoundedMedication: REASONS,
    isReasonForCompoundedMedicationNeeded: true,
    productType: "NS",
    patientPayAmount: 30,
    ndc: null,
    discountedPercentage: 0,
  },
  {
    id: "64f1c2a9e4b0a1b2c3d4e5f8",
    productId: "4410_CAP",
    name: "Enclomiphene Citrate 25 mg",
    unitPrice: 1.2,
    family: "Hormone Restoration",
    subCategory1: "Testosterone",
    subCategory2: "Capsules",
    commonName: "Enclomiphene",
    sigOptions: ["Take 1 capsule by mouth daily"],
    productSize: "30ea",
    medicalAccessories: "0",
    coldShipped: "0",
    controlledSubstance: "0",
    dispenseType: "Capsule",
    reasonForCompoundedMedication: null,
    isReasonForCompoundedMedicationNeeded: false,
    productType: "NS",
    patientPayAmount: 40,
    ndc: null,
    discountedPercentage: 5,
  },
  {
    id: "64f1c2a9e4b0a1b2c3d4e5f9",
    productId: "5120_INJ",
    name: "Nandrolone Decanoate",
    unitPrice: 55,
    family: "Hormone Restoration",
    subCategory1: "Testosterone",
    subCategory2: "Injectables",
    commonName: "Nandrolone",
    sigOptions: [],
    productSize: "5mL",
    medicalAccessories: "0",
    coldShipped: "0",
    controlledSubstance: "1",
    dispenseType: "Vial",
    reasonForCompoundedMedication: REASONS,
    isReasonForCompoundedMedicationNeeded: true,
    productType: "S",
    patientPayAmount: 80,
    ndc: null,
    discountedPercentage: 0,
  },
]

export const DEFAULT_CLINIC_LOCATION: ClinicLocation = {
  id: DEFAULT_CLINIC_LOCATION_ID,
  clinicId: DEFAULT_CLINIC_ID,
  locationName: "Geviti Main",
  email: "pharmacy@example.com",
  fax: "5555550100",
  addressLine1: "100 Clinic Way",
  addressLine2: null,
  city: "Phoenix",
  zipcode: "85004",
  state: "AZ",
}

export const DEFAULT_PROVIDERS: readonly Provider[] = [
  {
    id: DEFAULT_PROVIDER_ID,
    firstName: "Grace",
    lastName: "Hopper",
    npi: "1234567893",
    clinicLocationId: DEFAULT_CLINIC_LOCATION_ID,
  },
  {
    id: "65a1c0de00000000000000e2",
    firstName: "Alan",
    lastName: "Turing",
    npi: "1987654320",
    clinicLocationId: DEFAULT_CLINIC_LOCATION_ID,
  },
]

export const DEFAULT_PATIENTS: readonly Patient[] = [
  {
    id: DEFAULT_PATIENT_ID,
    clinicId: DEFAULT_CLINIC_ID,
    firstName: "Ada",
    lastName: "Lovelace",
    dateOfBirth: "1985-02-14",
    email: "ada@example.com",
    phoneNumber: "6025550142",
    cellPhone: null,
    addresses: [
      {
        id: "65a1c0de0000000000000af1",
        addressLine1: "1 Main St",
        addressLine2: null,
        city: "Phoenix",
        state: "AZ",
        zipcode: "85004",
      },
    ],
  },
]

/** Every state VPI ships to, by the full name its API uses (sterile shipping excluded in two). */
export const SHIPPING_STATES: readonly {
  name: string
  booleanCheck: boolean
  nonSterile: boolean
  sterile: boolean
}[] = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
  "District of Columbia",
].map((name) => ({
  name,
  booleanCheck: name !== "District of Columbia",
  nonSterile: true,
  sterile: name !== "Alabama" && name !== "District of Columbia",
}))

/** Full state name ↔ 2-letter code, for the canonical-name checks and the shipping-rate lookup. */
export const STATE_CODES: Readonly<Record<string, string>> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
  "District of Columbia": "DC",
  "American Samoa": "AS",
  Guam: "GU",
  "Northern Mariana Islands": "MP",
  "Puerto Rico": "PR",
  "U.S. Virgin Islands": "VI",
}
