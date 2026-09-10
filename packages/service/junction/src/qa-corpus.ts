/** High-signal ZIPs for availability prefetch (full routing corpus still used for area/psc). */
export const GEVITI_QA_SCHEDULING_ZIPS = [
  "85004",
  "85234",
  "11050",
  "10006",
  "90012",
  "96101",
  "92101",
  "60601",
  "33130",
  "98104",
  "75034",
  "07030",
] as const

/**
 * Phlebotomy availability is only served for a narrow Vital sandbox set.
 * Probed: 85004 works; broader scheduling zips often 400. Keep prefetch/reshape sealed.
 */
export const GEVITI_QA_PHLEBOTOMY_ZIPS = ["85004"] as const

/** City/state/first_line seals so availability cache keys match Vital + prefetch. */
export const GEVITI_QA_ZIP_ADDRESSES: Readonly<
  Record<string, { first_line: string; city: string; state: string }>
> = {
  "85004": { first_line: "1 N Central Ave", city: "Phoenix", state: "AZ" },
  "85234": { first_line: "1 Main St", city: "Gilbert", state: "AZ" },
  "11050": { first_line: "1 Main St", city: "Port Washington", state: "NY" },
  "10006": { first_line: "1 Main St", city: "New York", state: "NY" },
  "90012": { first_line: "200 N Spring St", city: "Los Angeles", state: "CA" },
  "96101": { first_line: "1 Main St", city: "Alturas", state: "CA" },
  "92101": { first_line: "1 Main St", city: "San Diego", state: "CA" },
  "60601": { first_line: "121 N LaSalle St", city: "Chicago", state: "IL" },
  "33130": { first_line: "3500 Pan American Dr", city: "Miami", state: "FL" },
  "98104": { first_line: "1 Main St", city: "Seattle", state: "WA" },
  "75034": { first_line: "1 Main St", city: "Frisco", state: "TX" },
  "07030": { first_line: "1 Main St", city: "Hoboken", state: "NJ" },
}

export const availabilityAddressForZip = (zip: string) => {
  const known = GEVITI_QA_ZIP_ADDRESSES[zip]
  return {
    first_line: known?.first_line ?? "1 Main St",
    second_line: null as string | null,
    city: known?.city ?? "Phoenix",
    state: known?.state ?? "AZ",
    zip_code: zip,
    unit: null as string | null,
  }
}

/**
 * Curated ZIPs mirrored from Geviti QA `ROUTING_ZIP_CORPUS` + fixture pins
 * (`packages/qa/src/world/gen/addresses.ts`, `@geviti/app/test-addresses`).
 * Prefetched into the observation cache so area/psc parity is sealed for those geos.
 */
export const GEVITI_QA_ROUTING_ZIPS = [
  "02108",
  "02903",
  "03101",
  "04101",
  "05401",
  "06103",
  "07030",
  "11050",
  "17316",
  "19107",
  "19801",
  "20001",
  "21201",
  "23219",
  "25301",
  "28202",
  "29201",
  "30303",
  "33130",
  "35203",
  "37219",
  "39201",
  "40202",
  "43215",
  "46204",
  "47630",
  "48226",
  "50309",
  "53202",
  "54977",
  "55415",
  "57104",
  "58102",
  "59101",
  "60601",
  "64106",
  "67202",
  "68102",
  "70112",
  "72201",
  "73102",
  "75034",
  "77002",
  "80202",
  "82001",
  "83702",
  "84111",
  "85004",
  "85234",
  "87102",
  "89101",
  "90012",
  "96101",
  "96813",
  "97204",
  "98104",
  "99501",
] as const

/** Lab ids exercised by Geviti walk-in / PSC flows (quest, labcorp, bioreference, sonora). */
export const GEVITI_QA_PSC_LAB_IDS = [4, 6, 13, 25] as const

/** Sealed patient + address shapes matching Geviti QA checkout (avoids junk 422 divergence). */
export const GEVITI_QA_ORDER_ADDRESSES = [
  {
    first_line: "1 N Central Ave",
    city: "Phoenix",
    state: "AZ",
    zip: "85004",
    country: "US",
  },
  {
    first_line: "200 N Spring St",
    city: "Los Angeles",
    state: "CA",
    zip: "90012",
    country: "US",
  },
  {
    first_line: "121 N LaSalle St",
    city: "Chicago",
    state: "IL",
    zip: "60601",
    country: "US",
  },
  {
    first_line: "1 Main St",
    city: "Port Washington",
    state: "NY",
    zip: "11050",
    country: "US",
  },
  {
    first_line: "3500 Pan American Dr",
    city: "Miami",
    state: "FL",
    zip: "33130",
    country: "US",
  },
  {
    first_line: "1437 Bannock St",
    city: "Denver",
    state: "CO",
    zip: "80202",
    country: "US",
  },
] as const

export const GEVITI_QA_PATIENT = {
  first_name: "Ada",
  last_name: "Lovelace",
  dob: "1990-01-01",
  gender: "female",
  phone_number: "+14155551234",
  email: "ada.lovelace@example.com",
} as const
