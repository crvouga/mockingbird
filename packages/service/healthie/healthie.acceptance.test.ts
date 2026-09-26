import { describe, expect, test } from "bun:test"
import { createRuntime, DEFAULT_WEBHOOK_IP, HEALTHIE_PRESETS, SEED } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  HealthieConsumer,
  HttpException,
  receiveFormWebhook,
  receivePatientWebhook,
  signInOutcome,
} from "./test/consumer.js"

const API = "http://healthie.mock/graphql"
const ORG_KEY = "gh_sbox_acme_org"
const BACKEND = "http://backend.local"
/** One of the two values `HEALTHIE_WEBHOOK_IP_ADDRESS` is Joi-restricted to (staging). */
const ALLOWED_IPS = "18.206.70.225,44.195.8.253"
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n")

type Delivery = { url: string; headers: Headers; body: Record<string, string> }

/** A runtime whose webhooks land in an in-memory list, and our consumer pointed at it. */
const harness = (namespaceSetting?: string) => {
  const deliveries: Delivery[] = []
  const runtime = createRuntime({
    settings: {
      orgApiKeys: [ORG_KEY],
      ...(namespaceSetting ? { namespace: namespaceSetting } : {}),
    },
    webhooks: {
      baseUrl: BACKEND,
      fetch: async (request) => {
        deliveries.push({
          url: request.url,
          headers: request.headers,
          body: (await request.json()) as Record<string, string>,
        })
        return new Response(null, { status: 201 })
      },
    },
  })
  const consumer = new HealthieConsumer(
    API,
    {
      HEALTHIE_API_AUTH_TOKEN: ORG_KEY,
      ...(namespaceSetting ? { HEALTHIE_NAMESPACE: namespaceSetting } : {}),
    },
    (request) => runtime.fetch(request),
  )
  const admin = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await runtime.fetch(
      new Request(`http://healthie.mock/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return (await response.json()) as Record<string, unknown>
  }
  /** Sign the seeded demo patient in and return the member's `Authorization` header. */
  const patientAuth = async () => {
    const { api_key } = await signInOutcome(consumer, {
      email: SEED.patientEmail,
      password: SEED.patientPassword,
    })
    return `Basic ${api_key}`
  }
  const received = async () => {
    await runtime.webhooks.idle()
    return deliveries.splice(0)
  }
  return { runtime, consumer, admin, patientAuth, received, deliveries }
}

const rejects = async (promise: Promise<unknown>): Promise<HttpException> => {
  try {
    await promise
  } catch (error) {
    if (error instanceof HttpException) return error
    throw error
  }
  throw new Error("expected an HttpException")
}

describe("S23 acceptance: our Healthie client against the mock", () => {
  test("signIn: an API key and the selected user fields; bad password and archived users map to our errors", async () => {
    const { consumer, admin } = harness()
    const { user, api_key } = await signInOutcome(consumer, {
      email: SEED.patientEmail,
      password: SEED.patientPassword,
    })
    expect(api_key).toMatch(/^gh_sbox_/)
    expect(user.id).toBe(SEED.patientId)
    expect(user.active).toBe(true)
    expect(user.dietitian).toEqual({
      id: SEED.dietitianId,
      full_name: "Dana Rivera",
      avatar_url: null,
      qualifications: "MD",
    })
    // Only requested fields come back: `full_name` is not in the signIn selection set.
    expect(user.full_name).toBeUndefined()
    // allow_multiple_api_keys: a second sign-in keeps the first key working.
    const again = await signInOutcome(consumer, {
      email: SEED.patientEmail,
      password: SEED.patientPassword,
    })
    expect(again.api_key).not.toBe(api_key)
    expect((await consumer.getCurrentUser(`Basic ${api_key}`)).id).toBe(SEED.patientId)

    const wrong = await rejects(
      signInOutcome(consumer, { email: SEED.patientEmail, password: "nope" }),
    )
    expect([wrong.status, wrong.body]).toEqual([401, "INVALID_SIGN_IN_CREDENTIALS"])
    const unknown = await rejects(
      signInOutcome(consumer, { email: "ghost@healthie.mock", password: "whatever1" }),
    )
    expect(unknown.body).toBe("INVALID_SIGN_IN_CREDENTIALS")

    await admin(`/users/${SEED.patientId}/archive`, {})
    const archived = await rejects(
      signInOutcome(consumer, { email: SEED.patientEmail, password: SEED.patientPassword }),
    )
    expect([archived.status, archived.body]).toEqual([401, "USER_ARCHIVED"])
  })

  test("signIn honours HEALTHIE_NAMESPACE: the declared $namespace must match the org's", async () => {
    const scoped = harness("acme")
    expect(
      (
        await signInOutcome(scoped.consumer, {
          email: SEED.patientEmail,
          password: SEED.patientPassword,
        })
      ).user.id,
    ).toBe(SEED.patientId)
    const unscoped = new HealthieConsumer(API, { HEALTHIE_API_AUTH_TOKEN: ORG_KEY }, (r) =>
      scoped.runtime.fetch(r),
    )
    expect(
      (await unscoped.signIn({ email: SEED.patientEmail, password: SEED.patientPassword })).user,
    ).toBeNull()
  })

  test("users(keywords), user(id), users(should_paginate:false), currentUser resolve with exactly the selected fields", async () => {
    const { consumer, admin, patientAuth } = harness()
    await admin("/users", {
      email: "second@healthie.mock",
      password: "Password123!",
      first_name: "Sam",
    })
    const byEmail = await consumer.getUserByEmail(SEED.patientEmail)
    expect(byEmail).toEqual([
      {
        id: SEED.patientId,
        email: SEED.patientEmail,
        first_name: "Pat",
        dietitian: {
          id: SEED.dietitianId,
          full_name: "Dana Rivera",
          avatar_url: null,
          qualifications: "MD",
        },
      },
    ])
    expect(await consumer.getUserByEmail("nobody@example.com")).toEqual([])
    const all = await consumer.getUsers()
    expect(all.users.map((u: { email: string }) => u.email)).toEqual([
      SEED.patientEmail,
      "second@healthie.mock",
    ])
    expect(Object.keys(all.users[0]).sort()).toEqual(
      [
        "avatar_url",
        "created_at",
        "dietitian_id",
        "email",
        "first_name",
        "id",
        "last_conversation_id",
        "last_name",
        "next_onboarding_step",
        "next_required_step",
        "phone_number",
        "timezone",
        "updated_at",
      ].sort(),
    )
    const byId = await consumer.getUserById(SEED.patientId)
    expect(byId.full_name).toBe("Pat Member")
    expect(byId.providers).toEqual([{ id: SEED.dietitianId, email: "dietitian@healthie.mock" }])
    expect(byId.location).toBeNull()
    expect(byId.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+0000$/)
    // A member's own key sees itself; the org key sees any client.
    const auth = await patientAuth()
    const me = await consumer.getCurrentUser(auth)
    expect(me.email).toBe(SEED.patientEmail)
    expect(me.has_forms_to_complete).toBe(false)
    expect(me.providers.map((p: { id: string }) => p.id)).toEqual([SEED.dietitianId])
    expect(await consumer.getUserById(SEED.orgAdminId, auth)).toBeNull()
  })

  test("updateUser, 4 variants: multipart avatar (bytes served back), avatar null, profile, password", async () => {
    const { consumer, patientAuth, received } = harness()
    const auth = await patientAuth()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const withAvatar = await consumer.updateUserById(
      SEED.patientId,
      auth,
      { firstName: "Patricia", timeZone: "America/New_York", seenWelcome: true },
      { originalname: "me.png", mimetype: "image/png", bytes: png },
    )
    expect(withAvatar.messages).toBeNull()
    expect(withAvatar.user.first_name).toBe("Patricia")
    expect(withAvatar.user.timezone).toBe("America/New_York")
    const avatarUrl = withAvatar.user.avatar_url as string
    expect(avatarUrl).toStartWith("http://healthie.mock/files/")
    const bytes = new Uint8Array(await (await consumerFetch(consumer, avatarUrl)).arrayBuffer())
    expect([...bytes]).toEqual([...png])
    // patient.updated reaches /users/webhook/status.
    const events = await received()
    expect(events.map((e) => [e.url, e.body.event_type])).toEqual([
      [`${BACKEND}/users/webhook/status`, "patient.updated"],
    ])

    const removed = await consumer.removeProfilePhoto(SEED.patientId, auth)
    expect(removed).toEqual({ user: { id: SEED.patientId, avatar_url: null }, messages: null })

    const profile = await consumer.updateUserInformation(auth, SEED.patientId, {
      lastName: "Membership",
      phoneNumber: "6025550142",
    })
    expect(profile.user).toEqual({
      id: SEED.patientId,
      first_name: "Patricia",
      last_name: "Membership",
      email: SEED.patientEmail,
      phone_number: "6025550142",
      timezone: "America/New_York",
    })
    const badPhone = await consumer.updateUserInformation(auth, SEED.patientId, {
      phoneNumber: "12",
    })
    expect(badPhone.messages).toEqual([
      { field: "phone_number", message: "Phone number is invalid" },
    ])

    // The password variant declares no $id: Healthie updates the key's own user.
    const mismatch = await consumer.updateUserPassword(SEED.patientId, auth, {
      oldPassword: SEED.patientPassword,
      newPassword: "NewPassword1!",
      confirmNewPassword: "Different1!",
    })
    expect(mismatch.user).toBeNull()
    expect(mismatch.messages?.map((m: { field: string }) => m.field)).toEqual([
      "password_confirmation",
    ])
    const wrongCurrent = await consumer.updateUserPassword(SEED.patientId, auth, {
      oldPassword: "not-it",
      newPassword: "NewPassword1!",
      confirmNewPassword: "NewPassword1!",
    })
    expect(wrongCurrent.messages?.map((m: { field: string }) => m.field)).toEqual([
      "current_password",
    ])
    const changed = await consumer.updateUserPassword(SEED.patientId, auth, {
      oldPassword: SEED.patientPassword,
      newPassword: "NewPassword1!",
      confirmNewPassword: "NewPassword1!",
    })
    expect(changed).toEqual({
      user: {
        next_required_step: null,
        blast_seen: false,
        id: SEED.patientId,
        email: SEED.patientEmail,
        consented_to_labs: false,
        skipped_email: false,
        __typename: "User",
      },
      messages: null,
      __typename: "updateUserPayload",
    })
    expect(
      (await consumer.signIn({ email: SEED.patientEmail, password: "NewPassword1!" })).user?.id,
    ).toBe(SEED.patientId)
  })

  test("updateClient (org key): metadata, phone, password, other_provider_ids, group, checkout location", async () => {
    const { consumer, admin } = harness()
    const metadata = JSON.stringify({ has_scheduled_bloodwork: true, plan_id: "p_1" })
    const updated = await consumer.updateClientById(SEED.patientId, metadata, "4805551234")
    expect(updated.messages).toBeNull()
    expect(updated.user.metadata).toBe(metadata)
    expect(updated.user.phone_number).toBe("4805551234")
    expect(updated.user.billing_items).toEqual([])
    const password = await consumer.updateClientPassword(SEED.patientId, "Reset12345!")
    expect(password.user).toEqual({
      id: SEED.patientId,
      first_name: "Pat",
      email: SEED.patientEmail,
    })
    expect(
      (await consumer.signIn({ email: SEED.patientEmail, password: "Reset12345!" })).user?.id,
    ).toBe(SEED.patientId)
    const provider = (await admin("/users", {
      email: "np@healthie.mock",
      password: "Password123!",
      role: "provider",
      first_name: "Nia",
      last_name: "Park",
    })) as { user: { id: string } }
    expect(
      await consumer.addProvidersToUser(SEED.patientId, [provider.user.id, SEED.dietitianId]),
    ).toBe(true)
    expect((await consumer.getUserById(SEED.patientId)).other_provider_ids).toEqual([
      provider.user.id,
    ])
    const group = await consumer.updateClientGroupById(SEED.patientId, "g_onboarded")
    expect(group).toEqual({
      user: { id: SEED.patientId, email: SEED.patientEmail },
      messages: null,
    })
    const checkout = await consumer.updateCheckoutPatientById({
      id: SEED.patientId,
      first_name: "Pat",
      last_name: "Member",
      timezone: "America/Phoenix",
      dob: "1990-04-01",
      gender: "Female",
      phone_number: "4805551234",
      location: { city: "Phoenix", line1: "1625 N Central Ave", state: "AZ", zip: "85004" },
    })
    expect(checkout.user).toMatchObject({ dob: "1990-04-01", legal_name: null })
    expect((await consumer.getUserById(SEED.patientId)).location).toMatchObject({
      line1: "1625 N Central Ave",
      city: "Phoenix",
      state: "AZ",
      zip: "85004",
    })
    // messages[] non-empty is the 400 path: addProvidersToUser answers false.
    const bad = await consumer.updateCheckoutPatientById({
      id: SEED.patientId,
      first_name: "Pat",
      last_name: "Member",
      timezone: "Mars/Olympus",
      dob: "04/01/1990",
      gender: "Female",
      phone_number: "4805551234",
      location: { city: "Phoenix", line1: "1 A St", state: "AZ", zip: "85004" },
    })
    // Discrepancy (consumer bug): updateCheckoutPatientById sends `timezone` as a variable but
    // never declares or uses it, so Healthie ignores it (graphql-js drops undeclared variables).
    expect(bad.messages?.map((m: { field: string }) => m.field)).toEqual(["dob"])
  })

  test("location, locations, createLocation, updateLocation (the consumer's city=line2 bug is stored as sent)", async () => {
    const { consumer, patientAuth } = harness()
    const auth = await patientAuth()
    const created = await consumer.createLocation(
      SEED.patientId,
      { line1: "1625 N Central Ave", line2: "Apt 4", state: "AZ", country: "US", zip: "85004" },
      auth,
    )
    expect(created.messages).toBeNull()
    // Discrepancy (consumer bug, not the mock): createLocation sends `city: line2` and never
    // sends line2 (it is not declared), so Healthie stores city "Apt 4" and line2 null.
    expect(created.location).toMatchObject({ city: "Apt 4", line2: null, zip: "85004" })
    const id = created.location.id as string
    expect(await consumer.getLocationById(id, auth)).toEqual({
      id,
      line1: "1625 N Central Ave",
      state: "AZ",
      city: "Apt 4",
      zip: "85004",
    })
    const moved = await consumer.updateHealthieAddress(
      id,
      { city: "Phoenix", line2: "Apt 5" },
      auth,
    )
    expect(moved.location).toMatchObject({ city: "Phoenix", line2: "Apt 5" })
    expect((await consumer.listAllLocations(auth)).locations).toHaveLength(1)
    const invalid = await consumer.updateHealthieAddress(id, { zip: "ABCDE" }, auth)
    expect(invalid.messages).toEqual([{ field: "zip", message: "Zip is invalid" }])
    // A member cannot read another user's location.
    const other = await consumer.createLocation(
      SEED.dietitianId,
      { line1: "1 Clinic Way", state: "AZ", country: "US", zip: "85004" },
      `Bearer ${ORG_KEY}`,
    )
    expect(await consumer.getLocationById(other.location.id, auth)).toBeNull()
  })

  test("the ODX PDF upload flow: folder by path, document exists → delete → re-create, expiring_url serves the bytes", async () => {
    const { consumer, patientAuth, runtime } = harness()
    const auth = await patientAuth()
    expect((await consumer.listFiles(auth, { fileSharingFilter: "all" })).files).toEqual([])
    const folder = await consumer.getFolderByPath(auth, "Lab Results/2026", true)
    expect(folder?.name).toBe("2026")
    // Found again on the second walk (filter-as-keyword + exact name match), not re-created.
    expect((await consumer.getFolderByPath(auth, "lab results/2026"))?.id).toBe(folder?.id)
    const dup = await rejects(consumer.createFolder(auth, { folderName: "Lab Results" }))
    expect([dup.status, dup.body]).toEqual([400, "Folder with the same name already exists"])

    const name = "LabResults-Acme Panel ODX - 42.pdf"
    const upload = { originalname: "report.pdf", mimetype: "application/pdf", bytes: PDF }
    const first = await consumer.createDocument(
      auth,
      { filename: name, parentFolderId: folder?.id },
      upload,
      `user-${SEED.dietitianId}`,
    )
    expect(first.messages).toBeNull()
    expect(first.document).toMatchObject({
      display_name: name,
      file_content_type: "application/pdf",
      opens: [],
      owner: { id: SEED.patientId, email: SEED.patientEmail },
      users: [{ id: SEED.dietitianId, first_name: "Dana", email: "dietitian@healthie.mock" }],
    })
    const inFolder = await consumer.listFiles(auth, { fileSharingFilter: "uploaded" }, folder?.id)
    const existing = inFolder.files.find((f) => f.name === name && f.parentFolderId === folder?.id)
    expect(existing?.fileType).toBe("document")
    expect(await consumer.deleteDocumentById(auth, existing?.id as string)).toEqual({
      document: { id: existing?.id },
      messages: null,
    })
    expect(await consumer.getDocumentById(auth, existing?.id as string)).toBeNull()
    const second = await consumer.createDocument(
      auth,
      { filename: name, parentFolderId: folder?.id },
      upload,
    )
    const doc = await consumer.getDocumentById(auth, second.document.id)
    const response = await consumerFetch(consumer, doc.expiring_url)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(new TextDecoder().decode(await response.arrayBuffer())).toStartWith("%PDF-1.4")
    expect((await consumer.getDocumentById(auth, second.document.id)).opens).toHaveLength(1)
    // The provider sees it as shared; the link expires on the mock clock.
    const shared = await consumer.listFiles(
      `Bearer ${ORG_KEY}`,
      { fileSharingFilter: "shared" },
      folder?.id,
    )
    expect(shared.files.map((f) => f.name)).toEqual([name])
    runtime.clock.advance(301_000)
    expect((await consumerFetch(consumer, doc.expiring_url)).status).toBe(403)
  })

  test("listFiles: currentUser null → our 401; an unknown key → 401; the 500 and other error branches", async () => {
    const { consumer, runtime } = harness()
    expect((await rejects(consumer.listFiles("", { fileSharingFilter: "all" }))).status).toBe(401)
    expect(
      (await rejects(consumer.listFiles("Basic gh_sbox_revoked", { fileSharingFilter: "all" })))
        .status,
    ).toBe(401)
    runtime.applyPreset("current_user_null", "default", { count: 1 })
    expect(
      (await rejects(consumer.listFiles(`Bearer ${ORG_KEY}`, { fileSharingFilter: "all" }))).status,
    ).toBe(401)
    runtime.applyPreset("invalid_api_key", "default", { count: 1 })
    expect((await rejects(consumer.getUserByEmail(SEED.patientEmail))).status).toBe(401)
    // The multipart client (awesome-graphql-client) reaches the same 401 through its own branch.
    runtime.applyPreset("invalid_api_key", "default", { count: 1 })
    expect(
      (
        await rejects(
          consumer.createDocument(
            `Bearer ${ORG_KEY}`,
            { filename: "x.pdf" },
            {
              originalname: "x.pdf",
              mimetype: "application/pdf",
              bytes: PDF,
            },
          ),
        )
      ).status,
    ).toBe(401)
    runtime.applyPreset("graphql_500", "default", { count: 1 })
    expect((await rejects(consumer.getUserByEmail(SEED.patientEmail))).status).toBe(500)
    runtime.applyPreset("http_500", "default", { count: 1 })
    expect((await rejects(consumer.getUserByEmail(SEED.patientEmail))).status).toBe(500)
    // A document our schema does not know is a validation error → 400, like a typo on Healthie.
    const typo = await runtime.fetch(
      new Request(API, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ORG_KEY}` },
        body: JSON.stringify({ query: "{ currentUser { id not_a_field } }" }),
      }),
    )
    expect(((await typo.json()) as { errors: { message: string }[] }).errors[0]?.message).toContain(
      "not_a_field",
    )
    // count 2: addProvidersToUser reads the user first, then sends updateClient.
    runtime.applyPreset("validation_messages", "default", { count: 2 })
    expect(await consumer.addProvidersToUser(SEED.patientId, [SEED.dietitianId])).toBe(false)
  })

  test("requestedFormCompletion + the forms webhook: IP allowlist, then the email our receiver builds", async () => {
    const { consumer, admin, received } = harness()
    const request = (await admin("/requested-forms", { recipient_id: SEED.patientId })) as {
      id: string
    }
    const [delivery] = await received()
    expect(delivery?.url).toBe(`${BACKEND}/forms/webhooks/status`)
    expect(delivery?.body).toEqual({
      resource_id: request.id,
      resource_id_type: "RequestedFormCompletion",
      event_type: "requested_form_completion.created",
    })
    expect(delivery?.headers.get("x-forwarded-for")).toBe(DEFAULT_WEBHOOK_IP)
    const outcome = await receiveFormWebhook(
      consumer,
      delivery?.headers as Headers,
      delivery?.body as { resource_id: string },
      ALLOWED_IPS,
    )
    expect(outcome).toEqual({
      handled: true,
      action: "send-forms-email",
      detail: {
        // Discrepancy (consumer bug): the query never selects recipient.id, so the cache key
        // our receiver deletes is `…:undefined`. The mock honours the selection set.
        userAuthCacheKey: "user-auth:undefined",
        username: "Pat",
        toEmail: SEED.patientEmail,
        provider_full_name: "Dana Rivera",
        avatar_url: "",
        qualifications: "MD",
      },
    })
    // Prod IPs are rejected by a staging-configured receiver.
    expect(
      await receiveFormWebhook(
        consumer,
        new Headers({ "x-forwarded-for": "52.4.158.130" }),
        { resource_id: request.id },
        ALLOWED_IPS,
      ),
    ).toEqual({ handled: false, reason: "ip-not-allowed" })
    expect(
      (
        await consumer.getCurrentUser(
          `Basic ${(await signInOutcome(consumer, { email: SEED.patientEmail, password: SEED.patientPassword })).api_key}`,
        )
      ).has_forms_to_complete,
    ).toBe(true)
  })

  test("the patient webhook: our receiver re-reads the user and picks a cache flush", async () => {
    const { consumer, admin, received } = harness()
    await consumer.updateClientById(SEED.patientId, JSON.stringify({ a: 1 }))
    const [delivery] = await received()
    expect(delivery?.body).toMatchObject({
      resource_id: SEED.patientId,
      resource_id_type: "User",
      event_type: "patient.updated",
    })
    expect(
      await receivePatientWebhook(
        consumer,
        delivery?.headers as Headers,
        delivery?.body as { resource_id: string },
        ALLOWED_IPS,
      ),
    ).toEqual({ handled: true, action: `flush-user-auth-cache:${SEED.patientId}` })
    // A patient without a dietitian flushes every cached session (our receiver's branch).
    const created = (await admin("/users", {
      email: "solo@healthie.mock",
      password: "Password123!",
    })) as {
      user: { id: string }
    }
    const [createdEvent] = await received()
    expect(createdEvent?.body.event_type).toBe("patient.created")
    expect(
      await receivePatientWebhook(
        consumer,
        createdEvent?.headers as Headers,
        { resource_id: created.user.id },
        ALLOWED_IPS,
      ),
    ).toEqual({ handled: true, action: "flush-all-user-auth-caches" })
    expect(
      await receivePatientWebhook(
        consumer,
        new Headers(),
        { resource_id: created.user.id },
        ALLOWED_IPS,
      ),
    ).toEqual({ handled: false, reason: "no-ip" })
  })

  test("migration/export reads: formAnswerGroups, formAnswerGroup, initialFormAnswers, offerings", async () => {
    const { consumer, admin, patientAuth } = harness()
    const group = (await admin("/form-answer-groups", {
      user_id: SEED.patientId,
      filler_id: SEED.dietitianId,
      answers: { "Primary health goal": "More energy", "310002": "None" },
    })) as { id: string }
    const groups = await consumer.getAllChartingNoteDocuments(SEED.patientId)
    expect(groups.formAnswerGroups).toEqual([
      {
        id: group.id,
        name: "Intake form",
        filler: { id: SEED.dietitianId, name: "Dana Rivera", email: "dietitian@healthie.mock" },
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ])
    const single = await consumer.getSingleChartingNoteDocument(group.id)
    expect(single.formAnswerGroup).toMatchObject({
      user: { id: SEED.patientId, full_name: "Pat Member" },
      custom_module_form: { name: "Intake form" },
    })
    expect(
      single.formAnswerGroup.form_answers.map((a: { label: string; displayed_answer: string }) => [
        a.label,
        a.displayed_answer,
      ]),
    ).toEqual([
      ["Primary health goal", "More energy"],
      ["Current medications", "None"],
    ])
    const initial = await consumer.getFormAnswers(
      await patientAuth(),
      undefined,
      { formId: SEED.intakeFormId },
      SEED.patientId,
    )
    expect(initial.initialFormAnswers.map((a: { answer: string }) => a.answer)).toEqual([
      "More energy",
      "None",
    ])
    const offerings = await consumer.fetchOfferingsById(SEED.addonOfferingId)
    // client_visibility "all" includes hidden offerings.
    expect(offerings.offerings).toEqual([
      {
        id: SEED.addonOfferingId,
        name: "Bloodwork Add-on",
        billing_frequency: "One-Time",
        currency: "usd",
        price: "99.0",
        visibility_status: "hidden",
      },
    ])
  })

  test("billingItems and updateBillingItem sent as two aliased mutations in one document", async () => {
    const { consumer, admin, patientAuth, runtime } = harness()
    const item = (await admin("/billing-items", {
      sender_id: SEED.patientId,
      offering_id: SEED.membershipOfferingId,
    })) as { id: string }
    await admin("/billing-items", { sender_id: SEED.patientId })
    const auth = await patientAuth()
    const listed = await consumer.listBillingItems(auth, true, SEED.patientId, ["succeeded"])
    expect(listed.billingItems).toHaveLength(1)
    expect(listed.billingItems[0]).toMatchObject({
      id: item.id,
      state: "succeeded",
      is_recurring: true,
      offering_id: SEED.membershipOfferingId,
      offering: { id: SEED.membershipOfferingId, name: "Acme Membership", price: "149.0" },
      sender: { stripe_customer_detail: null },
      recurring_payment: { offering_id: SEED.membershipOfferingId, is_paused: false },
    })
    const paused = await consumer.pauseBillingItem(item.id, true)
    expect(paused.updateBillingItem.billingItem.recurring_payment.is_paused).toBe(true)
    expect(paused.updateBillingWebhook).toEqual({ billingItem: { id: item.id }, messages: null })
    // The alias exists to make Healthie fire billing_item.updated (it rewrites the note).
    const events = runtime.webhooks.messages("default").map((m) => m.type)
    expect(events).toEqual(["billing_item.updated", "billing_item.updated"])
    const canceled = await consumer.cancelSubscription(item.id)
    expect(canceled.updateBillingItem.messages).toBeNull()
    const after = await consumer.listBillingItems(auth, true)
    expect(after.billingItems[0]).toMatchObject({ is_canceled: true, state: "canceled" })
    expect(after.billingItems[0].recurring_payment.next_payment_date).toBeNull()
  })

  test("namespaces by API key isolate parallel suites; the journal never holds bodies", async () => {
    const { runtime } = harness()
    await runtime.fetch(
      new Request("http://healthie.mock/__admin/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "key-a": "a", "key-b": "b" } }),
      }),
    )
    for (const ns of ["a", "b"]) {
      await runtime.fetch(
        new Request(`http://healthie.mock/__admin/settings?namespace=${ns}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgApiKeys: [`key-${ns}`] }),
        }),
      )
    }
    const a = new HealthieConsumer(API, { HEALTHIE_API_AUTH_TOKEN: "key-a" }, (r) =>
      runtime.fetch(r),
    )
    const b = new HealthieConsumer(API, { HEALTHIE_API_AUTH_TOKEN: "key-b" }, (r) =>
      runtime.fetch(r),
    )
    await a.updateClientById(SEED.patientId, "secret-metadata-a")
    expect((await a.getUserById(SEED.patientId)).metadata).toBe("secret-metadata-a")
    expect((await b.getUserById(SEED.patientId)).metadata).not.toBe("secret-metadata-a")
    const journal = await (
      await runtime.fetch(new Request("http://healthie.mock/__admin/requests?namespace=a"))
    ).json()
    const text = JSON.stringify(journal)
    expect(text).toContain("mutation updateClient")
    expect(text).not.toContain("secret-metadata-a")
    expect(text).not.toContain(SEED.patientPassword)
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(HEALTHIE_PRESETS)).toEqual(
      expect.arrayContaining([
        "invalid_api_key",
        "graphql_500",
        "validation_messages",
        "current_user_null",
        "expired_urls",
        "http_500",
        "rate_limited",
        "webhook_duplicate",
        "webhook_reorder",
        "webhook_drop",
      ]),
    )
  })
})

/** Download a file URL through the same transport the consumer uses (the runtime). */
const consumerFetch = (consumer: HealthieConsumer, url: string) => consumer.fetchFile(url)

describe("served over HTTP", () => {
  test("the consumer works against the node server, uploads multipart, and webhooks reach a real sink", async () => {
    const received: { path: string; ip: string | null; body: unknown }[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({
          path: new URL(request.url).pathname,
          ip: request.headers.get("x-forwarded-for"),
          body: await request.json(),
        })
        return new Response(null, { status: 201 })
      },
    })
    const server = await createServer({
      settings: { orgApiKeys: [ORG_KEY] },
      webhooks: { baseUrl: `http://127.0.0.1:${sink.port}`, ip: "44.195.8.253" },
    })
    try {
      const consumer = new HealthieConsumer(
        `${server.url}/graphql`,
        { HEALTHIE_API_AUTH_TOKEN: ORG_KEY },
        (r) => fetch(r),
      )
      const { api_key } = await signInOutcome(consumer, {
        email: SEED.patientEmail,
        password: SEED.patientPassword,
      })
      const created = await consumer.createDocument(
        `Basic ${api_key}`,
        { filename: "served.pdf" },
        { originalname: "served.pdf", mimetype: "application/pdf", bytes: PDF },
      )
      const doc = await consumer.getDocumentById(`Basic ${api_key}`, created.document.id)
      expect(doc.expiring_url).toStartWith(`${server.url}/files/`)
      expect(
        new TextDecoder().decode(await (await fetch(doc.expiring_url)).arrayBuffer()),
      ).toStartWith("%PDF")
      await consumer.updateClientById(SEED.patientId, "{}")
      const deadline = Date.now() + 3_000
      while (received.length < 1 && Date.now() < deadline) await Bun.sleep(25)
      expect(received).toEqual([
        {
          path: "/users/webhook/status",
          ip: "44.195.8.253",
          body: {
            resource_id: SEED.patientId,
            resource_id_type: "User",
            event_type: "patient.updated",
            changed_fields: ["metadata"],
          },
        },
      ])
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^healthie@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
