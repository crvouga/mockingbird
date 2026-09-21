/**
 * Verbatim port of our backend's VPI contracts (`apps/backend/src/modules/erx/clients/vpi-api.contracts.ts`)
 * plus the client-local schemas from `vpi-api.client.ts`. The consumer oracle parses every mock
 * response with these, exactly as the backend does, so a drifted mock fails closed the same way.
 * Only the non-null assertions were rewritten (as casts) for this repo's lint rules.
 */
import { z } from "zod"

export const vpiRequiredStringSchema = z.string().trim().min(1)
export const vpiBinaryStringSchema = z.enum(["0", "1"])
const vpiMoneySchema = z.number().finite().nonnegative()
const vpiPositiveIntegerSchema = z.number().int().positive()
const vpiNonnegativeIntegerSchema = z.number().int().nonnegative()
const vpiObjectSchema = z.record(z.string(), z.unknown())

function vpiBlankToUndefined(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  return undefined
}

const vpiOptionalContactStringSchema = z.preprocess(vpiBlankToUndefined, z.string().optional())
const vpiOptionalIdentityStringSchema = z.preprocess(
  vpiBlankToUndefined,
  vpiRequiredStringSchema.optional(),
)

const vpiOptionalEmailSchema = vpiOptionalContactStringSchema.transform((value) =>
  value !== undefined && z.string().email().safeParse(value).success ? value : undefined,
)

export const VPI_STATE_CANONICAL_ENTRIES: ReadonlyArray<readonly [name: string, code: string]> = [
  ["Alabama", "AL"],
  ["Alaska", "AK"],
  ["Arizona", "AZ"],
  ["Arkansas", "AR"],
  ["California", "CA"],
  ["Colorado", "CO"],
  ["Connecticut", "CT"],
  ["Delaware", "DE"],
  ["Florida", "FL"],
  ["Georgia", "GA"],
  ["Hawaii", "HI"],
  ["Idaho", "ID"],
  ["Illinois", "IL"],
  ["Indiana", "IN"],
  ["Iowa", "IA"],
  ["Kansas", "KS"],
  ["Kentucky", "KY"],
  ["Louisiana", "LA"],
  ["Maine", "ME"],
  ["Maryland", "MD"],
  ["Massachusetts", "MA"],
  ["Michigan", "MI"],
  ["Minnesota", "MN"],
  ["Mississippi", "MS"],
  ["Missouri", "MO"],
  ["Montana", "MT"],
  ["Nebraska", "NE"],
  ["Nevada", "NV"],
  ["New Hampshire", "NH"],
  ["New Jersey", "NJ"],
  ["New Mexico", "NM"],
  ["New York", "NY"],
  ["North Carolina", "NC"],
  ["North Dakota", "ND"],
  ["Ohio", "OH"],
  ["Oklahoma", "OK"],
  ["Oregon", "OR"],
  ["Pennsylvania", "PA"],
  ["Rhode Island", "RI"],
  ["South Carolina", "SC"],
  ["South Dakota", "SD"],
  ["Tennessee", "TN"],
  ["Texas", "TX"],
  ["Utah", "UT"],
  ["Vermont", "VT"],
  ["Virginia", "VA"],
  ["Washington", "WA"],
  ["West Virginia", "WV"],
  ["Wisconsin", "WI"],
  ["Wyoming", "WY"],
  ["District of Columbia", "DC"],
  ["American Samoa", "AS"],
  ["Guam", "GU"],
  ["Northern Mariana Islands", "MP"],
  ["Puerto Rico", "PR"],
  ["U.S. Virgin Islands", "VI"],
]

const VPI_STATE_NAME_ALIASES: ReadonlyArray<readonly [name: string, code: string]> = [
  ["Washington DC", "DC"],
  ["Washington, D.C.", "DC"],
  ["Virgin Islands", "VI"],
  ["US Virgin Islands", "VI"],
]

