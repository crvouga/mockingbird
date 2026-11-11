import type { Meta } from "@storybook/html-vite"
import {
  type Fleet,
  fleet,
  fleets,
  forbidden,
  inFleet,
  quotaExceeded,
  suspended,
} from "./fixtures.js"
import { failure, ok, PENDING } from "./mock.js"
import { mutation, query } from "./story.js"

export default { title: "Fleet/Emulators" } satisfies Meta

const typical = fleets[0] as Fleet
const base = inFleet(typical, "member")
/** The API's answer to a call that changes the fleet, and the fleet's screen afterwards. */
const changes = (after: Fleet) => ok(after, { "GET /fleets/flt_staging": ok(after) })

// ---- finding one in the catalog

const add = "/fleets/flt_staging/add-emulator"

/** Every emulator in the catalog; the ones already in this fleet are marked. */
export const Catalog = query({ path: add, routes: base })

export const CatalogSearch = query({
  path: add,
  routes: base,
  steps: (page) => page.fill("Search emulators", "payments"),
  shows: ["catalog:results"],
})

export const CatalogNoMatch = query({
  path: add,
  routes: base,
  steps: (page) => page.fill("Search emulators", "mainframe"),
  shows: ["catalog:no-match"],
})

/** The search is part of the address, so Back returns to the same results. */
export const CatalogSearchFromTheAddress = query({ path: `${add}?q=email`, routes: base })

export const CatalogAsViewer = query({ path: add, routes: inFleet(typical, "viewer") })

// ---- adding it

const configure = `${add}/twilio`

export const Configure = mutation({ path: configure, routes: base })

/** The fleet already runs Stripe: the suggested name is numbered. */
export const ConfigureSecondInstance = mutation({ path: `${add}/stripe`, routes: base })

export const ConfigureNameTaken = mutation({
  path: `${add}/stripe`,
  routes: base,
  steps: (page) => page.submit({ "Instance name": "stripe" }),
  shows: ["field-error"],
})

export const ConfigureBadName = mutation({
  path: configure,
  routes: base,
  steps: (page) => page.submit({ "Instance name": "Twilio SMS" }),
  shows: ["field-error"],
})

/** The API's refusal of the name carries no field: the form places it under the name. */
export const ConfigureNameRejected = mutation({
  path: configure,
  routes: {
    ...base,
    "PUT /fleets/flt_staging/emulators/twilio": failure(
      400,
      "invalid_request",
      "Emulator names are lowercase letters, digits and hyphens",
    ),
  },
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

export const ConfigureOverQuota = mutation({
  path: configure,
  routes: {
    ...base,
    "PUT /fleets/flt_staging/emulators/twilio": quotaExceeded(
      "This fleet already has 50 emulators",
      "emulatorsPerFleet",
      50,
    ),
  },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const ConfigureAdding = mutation({
  path: configure,
  routes: { ...base, "PUT /fleets/flt_staging/emulators/twilio": PENDING },
  steps: (page) => page.submit({ Durability: "strict" }),
  shows: ["pending"],
})

const withTwilio = fleet([
  ["stripe", "stripe", "strict"],
  ["resend", "resend", "buffered"],
  ["s3", "s3", "ephemeral"],
  ["twilio", "twilio", "strict"],
])

/** Added, the fleet's screen says so on the new emulator's card. */
export const ConfigureAdded = mutation({
  path: configure,
  routes: { ...base, "PUT /fleets/flt_staging/emulators/twilio": changes(withTwilio) },
  steps: (page) => page.submit({ Durability: "strict" }),
  shows: ["landed"],
})

export const ConfigureUnknownEmulator = query({ path: `${add}/mainframe`, routes: base })

// ---- durability

const resend = "/fleets/flt_staging/emulators/resend"
const after = (durability: "strict" | "buffered" | "ephemeral") =>
  fleet([
    ["stripe", "stripe", "strict"],
    ["resend", "resend", durability],
    ["s3", "s3", "ephemeral"],
  ])

export const Durability = mutation({ path: `${resend}/durability`, routes: base })

export const DurabilityUnchanged = mutation({
  path: `${resend}/durability`,
  routes: base,
  steps: (page) => page.submit(),
  shows: ["field-error"],
})

export const DurabilityWhileSuspended = mutation({
  path: `${resend}/durability`,
  routes: { ...base, "PATCH /fleets/flt_staging/emulators/resend": suspended("unpaid invoice") },
  steps: (page) => page.submit({ Durability: "strict" }),
  shows: ["form-error"],
})

export const DurabilitySaving = mutation({
  path: `${resend}/durability`,
  routes: { ...base, "PATCH /fleets/flt_staging/emulators/resend": PENDING },
  steps: (page) => page.submit({ Durability: "strict" }),
  shows: ["pending"],
})

export const DurabilityChanged = mutation({
  path: `${resend}/durability`,
  routes: { ...base, "PATCH /fleets/flt_staging/emulators/resend": changes(after("strict")) },
  steps: (page) => page.submit({ Durability: "strict" }),
  shows: ["landed"],
})

/** The fleet has no emulator by that name. */
export const DurabilityOfAMissingEmulator = query({
  path: "/fleets/flt_staging/emulators/twilio/durability",
  routes: base,
})

// ---- saving now

export const Save = mutation({ path: `${resend}/save`, routes: base })

/** The object store is failing; the API's reason is shown in the form. */
export const SaveFailed = mutation({
  path: `${resend}/save`,
  routes: {
    ...base,
    "POST /fleets/flt_staging/emulators/resend/flush": failure(
      503,
      "flush_failed",
      "The object store answered 503 SlowDown",
    ),
  },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const Saving = mutation({
  path: `${resend}/save`,
  routes: { ...base, "POST /fleets/flt_staging/emulators/resend/flush": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})

export const Saved = mutation({
  path: `${resend}/save`,
  routes: { ...base, "POST /fleets/flt_staging/emulators/resend/flush": ok({ ok: true }) },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

// ---- resetting

export const Reset = mutation({ path: `${resend}/reset`, routes: base })

export const ResetRefused = mutation({
  path: `${resend}/reset`,
  routes: { ...base, "POST /fleets/flt_staging/emulators/resend/reset": forbidden },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const ResetDone = mutation({
  path: `${resend}/reset`,
  routes: { ...base, "POST /fleets/flt_staging/emulators/resend/reset": ok({ ok: true }) },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

// ---- removing

export const Remove = mutation({ path: `${resend}/remove`, routes: base })

export const RemoveRefused = mutation({
  path: `${resend}/remove`,
  routes: { ...base, "DELETE /fleets/flt_staging/emulators/resend": forbidden },
  steps: (page) => page.submit(),
  shows: ["form-error"],
})

export const Removed = mutation({
  path: `${resend}/remove`,
  routes: {
    ...base,
    "DELETE /fleets/flt_staging/emulators/resend": changes(
      fleet([
        ["stripe", "stripe", "strict"],
        ["s3", "s3", "ephemeral"],
      ]),
    ),
  },
  steps: (page) => page.submit(),
  shows: ["landed"],
})

// ---- states every mutation is shown in

export const Resetting = mutation({
  path: `${resend}/reset`,
  routes: { ...base, "POST /fleets/flt_staging/emulators/resend/reset": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})

export const Removing = mutation({
  path: `${resend}/remove`,
  routes: { ...base, "DELETE /fleets/flt_staging/emulators/resend": PENDING },
  steps: (page) => page.submit(),
  shows: ["pending"],
})
