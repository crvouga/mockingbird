import { describe, expect, test } from "bun:test"
import { CARETALK_PRESETS, createRuntime, type FormRoundRecord } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  type CareTalkConfig,
  CareTalkConsumer,
  type Fetch,
  InternalServerErrorException,
} from "./test/consumer.js"

const API = "http://caretalk.mock"
/** Generated per run: the mock only needs the client and --api-user to agree on it. */
const FIXTURE_PASSWORD = crypto.randomUUID()
const config: CareTalkConfig = {
  apiUrl: API,
  userName: "acme-api",
  password: FIXTURE_PASSWORD,
  apiKey: "ct-static-key",
  programId: 21,
}
const ada = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  dob: "1985-12-10",
  sex: "female",
  phoneNumber: "+1 801 555 0142",
  address: { line1: "1 Main St", city: "Salt Lake City", state: "UT", zip: "84101" },
}

const harness = (extra: Partial<CareTalkConfig> = {}) => {
  const runtime = createRuntime()
  const fetchImpl: Fetch = (input, init) => runtime.fetch(new Request(input, init))
  const consumer = new CareTalkConsumer({ ...config, ...extra }, fetchImpl, runtime.clock.now)
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`${API}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const journal = async (query = "") =>
    (
      (await (await runtime.fetch(new Request(`${API}/__admin/requests${query}`))).json()) as {
        requests: { operationId?: string; status: number }[]
      }
    ).requests
  let record = 0
  const backfill = () => consumer.createAccountForExistingUsers([ada], () => ++record)
  return { runtime, consumer, admin, journal, backfill, fetchImpl }
}

describe("S25 CareTalk acceptance: our client against the mock", () => {
  test("client-login once, then GetForm by name or slug transforms into our form model", async () => {
    const { consumer, journal } = harness()
    const byName = await consumer.getFormByName("Health History")
    const bySlug = await consumer.getFormByName("health-history")
    expect(bySlug).toEqual(byName)
    const form = consumer.transformFormData(byName)
    expect(form).toMatchObject({
      id: 101,
      name: "Health History",
      group: "Caretalk",
      is_active: true,
    })
    expect(form.questions.map((q) => [q.id, q.type])).toEqual([
      [1001, "choice"],
      [1002, "multiple_choice"],
      [1003, "text"],
      [1004, "display_text"],
    ])
    expect(
      form.questions[1]?.options?.find((o) => o.label === "Other")?.requiresTextualAnswer,
    ).toBe(true)
    const aoe = consumer.transformFormData(await consumer.getFormByName("AOE Questions"))
    expect(aoe.description).toBe("No description provided")
    expect(aoe.questions[0]?.type).toBe("choice")
    // An unknown form is an empty list, which our transform refuses.
    const unknown = await consumer.getFormByName("no-such-form")
    expect(unknown).toEqual([])
    expect(() => consumer.transformFormData(unknown)).toThrow("Invalid form.")
    expect((await journal("?operationId=ClientLogin")).length).toBe(1)
  })

  test("an expired token is a bare 401; our client logs in again once and retries", async () => {
    const { consumer, admin, runtime, journal } = harness()
    await admin("/settings", { tokenTtlSeconds: 60 }, "PUT")
    await consumer.getFormByName("health-history")
    runtime.clock.advance(120_000)
    // Our cache still holds the token (3600 s), the vendor has expired it.
    expect(await consumer.getStateId("UT")).toBe(45)
    expect((await journal("?operationId=ClientLogin")).length).toBe(2)
    expect((await journal("?operationId=ListStates")).map((e) => e.status)).toEqual([401, 200])
    runtime.applyPreset("token_expired", "default", { count: 1 })
    expect((await consumer.getFormByName("health-history")).length).toBe(1)
    runtime.applyPreset("token_expired", "default", { count: 2 })
    await expect(consumer.getStateId("UT")).rejects.toThrow(InternalServerErrorException)
    expect(consumer.errors).toContain("API request failed after token refresh")
  })

  test("the account backfill: search misses (400), state id, insert; a second run finds the patient", async () => {
    const { backfill, admin, journal } = harness()
    const first = await backfill()
    expect(first.createdAccounts).toHaveLength(1)
    const patient = first.createdAccounts[0] as Record<string, unknown>
    expect(patient).toMatchObject({
      firstName: "Ada",
      mobilePhone: "(801) 555-0142",
      userStateId: 45,
      userState: "Utah",
      programId: 21,
      recordId: "GV-001",
      recordStatus: "Active",
    })
    // The search sends MM/DD/YYYY; the insert sent an ISO date. They still match.
    const second = await backfill()
    expect(second.createdAccounts).toHaveLength(0)
    expect((await journal("?operationId=SearchForPatient")).map((e) => e.status)).toEqual([
      400, 200,
    ])
    const patients = (await (await admin("/patients")).json()) as { patients: unknown[] }
    expect(patients.patients).toHaveLength(1)
  })

  test("the form-submission queue's SavePatientForm stores a round GetForm echoes back", async () => {
    const { consumer, backfill, admin } = harness()
    const { createdAccounts } = await backfill()
    const patientId = (createdAccounts[0] as { id: number }).id
    await consumer.savePatientForm(patientId, {
      fullFormDto: {
        id: 101,
        name: "health-history",
        groups: [
          {
            groupQuestions: [
              {
                questionId: 1001,
                question: { id: 1001, questionAnswers: [{ id: 5002, answer: "No" }] },
              },
              {
                questionId: 1002,
                question: {
                  id: 1002,
                  questionAnswers: [
                    { id: 5003, answer: "Hypertension" },
                    { id: 5005, answer: "Other", freeAnswerText: "Asthma" },
                  ],
                },
              },
              // Text fields go as id 0 with the typed value (form-adapters.ts).
              {
                questionId: 1003,
                question: { id: 1003, questionAnswers: [{ id: 0, answer: "Metformin" }] },
              },
            ],
          },
        ],
      },
    })
    const submissions = (await (
      await admin(`/form-submissions?patientId=${patientId}`)
    ).json()) as {
      submissions: FormRoundRecord[]
    }
    expect(submissions.submissions[0]?.answers.map((a) => [a.questionId, a.answerIds])).toEqual([
      [1001, [5002]],
      [1002, [5003, 5005]],
      [1003, []],
    ])
    // getFormData (static CARETALK_API_KEY bearer) reads the round back.
    const [round] = await consumer.getFormData("health-history", 0, patientId)
    expect(round?.formRoundId).toBe(1)
    const questions = round?.fullFormDto.groups[0]?.groupQuestions.map((g) => g.question) ?? []
    expect(questions[0]?.questionAnswers.map((a) => a.isChecked)).toEqual([false, true])
    expect(questions[1]?.questionAnswers.find((a) => a.id === 5005)?.freeAnswerText).toBe("Asthma")
    expect(questions[2]?.answerText).toBe("Metformin")
  })

  test("SavePatientForm refuses answers outside the form, unknown patients, and the save_rejected preset", async () => {
    const { consumer, backfill, runtime } = harness()
    const patientId = ((await backfill()).createdAccounts[0] as { id: number }).id
    const submission = (answerId: number) => ({
      fullFormDto: {
        id: 101,
        name: "health-history",
        groups: [
          {
            groupQuestions: [
              {
                questionId: 1001,
                question: { id: 1001, questionAnswers: [{ id: answerId, answer: "x" }] },
              },
            ],
          },
        ],
      },
    })
    await expect(consumer.savePatientForm(patientId, submission(5101))).rejects.toThrow(
      "Error submitting patient form",
    )
    expect(consumer.errors.join("\n")).toMatch(/Failed to submit patient form/)
    await expect(consumer.savePatientForm(999, submission(5001))).rejects.toThrow(
      InternalServerErrorException,
    )
    runtime.applyPreset("save_rejected", "default", { count: 1 })
    await expect(consumer.savePatientForm(patientId, submission(5001))).rejects.toThrow(
      InternalServerErrorException,
    )
    await consumer.savePatientForm(patientId, submission(5001))
  })

  test("AoE answers against an appointment (submitPatientForm)", async () => {
    const { consumer, backfill, admin } = harness()
    const patientId = ((await backfill()).createdAccounts[0] as { id: number }).id
    await consumer.submitPatientForm(patientId, 3, [
      { markerId: 102, formName: "aoe-questions", questionId: 1101 },
    ])
    const rounds = (await (await admin("/form-submissions")).json()) as {
      submissions: FormRoundRecord[]
    }
    expect(rounds.submissions[0]).toMatchObject({ formId: 102, patientAppointmentId: 3 })
  })

  test("free slots, booking, and a patient's appointments", async () => {
    const { consumer, backfill } = harness()
    await backfill()
    const slots = await consumer.getAvailableSlotsForCareTalkAppointment({
      firstName: "Ada",
      lastName: "Lovelace",
      zipCode: "84101",
      dateOfBirth: "1985-12-10T00:00:00.000Z",
      date: "2026-10-05",
    })
    expect(slots).toHaveLength(16)
    const slot = slots?.[0] as { doctorId: number; from: string; to: string }
    const id = await consumer.scheduleAppointment({
      doctorId: slot.doctorId,
      patientId: 1,
      from: slot.from,
      to: slot.to,
    })
    expect(id).toBe(1)
    expect(await consumer.getFreeSlots("2026-10-05", 21, 1)).toHaveLength(15)
    await expect(
      consumer.scheduleAppointment({
        doctorId: slot.doctorId,
        patientId: 1,
        from: slot.from,
        to: slot.to,
      }),
      // A 400 fails the response schema, so `data` is null and our client throws BadRequest.
    ).rejects.toThrow("Unable to book appointment on caretalk!")
    expect(await consumer.getPatientAppointments(1)).toEqual([
      expect.objectContaining({
        id: 1,
        eligibilityId: 1,
        startDateTime: slot.from,
        appointmentStatus: 1,
      }),
    ])
    expect(
      await consumer.getAvailableSlotsForCareTalkAppointment({
        firstName: "Nobody",
        lastName: "Here",
        zipCode: "00000",
        dateOfBirth: "2000-01-01",
        date: "2026-10-05",
      }),
    ).toBeNull()
  })

  test("presets: login failure, a gateway page, missing patient, missing form", async () => {
    for (const preset of ["login_failure", "invalid_credentials", "gateway_html", "server_error"]) {
      const { runtime, consumer } = harness()
      runtime.applyPreset(preset, "default", { count: 1 })
      await expect(consumer.getFormByName("health-history")).rejects.toThrow(
        "Failed to fetch form data",
      )
    }
    const { runtime, consumer, backfill } = harness()
    await backfill()
    runtime.applyPreset("patient_not_found", "default", { count: 1 })
    expect(
      await consumer.searchForPatient({
        firstName: "Ada",
        lastName: "Lovelace",
        zipCode: "84101",
        dateOfBirth: "1985-12-10",
      }),
    ).toBe(false)
    runtime.applyPreset("form_not_found", "default", { count: 1 })
    expect(await consumer.getFormByName("health-history")).toEqual([])
    runtime.applyPreset("connection_drop", "default", { count: 1 })
    await expect(consumer.getStateId("UT")).rejects.toThrow(InternalServerErrorException)
    expect(Object.keys(CARETALK_PRESETS)).toEqual(
      expect.arrayContaining(["login_failure", "token_expired", "form_not_found", "save_rejected"]),
    )
  })

  test("restricted credentials: a wrong password cannot log in, a wrong static key is a 401", async () => {
    const { consumer, admin } = harness({ password: "wrong" })
    await admin(
      "/settings",
      {
        users: [{ userName: "acme-api", password: FIXTURE_PASSWORD }],
        apiKeys: ["ct-static-key"],
      },
      "PUT",
    )
    await expect(consumer.getFormByName("health-history")).rejects.toThrow(
      "Failed to fetch form data",
    )
    await expect(
      new CareTalkConsumer({ ...config, apiKey: "nope" }, (i, n) =>
        harness().fetchImpl(i, n),
      ).getFormData("x", 0, 0),
    ).resolves.toEqual([])
    const strict = harness({ apiKey: "nope" })
    await strict.admin("/settings", { apiKeys: ["ct-static-key"] }, "PUT")
    await expect(strict.consumer.getFormData("health-history", 0, 1)).rejects.toThrow(
      /Failed to fetch form data/,
    )
  })

  test("namespaces by API user, header and /ns/ prefix; the journal never holds patient data", async () => {
    const { runtime, admin, fetchImpl } = harness()
    await admin("/credentials", { credentials: { "worker-a": "a", "worker-b": "b" } }, "PUT")
    const worker = (userName: string, apiUrl = API) =>
      new CareTalkConsumer({ ...config, userName, apiUrl }, fetchImpl, runtime.clock.now)
    const a = worker("worker-a")
    await a.createAccountForExistingUsers([ada], () => 7)
    const probe = {
      firstName: "Ada",
      lastName: "Lovelace",
      zipCode: "84101",
      dateOfBirth: "1985-12-10",
    }
    expect(await a.searchForPatient(probe)).not.toBe(false)
    expect(await worker("worker-b").searchForPatient(probe)).toBe(false)
    expect(await worker("someone", `${API}/ns/a`).searchForPatient(probe)).not.toBe(false)
    const viaHeader = await runtime.fetch(
      new Request(`${API}/externalapi/States`, {
        headers: { authorization: "Bearer ct-static-key", "x-mockingbird-namespace": "a" },
      }),
    )
    expect(viaHeader.headers.get("x-mockingbird")).toMatch(/^caretalk@.*; ns=a$/)
    const journal = await (
      await runtime.fetch(new Request(`${API}/__admin/requests?namespace=a`))
    ).json()
    expect(JSON.stringify(journal)).not.toContain("Lovelace")
    expect(JSON.stringify(journal)).not.toContain("1985")
  })
})

describe("served over HTTP", () => {
  test("our client works against the node server with plain fetch", async () => {
    const server = await createServer()
    try {
      const consumer = new CareTalkConsumer({ ...config, apiUrl: server.url }, (input, init) =>
        fetch(input, init),
      )
      expect(consumer.transformFormData(await consumer.getFormByName("health-history")).id).toBe(
        101,
      )
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^caretalk@/)
    } finally {
      await server.close()
    }
  })
})