const VPI_STATE_NAME_TO_CODE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    [...VPI_STATE_CANONICAL_ENTRIES, ...VPI_STATE_NAME_ALIASES].map(([name, code]) => [
      name.toUpperCase(),
      code,
    ]),
  ),
)

const VPI_STATE_CODE_TO_NAME: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(VPI_STATE_CANONICAL_ENTRIES.map(([name, code]) => [code, name])),
)

export function normalizeVpiStateToCode(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  const upper = trimmed.toUpperCase()
  if (/^[A-Z]{2}$/.test(upper)) {
    return VPI_STATE_CODE_TO_NAME[upper] !== undefined ? upper : null
  }
  const lookupKey = upper.replace(/\s+/g, " ")
  return VPI_STATE_NAME_TO_CODE[lookupKey] ?? null
}

export function denormalizeVpiStateCodeToName(code: string): string | null {
  const trimmed = code.trim().toUpperCase()
  if (trimmed.length === 0) {
    return null
  }
  return VPI_STATE_CODE_TO_NAME[trimmed] ?? null
}

export const vpiPatientSchema = z
  .object({
    id: vpiOptionalIdentityStringSchema,
    patientId: vpiOptionalIdentityStringSchema,
    firstName: vpiRequiredStringSchema,
    lastName: vpiRequiredStringSchema,
    dob: vpiOptionalIdentityStringSchema,
    dateOfBirth: vpiOptionalIdentityStringSchema,
    email: vpiOptionalEmailSchema,
    phone: vpiOptionalContactStringSchema,
    phoneNumber: vpiOptionalContactStringSchema,
    cellPhone: vpiOptionalContactStringSchema,
  })
  .superRefine((value, context) => {
    if (!value.id && !value.patientId) {
      context.addIssue({ code: "custom", message: "patient id is required" })
    }
    if (!value.dob && !value.dateOfBirth) {
      context.addIssue({ code: "custom", message: "patient date of birth is required" })
    }
  })
  .transform((value) => ({
    id: value.id ?? (value.patientId as string),
    firstName: value.firstName,
    lastName: value.lastName,
    dob: value.dob ?? (value.dateOfBirth as string),
    email: value.email,
    phone: value.phoneNumber ?? value.phone ?? value.cellPhone,
  }))

export const vpiAddressSchema = z
  .object({
    id: vpiRequiredStringSchema.optional(),
    addressId: vpiRequiredStringSchema.optional(),
    addressLine1: vpiRequiredStringSchema,
    addressLine2: z.string().trim().nullable().optional(),
    city: vpiRequiredStringSchema,
    state: vpiRequiredStringSchema,
    zipcode: vpiRequiredStringSchema.optional(),
    postalCode: vpiRequiredStringSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.zipcode && !value.postalCode) {
      context.addIssue({ code: "custom", message: "postal code is required" })
    }
    if (normalizeVpiStateToCode(value.state) === null) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "state is not a recognised US state, DC, or territory",
      })
    }
  })
  .transform((value) => ({
    id: value.id ?? value.addressId ?? null,
    addressLine1: value.addressLine1,
    addressLine2: value.addressLine2 ?? null,
    city: value.city,
    state: normalizeVpiStateToCode(value.state) as string,
    zipcode: value.zipcode ?? (value.postalCode as string),
  }))

export const vpiProviderSchema = z
  .object({
    id: vpiRequiredStringSchema,
    firstName: vpiRequiredStringSchema,
    lastName: vpiRequiredStringSchema,
    npi: z.string().trim().nullable().optional(),
  })
  .transform((value) => ({
    id: value.id,
    firstName: value.firstName,
    lastName: value.lastName,
    npi: value.npi || null,
  }))

