export const STATUS = {
  completed: 1,
  processing: 2,
  placed: 4,
  cancelled: 6,
  shipped: 7,
  inTransit: 14,
  downloaded: 10,
} as const

export const LINE_STATUSES = [
  [STATUS.placed, "Order Placed"],
  [STATUS.shipped, "Shipped to Patient"],
  [STATUS.inTransit, "In Transit"],
  [STATUS.processing, "Test Processing"],
  [STATUS.completed, "Results Completed"],
  [STATUS.downloaded, "Downloaded Results"],
  [8, "Archived"],
  [STATUS.cancelled, "Cancelled"],
  [9, "Issue"],
  [11, "Awaiting Patient Action"],
  [13, "Awaiting Patient Payment"],
  [12, "Awaiting Practitioner Payment"],
  [15, "Awaiting Practitioner Confirmation"],
].map(([id, name]) => ({ id: Number(id), name: String(name), description: String(name) }))

export const CANCEL_REASONS = [
  "Duplicate Test Ordered",
  "Accidentally Ordered",
  "Patient Requested Cancellation",
  "No longer Clinically Relevant",
  "Cost of Testing",
  "Technical Problems During Ordering",
  "Other",
].map((name, index) => ({ id: index + 1, name }))

export type TestType = {
  testTypeId: number
  testName: string | null
  sampleTypeName: string | null
  kitTypeIds: number[] | null
  price: number | null
}

export const DEFAULT_TEST_TYPES: readonly TestType[] = [
  {
    testTypeId: 263,
    testName: "GI360 Profile",
    sampleTypeName: "Stool",
    kitTypeIds: [1],
    price: 473,
  },
  {
    testTypeId: 264,
    testName: "GI360 Essentials Profile",
    sampleTypeName: "Stool",
    kitTypeIds: [1],
    price: 350,
  },
  {
    testTypeId: 265,
    testName: "GI360 Microbiome Profile",
    sampleTypeName: "Stool",
    kitTypeIds: [1],
    price: 250,
  },
  {
    testTypeId: 289,
    testName: "Organic Acids Test (OAT)",
    sampleTypeName: "Urine",
    kitTypeIds: [2],
    price: 329,
  },
  {
    testTypeId: 149,
    testName: "MycoTOX Profile (Mold Exposure)",
    sampleTypeName: "Urine",
    kitTypeIds: [2],
    price: 275,
  },
  {
    testTypeId: 266,
    testName: "TOXDetect Profile (includes glyphosate)",
    sampleTypeName: "Urine",
    kitTypeIds: [2],
    price: 300,
  },
  {
    testTypeId: 276,
    testName: "Glyphosate Test",
    sampleTypeName: "Urine",
    kitTypeIds: [2],
    price: 125,
  },
  {
    testTypeId: 249,
    testName: "Metals - Toxic Elements - Urine Random",
    sampleTypeName: "Urine",
    kitTypeIds: [2],
    price: 150,
  },
  {
    testTypeId: 273,
    testName: "EnviroTOX Complete + Metals",
    sampleTypeName: "Urine",
    kitTypeIds: [2],
    price: 550,
  },
  {
    testTypeId: 123,
    testName: "Hormones Comprehensive Plus Panel",
    sampleTypeName: "Urine",
    kitTypeIds: [2],
    price: 300,
  },
  {
    testTypeId: 263,
    testName: "GI360 Profile",
    sampleTypeName: "Stool",
    kitTypeIds: [3],
    price: 473,
  },
]

export const US_COUNTRY_ID = 105
const CANADA_COUNTRY_ID = 106
export const COUNTRIES = [
  {
    id: US_COUNTRY_ID,
    code: "US",
    name: "United States",
    excludeInShipping: false,
    excluded: false,
  },
  { id: CANADA_COUNTRY_ID, code: "CA", name: "Canada", excludeInShipping: false, excluded: false },
]

const states = (countryId: number, rows: string[], offset: number) =>
  rows.map((row, index) => {
    const code = row.slice(0, 2)
    return {
      id: offset + index,
      code,
      description: row.slice(3),
      cvCode: code,
      countryId,
      excludeInShipping: false,
      excludeInRegistration: false,
      excludeInContacts: false,
    }
  })

export const STATES = [
  ...states(
    US_COUNTRY_ID,
    [
      "AL Alabama",
      "AK Alaska",
      "AZ Arizona",
      "AR Arkansas",
      "CA California",
      "CO Colorado",
      "CT Connecticut",
      "DE Delaware",
      "FL Florida",
      "GA Georgia",
      "HI Hawaii",
      "ID Idaho",
      "IL Illinois",
      "IN Indiana",
      "IA Iowa",
      "LA Louisiana",
      "KS Kansas",
      "KY Kentucky",
      "ME Maine",
      "MD Maryland",
      "MA Massachusetts",
      "MI Michigan",
      "MN Minnesota",
      "MS Mississippi",
      "MO Missouri",
      "MT Montana",
      "NE Nebraska",
      "NV Nevada",
      "NH New Hampshire",
      "NJ New Jersey",
      "NM New Mexico",
      "NY New York",
      "NC North Carolina",
      "ND North Dakota",
      "OH Ohio",
      "OK Oklahoma",
      "OR Oregon",
      "PA Pennsylvania",
      "RI Rhode Island",
      "SC South Carolina",
      "SD South Dakota",
      "TN Tennessee",
      "TX Texas",
      "UT Utah",
      "VT Vermont",
      "VA Virginia",
      "WA Washington",
      "WV West Virginia",
      "WI Wisconsin",
      "WY Wyoming",
      "DC District of Columbia",
    ],
    1,
  ),
  ...states(
    CANADA_COUNTRY_ID,
    [
      "AB Alberta",
      "BC British Columbia",
      "MB Manitoba",
      "NB New Brunswick",
      "NL Newfoundland and Labrador",
      "NS Nova Scotia",
      "NT Northwest Territories",
      "NU Nunavut",
      "ON Ontario",
      "PE Prince Edward Island",
      "QC Quebec",
      "SK Saskatchewan",
      "YT Yukon",
    ],
    101,
  ),
]

export const LANGUAGES = [
  { id: 1, code: "en", name: "English", isCollectionInstructionsOption: true },
  { id: 2, code: "es", name: "Spanish", isCollectionInstructionsOption: true },
]

export const resolveState = (countryId: number, stateId: number, stateCode: string) =>
  STATES.find(
    (state) =>
      state.countryId === countryId &&
      (stateId ? state.id === stateId : state.code === stateCode.toUpperCase()),
  )