export const vpiClinicLocationSchema = z
  .object({
    id: vpiRequiredStringSchema,
    clinicId: vpiRequiredStringSchema,
    locationName: vpiRequiredStringSchema,
    email: z.string().trim().nullable().optional(),
    fax: z.string().trim().nullable().optional(),
    addressLine1: z.string().trim().nullable().optional(),
    addressLine2: z.string().trim().nullable().optional(),
    city: z.string().trim().nullable().optional(),
    zipcode: z.string().trim().nullable().optional(),
    state: z.string().trim().nullable().optional(),
  })
  .transform((value) => ({
    id: value.id,
    clinicId: value.clinicId,
    name: value.locationName,
    email: value.email ?? null,
    fax: value.fax ?? null,
    addressLine1: value.addressLine1 ?? null,
    addressLine2: value.addressLine2 ?? null,
    city: value.city ?? null,
    zipcode: value.zipcode ?? null,
    state: value.state ?? null,
  }))

export const vpiProductDetailsSchema = z.object({
  id: vpiRequiredStringSchema,
  productId: vpiRequiredStringSchema,
  name: vpiRequiredStringSchema,
  unitPrice: vpiMoneySchema,
  family: vpiRequiredStringSchema,
  subCategory1: vpiRequiredStringSchema,
  subCategory2: vpiRequiredStringSchema,
  commonName: vpiRequiredStringSchema,
  sigOptions: z.array(z.union([vpiRequiredStringSchema, vpiObjectSchema])),
  productSize: vpiRequiredStringSchema,
  medicalAccessories: z.union([vpiBinaryStringSchema, z.array(vpiObjectSchema)]),
  coldShipped: vpiBinaryStringSchema,
  controlledSubstance: vpiBinaryStringSchema,
  dispenseType: vpiRequiredStringSchema,
  reasonForCompoundedMedication: z.array(vpiRequiredStringSchema).nullable().optional(),
  isReasonForCompoundedMedicationNeeded: z.boolean(),
  productType: z.enum(["S", "NS"]),
  patientPayAmount: vpiMoneySchema.nullable().optional(),
  ndc: z.number().nullable().optional(),
})

export const vpiProductDiscountSchema = z.object({
  id: vpiRequiredStringSchema,
  productId: vpiRequiredStringSchema,
  discountedPrice: vpiMoneySchema,
  unitPrice: vpiMoneySchema.optional(),
  discountedPercentage: z.number().finite().min(0).max(100),
  controlledSubstance: z.union([vpiBinaryStringSchema, z.boolean()]).optional(),
})

export const vpiProviderSignatureCheckSchema = z.object({
  isDuplicate: z.boolean(),
  isProviderSignatureNeeded: z.boolean(),
})

export const vpiSavePrescriptionResponseSchema = z.object({
  message: vpiRequiredStringSchema,
  prescriptionId: vpiRequiredStringSchema,
  isRefillRequest: z.boolean(),
  refillFromPrescriptionId: z.string().trim().nullable(),
})

export const vpiPrescriptionStatusSchema = z
  .object({
    prescriptionId: vpiRequiredStringSchema.optional(),
    id: vpiRequiredStringSchema.optional(),
    prescriptionStatus: vpiRequiredStringSchema,
    trackingNumber: z.string().trim().nullable().optional(),
  })
  .superRefine((value, context) => {
    if (!value.prescriptionId && !value.id) {
      context.addIssue({ code: "custom", message: "prescription id is required" })
    }
  })
  .transform((value) => ({
    prescriptionId: value.prescriptionId ?? (value.id as string),
    prescriptionStatus: value.prescriptionStatus,
    trackingNumber: value.trackingNumber ?? null,
  }))

export const vpiDaySupplyResponseSchema = z.object({
  daySupply: vpiPositiveIntegerSchema,
  daySupplyReason: z.string().trim().nullable().optional(),
})

export const vpiShippingRateResponseSchema = z.object({
  shippingMethod: vpiRequiredStringSchema,
  rushOrderCost: vpiMoneySchema,
  rushOrderMethod: z.string().trim(),
  isSignatureRequired: z.boolean(),
})

export const vpiProviderSignatureCheckInputSchema = z.object({
  clinicId: vpiRequiredStringSchema,
  patientIds: z.array(vpiRequiredStringSchema).min(1),
  productIds: z.array(vpiRequiredStringSchema).min(1),
  clinicLocationIds: z.array(vpiRequiredStringSchema).min(1),
})

export const vpiSavePrescriptionProductSchema = z.object({
  id: vpiRequiredStringSchema,
  productId: vpiRequiredStringSchema,
  name: vpiRequiredStringSchema,
  unitPrice: vpiMoneySchema,
  family: vpiRequiredStringSchema,
  subCategory1: vpiRequiredStringSchema,
  subCategory2: vpiRequiredStringSchema,
  commonName: vpiRequiredStringSchema,
  sigOptions: z.array(z.union([vpiRequiredStringSchema, vpiObjectSchema])),
  productSize: vpiRequiredStringSchema,
  medicalAccessories: z.array(vpiObjectSchema),
  coldShipped: vpiBinaryStringSchema,
  controlledSubstance: z.literal("0"),
  dispenseType: vpiRequiredStringSchema,
  reasonForCompoundedMedication: z.string().trim(),
  isReasonForCompoundedMedicationNeeded: z.boolean(),
  productType: z.enum(["S", "NS"]),
  patientPay: vpiMoneySchema,
  ndc: z.string().trim(),
  quantity: z.number().finite().positive(),
  sig: vpiRequiredStringSchema,
  daySupply: vpiPositiveIntegerSchema,
  daySupplyReason: z.string().trim(),
  refills: vpiNonnegativeIntegerSchema,
  isCustomSig: z.boolean(),
  discountedPercentage: z.number().finite().min(0).max(100),
  discountedPrice: vpiMoneySchema,
  displayedGeneratedSig: vpiRequiredStringSchema,
})

export const vpiSavePrescriptionPayloadSchema = z.object({
  patientIds: z.array(vpiRequiredStringSchema).min(1),
  clinicLocationId: vpiRequiredStringSchema,
  providerId: vpiRequiredStringSchema,
  clinicId: vpiRequiredStringSchema,
  userId: vpiRequiredStringSchema,
  products: z.array(vpiSavePrescriptionProductSchema).min(1),
  rxPadProducts: z.array(vpiObjectSchema),
  shippingInfo: z.object({
    isRushOrder: z.boolean(),
    isSignatureRequired: z.boolean(),
    orderNotes: z.string(),
    shipTo: vpiRequiredStringSchema,
    isNewAddressUsed: z.boolean(),
    shippingMethod: vpiRequiredStringSchema,
    shippingAddress: z.object({
      addressLine1: vpiRequiredStringSchema,
      addressLine2: z.string(),
      city: vpiRequiredStringSchema,
      state: vpiRequiredStringSchema.refine(
        (value) =>
          denormalizeVpiStateCodeToName(normalizeVpiStateToCode(value) ?? "") === value.trim(),
        { message: "state must be a canonical full US state, DC, or territory name" },
      ),
      zipcode: vpiRequiredStringSchema,
    }),
    rushOrderCost: vpiMoneySchema,
    rushOrderMethod: z.string(),
  }),
  creditRequested: z.boolean().optional(),
  encryptedBillingInfo: vpiRequiredStringSchema.optional(),
  patientNotificationRecipients: z.array(vpiObjectSchema),
})

const vpiUnknownArraySchema = z.array(z.unknown())

const vpiPatientRosterPaginationSchema = z.object({
  hasNextPage: z.boolean(),
})
export const vpiPatientRosterPageSchema = z.object({
  pagination: vpiPatientRosterPaginationSchema,
  patients: vpiUnknownArraySchema,
})
export const vpiPrescriptionStatusRowsSchema = z.union([
  vpiUnknownArraySchema,
  z.object({ prescriptions: vpiUnknownArraySchema }).transform((value) => value.prescriptions),
  z.object({ message: vpiUnknownArraySchema }).transform((value) => value.message),
  z
    .object({ message: z.object({ prescriptions: vpiUnknownArraySchema }) })
    .transform((value) => value.message.prescriptions),
])
export const vpiPatientAddressesResponseSchema = z
  .object({ addresses: z.array(vpiAddressSchema) })
  .transform((value) => value.addresses)
export const vpiProvidersResponseSchema = z.array(vpiProviderSchema)
export const vpiProductDiscountsResponseSchema = z.array(vpiProductDiscountSchema)

export type VpiPatientRosterPage = z.infer<typeof vpiPatientRosterPageSchema>
export type VpiPatient = z.infer<typeof vpiPatientSchema>
export type VpiPatientAddress = z.infer<typeof vpiAddressSchema>
export type VpiProvider = z.infer<typeof vpiProviderSchema>
export type VpiClinicLocation = z.infer<typeof vpiClinicLocationSchema>
export type VpiProductDetails = z.infer<typeof vpiProductDetailsSchema>
export type VpiProductDiscount = z.infer<typeof vpiProductDiscountSchema>
export type VpiProviderSignatureCheck = z.infer<typeof vpiProviderSignatureCheckSchema>
export type VpiPrescriptionStatus = z.infer<typeof vpiPrescriptionStatusSchema>
export type VpiSavePrescriptionResponse = z.infer<typeof vpiSavePrescriptionResponseSchema>
export type VpiDaySupplyResponse = z.infer<typeof vpiDaySupplyResponseSchema>
export type VpiShippingRateResponse = z.infer<typeof vpiShippingRateResponseSchema>
export type VpiProviderSignatureCheckInput = z.infer<typeof vpiProviderSignatureCheckInputSchema>
export type VpiSavePrescriptionPayload = z.infer<typeof vpiSavePrescriptionPayloadSchema>
export type VpiDaySupplyInput = {
  productId: string
  quantity: number
  sig: string
}
export type VpiShippingRateInput = {
  clinicId: string
  clinicLocationId: string
  patientId: string
  productIds: string[]
  shippingState: string
  isRushOrder: boolean
}

// --- client-local schemas (vpi-api.client.ts) ---

const requiredString = z.string().trim().min(1)
const binaryString = z.enum(["0", "1"])
export const jwtPayloadSchema = z.object({ exp: z.number().finite().positive() })

export const vpiAuthTokensSchema = z.object({
  id: requiredString.optional(),
  jwtToken: requiredString,
  refreshToken: requiredString,
})

export const vpiTaxonomySchema = z.array(
  z.object({
    family: requiredString,
    categories: z.array(requiredString),
  }),
)

const vpiProductSchema = z.object({
  id: requiredString,
  name: requiredString,
  unitPrice: z.number().finite().nonnegative(),
  productId: requiredString.refine((value) => /[a-z0-9]/i.test(value)),
  productSize: requiredString,
  medicalAccessories: binaryString,
  coldShipped: binaryString,
  controlledSubstance: binaryString,
  dispenseType: requiredString,
  productType: z.enum(["S", "NS"]),
  isReasonForCompoundedMedicationNeeded: z.boolean(),
})

export const vpiProductsByCategorySchema = z.array(
  z.object({
    subCategory2_item: requiredString,
    commonNames: z.array(
      z.object({
        commonName: requiredString,
        products: z.array(vpiProductSchema),
      }),
    ),
  }),
)

const vpiShippingStateRowSchema = z
  .object({
    name: requiredString,
    booleanCheck: z.boolean(),
    nonSterile: z.boolean(),
    sterile: z.boolean(),
  })
  .superRefine((value, context) => {
    if (normalizeVpiStateToCode(value.name) === null) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "state name is not a recognised US state, DC, or territory",
      })
    }
  })
  .transform((value) => ({
    name: value.name,
    code: normalizeVpiStateToCode(value.name) as string,
    booleanCheck: value.booleanCheck,
    nonSterile: value.nonSterile,
    sterile: value.sterile,
  }))

export const vpiShippingStatesSchema = z.object({
  data: z.array(
    z.object({
      states: z.array(vpiShippingStateRowSchema),
    }),
  ),
})
