import type { FetchAPI } from "@crvouga/mockingbird-core"
import {
  type APIOptions,
  annotateResponse,
  bearerToken,
  bodyIssues,
  bootSqlite,
  createService,
  defineOperations,
  faultEffect,
  fromBase64,
  HttpError,
  issuesByField,
  jsonRes,
  type OperationContext,
  opaqueToken,
  type Service,
  toBase64,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import type { Hono } from "hono"
import { DEFAULT_DOCTORS, type FullFormDto, type QuestionAnswer, US_STATES } from "./forms.js"
import { document, type SupportedOperationId } from "./generated/openapi.js"
import {
  type AppointmentRecord,
  CareTalkState,
  type FormRoundRecord,
  type PatientRecord,
  type Settings,
} from "./state.js"

export type { FetchAPI } from "@crvouga/mockingbird-core"
export type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export type { FormGroup, FullFormDto, Question, QuestionAnswer } from "./forms.js"
export { DEFAULT_DOCTORS, DEFAULT_FORMS, US_STATES } from "./forms.js"
export type { OperationId, SupportedOperationId } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export type { AppointmentRecord, FormRoundRecord, PatientRecord, Settings } from "./state.js"

export const CARETALK_NAMESPACE = "caretalk"

export type CareTalkAPIOptions = APIOptions & {
  /** Form definitions every namespace starts with. Default: {@link DEFAULT_FORMS}. */
  forms?: readonly FullFormDto[]
  settings?: Partial<Settings>
}

const TOKEN_PREFIX = "ct_"

const base64url = (value: string) =>
  toBase64(new TextEncoder().encode(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const fromBase64url = (value: string) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64(value.replace(/-/g, "+").replace(/_/g, "/")),
    )
  } catch {
    return undefined
  }
}

const sign = (userName: string, issuedAt: number) =>
  opaqueToken(`caretalk:${userName}:${issuedAt}`, 32)

/**
 * The API user a bearer token was issued to, or a static API key itself: how credentials map
 * to namespaces (map `CARETALK_USERNAME` and `CARETALK_API_KEY` with `PUT /__admin/credentials`).
 */
export const tokenCredential = (request: Request): string | undefined => {
  const token = bearerToken(request)
  if (!token?.startsWith(TOKEN_PREFIX)) return token
  const [encoded] = token.slice(TOKEN_PREFIX.length).split(".")
  return encoded ? fromBase64url(encoded) : undefined
}

/** ASP.NET Core's validation `ProblemDetails`. */
export const problem = (status: number, title: string, errors?: Record<string, string[]>) =>
  jsonRes(status, {
    type: "https://tools.ietf.org/html/rfc9110#section-15.5.1",
    title,
    status,
    ...(errors ? { errors } : {}),
    traceId: "00-00000000000000000000000000000000-0000000000000000-00",
  })

/** An empty 401 with `WWW-Authenticate`, as ASP.NET's JWT bearer handler answers. */
const unauthorized = (description?: string) =>
  new Response(null, {
    status: 401,
    headers: {
      "www-authenticate": description
        ? `Bearer error="invalid_token", error_description="${description}"`
        : "Bearer",
    },
  })

/** `YYYY-MM-DD` from any date format our client sends (ISO, `YYYY-MM-DD`, `MM/DD/YYYY`). */
export const normalizeDate = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim())
  if (us) return `${us[3]}-${us[1]}-${us[2]}`
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())
  return iso?.[1]
}

const text = (value: unknown) => (typeof value === "string" ? value : null)
const num = (value: unknown) => (typeof value === "number" ? value : null)

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * Stateful mock of CareTalk's external API: a client-login bearer token, form definitions and
 * saved form rounds, patients (search and insert), states, free slots and appointments.
 */
export class CareTalkAPI implements FetchAPI {
  readonly app: Hono
  readonly sqlite: SqliteClient
  readonly state: CareTalkState
  private readonly service: Service
  private readonly now: () => number

  constructor(options: CareTalkAPIOptions = {}) {
    const sqlite = bootSqlite(options.sqlite)
    const namespace = options.namespace ?? CARETALK_NAMESPACE
    this.now = options.now ?? (() => Date.now())
    this.state = new CareTalkState(sqlite, namespace, {
      forms: options.forms ?? [],
      settings: options.settings ?? {},
    })
    const handlers = defineOperations<SupportedOperationId>({
      ClientLogin: (context) => this.login(context),
      GetForm: (context) => this.getForm(context),
      SavePatientForm: (context) => this.saveForm(context),
      SearchForPatient: (context) => this.search(context),
      ListStates: () => jsonRes(200, US_STATES),
      InsertPatient: (context) => this.insertPatient(context),
      GetFreeSlots: (context) => this.freeSlots(context),
      ScheduleAppointment: (context) => this.schedule(context),
      GetPatientAppointments: (context) => {
        const eligibleId = Number(context.params.eligibleId)
        return jsonRes(
          200,
          this.state.appointments
            .list({ order: "oldest", where: (a) => a.eligibilityId === eligibleId })
            .map(({ value: a }) => ({
              id: a.id,
              patientId: this.patient(eligibleId)?.id ?? null,
              eligibilityId: a.eligibilityId,
              createdAt: a.createdAt,
              appointmentStatus: a.appointmentStatus,
              physicianId: a.physicianId,
              startDateTime: a.startDateTime,
              endDateTime: a.endDateTime,
            })),
        )
      },
    })
    this.service = createService({
      document,
      handlers,
      sqlite,
      namespace,
      now: this.now,
      notFound: () => new Response(null, { status: 404 }),
      onError: (error) => {
        if (error instanceof HttpError) return error.toResponse()
        throw error
      },
      before: (context) => {
        if (context.operation.operationId === "ClientLogin") return undefined
        const token = bearerToken(context.request)
        if (!token) return unauthorized()
        if (faultEffect(context.request, "token_expired") !== undefined) {
          return unauthorized("The token expired")
        }
        return this.checkToken(token)
      },
    })
    this.app = this.service.app
    this.sqlite = this.service.sqlite
  }

  fetch(request: Request): Promise<Response> {
    return this.service.fetch(request)
  }

  async reset(): Promise<void> {
    await this.service.reset()
    this.state.ensureSeeded()
  }

  private iso(): string {
    return new Date(this.now()).toISOString().replace("Z", "")
  }

  private checkToken(token: string): Response | undefined {
    const settings = this.state.current()
    if (!token.startsWith(TOKEN_PREFIX)) {
      return settings.apiKeys.length === 0 || settings.apiKeys.includes(token)
        ? undefined
        : unauthorized()
    }
    const [encoded, issued, signature] = token.slice(TOKEN_PREFIX.length).split(".")
    const userName = encoded ? fromBase64url(encoded) : undefined
    const issuedAt = Number(issued)
    if (
      userName === undefined ||
      !Number.isInteger(issuedAt) ||
      signature !== sign(userName, issuedAt)
    ) {
      return unauthorized()
    }
    if (this.now() / 1000 >= issuedAt + settings.tokenTtlSeconds) {
      return unauthorized("The token expired")
    }
    return undefined
  }

  private json(context: OperationContext): Record<string, unknown> {
    const issues = bodyIssues(context)
    if (issues.length > 0) {
      throw new HttpError(400, {
        type: "https://tools.ietf.org/html/rfc9110#section-15.5.1",
        title: "One or more validation errors occurred.",
        status: 400,
        errors: issuesByField(issues),
        traceId: "00-00000000000000000000000000000000-0000000000000000-00",
      })
    }
    return context.body.kind === "json" ? (context.body.value as Record<string, unknown>) : {}
  }

  private login(context: OperationContext): Response {
    const body = this.json(context)
    const users = this.state.current().users
    const userName = String(body.userName)
    if (
      users.length > 0 &&
      !users.some((u) => u.userName === userName && u.password === body.password)
    ) {
      return jsonRes(401, { message: "Invalid username or password." })
    }
    const issuedAt = Math.floor(this.now() / 1000)
    return jsonRes(200, {
      token: `${TOKEN_PREFIX}${base64url(userName)}.${issuedAt}.${sign(userName, issuedAt)}`,
      expiration: new Date((issuedAt + this.state.current().tokenTtlSeconds) * 1000).toISOString(),
    })
  }

  private patient(id: number): PatientRecord | undefined {
    return (
      this.state.patients.get(String(id)) ??
      this.state.patients.list({ where: (p) => p.eligibilityId === id }).at(0)?.value
    )
  }

  private getForm(context: OperationContext): Response {
    if (faultEffect(context.request, "form_not_found") !== undefined) return jsonRes(200, [])
    const form = this.state.findForm(context.params.formName ?? "")
    if (!form) return jsonRes(200, [])
    const patientId = Number(context.query.PatientId ?? Number.NaN)
    const appointmentId = Number(context.query.AppointmentId ?? Number.NaN)
    const round = Number.isInteger(patientId)
      ? this.state.rounds
          .list({
            where: (r) =>
              r.formId === form.id &&
              r.patientId === patientId &&
              (!Number.isInteger(appointmentId) ||
                appointmentId === 0 ||
                r.patientAppointmentId === appointmentId),
          })
          .at(0)?.value
      : undefined
    return annotateResponse(
      jsonRes(200, [
        {
          formRoundId: round?.formRoundId ?? 0,
          patientAppointmentId: round?.patientAppointmentId ?? null,
          submitDate: round?.submitDate ?? null,
          fullFormDto: round ? this.answered(form, round) : form,
        },
      ]),
      {
        ids: {
          formId: String(form.id),
          ...(round ? { formRoundId: String(round.formRoundId) } : {}),
        },
      },
    )
  }

  /** The form with a round's answers checked (and free text echoed), as GetForm returns it. */
  private answered(form: FullFormDto, round: FormRoundRecord): FullFormDto {
    const byQuestion = new Map(round.answers.map((a) => [a.questionId, a]))
    return {
      ...form,
      groups: form.groups.map((group) => ({
        ...group,
        groupQuestions: group.groupQuestions.map((gq) => {
          const saved = byQuestion.get(gq.questionId)
          const answers: QuestionAnswer[] = gq.question.questionAnswers.map((a) => ({
            ...a,
            isChecked: saved?.answerIds.includes(a.id) ?? false,
            freeAnswerText: saved?.freeAnswerText[String(a.id)] ?? null,
          }))
          return {
            ...gq,
            question: {
              ...gq.question,
              answerText:
                gq.question.answerTypeId === 1 ? (saved?.freeAnswerText["0"] ?? null) : null,
              questionAnswers: answers,
            },
          }
        }),
      })),
    }
  }

  private saveForm(context: OperationContext): Response {
    const body = this.json(context)
    if (faultEffect(context.request, "save_rejected") !== undefined) {
      return problem(400, "The form could not be saved.", { form: ["The form is locked."] })
    }
    const patientId = Number(context.query.patientId)
    if (!Number.isInteger(patientId) || !this.state.patients.get(String(patientId))) {
      return problem(404, `Patient ${context.query.patientId} not found.`)
    }
    const submitted = body.fullFormDto as {
      id: number
      groups: {
        groupQuestions: {
          questionId: number
          question: { questionAnswers: { id: number; answer: string; freeAnswerText?: string }[] }
        }[]
      }[]
    }
    const form = this.state.forms.get(String(submitted.id))
    if (!form) return problem(404, `Form ${submitted.id} not found.`)
    const questions = new Map(
      form.groups.flatMap((g) =>
        g.groupQuestions.map((gq) => [gq.questionId, gq.question] as const),
      ),
    )
    const errors: Record<string, string[]> = {}
    const answers: FormRoundRecord["answers"] = []
    submitted.groups.forEach((group, g) => {
      group.groupQuestions.forEach((gq, i) => {
        const path = `fullFormDto.groups[${g}].groupQuestions[${i}]`
        const question = questions.get(gq.questionId)
        if (!question) {
          errors[`${path}.questionId`] = [
            `Question ${gq.questionId} is not part of form ${form.id}.`,
          ]
          return
        }
        const free: Record<string, string> = {}
        const ids: number[] = []
        for (const a of gq.question.questionAnswers) {
          if (question.answerTypeId === 1) {
            free["0"] = a.answer
            continue
          }
          if (!question.questionAnswers.some((option) => option.id === a.id)) {
            errors[`${path}.question.questionAnswers`] = [
              `Answer ${a.id} is not an option of question ${question.id}.`,
            ]
            return
          }
          ids.push(a.id)
          if (a.freeAnswerText) free[String(a.id)] = a.freeAnswerText
        }
        if ((question.answerTypeId === 2 || question.answerTypeId === 4) && ids.length > 1) {
          errors[`${path}.question.questionAnswers`] = [`Question ${question.id} takes one answer.`]
          return
        }
        answers.push({ questionId: question.id, answerIds: ids, freeAnswerText: free })
      })
    })
    if (Object.keys(errors).length > 0) {
      return problem(400, "One or more validation errors occurred.", errors)
    }
    const appointment = context.query.patientAppointmentId
    const round: FormRoundRecord = {
      formRoundId: this.state.next("round"),
      formId: form.id,
      patientId,
      patientAppointmentId: appointment === undefined ? null : Number(appointment),
      submitDate: this.iso(),
      answers,
    }
    this.state.rounds.insert(String(round.formRoundId), round)
    return annotateResponse(jsonRes(200, { success: true, message: "Form saved successfully." }), {
      ids: {
        patientId: String(patientId),
        formId: String(form.id),
        formRoundId: String(round.formRoundId),
      },
    })
  }

  private search(context: OperationContext): Response {
    const miss = () => jsonRes(400, { isExists: false, message: "Patient not found." })
    if (faultEffect(context.request, "patient_not_found") !== undefined) return miss()
    const q = context.query
    const first = String(q.FirstName ?? "")
      .trim()
      .toLowerCase()
    const last = String(q.LastName ?? "")
      .trim()
      .toLowerCase()
    const zip = String(q.zipCode ?? "").trim()
    const dob = normalizeDate(q.DateOfBirth)
    if (!first || !last || !zip || !dob) return miss()
    const found = this.state.patients
      .list({ order: "oldest" })
      .map((r) => r.value)
      .find(
        (p) =>
          p.firstName?.toLowerCase() === first &&
          p.lastName?.toLowerCase() === last &&
          p.zipCode === zip &&
          normalizeDate(p.dateOfBirth) === dob,
      )
    if (!found) return miss()
    return annotateResponse(
      jsonRes(200, { isExists: true, eligibleId: found.eligibilityId, programId: found.programId }),
      { ids: { patientId: String(found.id) } },
    )
  }

  /** Create a patient, echoing CareTalk's full patient record. */
  addPatient(body: Record<string, unknown>): PatientRecord {
    const id = this.state.next("patient")
    const phone = text(body.mobilePhone)
    const stateId = num(body.userStateId)
    const patient: PatientRecord = {
      firstName: text(body.firstName),
      middleInitial: text(body.middleInitial),
      lastName: text(body.lastName),
      mobilePhone: phone,
      homePhone: text(body.homePhone),
      token: text(body.token),
      tokenDate: text(body.tokenDate),
      apptStatus: text(body.apptStatus),
      email: text(body.email),
      dateOfBirth: text(body.dateOfBirth),
      gender: num(body.gender),
      address: text(body.address),
      state: text(body.state),
      city: text(body.city),
      userStateId: stateId,
      userState: US_STATES.find((s) => s.id === stateId)?.name ?? null,
      zipCode: text(body.zipCode),
      recordStatus: text(body.recordStatus) ?? "Active",
      clientStatus: text(body.clientStatus),
      clientBatchId: text(body.clientBatchId),
      authorization: typeof body.authorization === "boolean" ? body.authorization : null,
      mbi: null,
      ssn: null,
      mspPatientId: null,
      recordId: text(body.recordId),
      height: num(body.height),
      weight: num(body.weight),
      highBloodPressure: num(body.highBloodPressure),
      lowBloodPressure: num(body.lowBloodPressure),
      dateFinalized: text(body.dateFinalized),
      programId: num(body.programId) ?? this.state.current().programId,
      eligibilityId: id,
      clientId: 1,
      fileId: null,
      oldId: null,
      formattedUserMobile: phone ? phone.replace(/\D/g, "") : null,
      planName: null,
      healthGorillaId: text(body.healthGorillaId),
      hG_P360_Retrieve_location: null,
      hG_P360_Retrieve_Status: null,
      hG_P360_Retrieve_json: null,
      program: null,
      client: null,
      patientMedications: null,
      patientDiagnostics: null,
      patientAppointments: null,
      patientAppointment: null,
      formRounds: null,
      id,
      createdAt: this.iso(),
      updatedAt: null,
      deletedAt: null,
    }
    this.state.patients.insert(String(id), patient)
    return patient
  }

  private insertPatient(context: OperationContext): Response {
    const patient = this.addPatient(this.json(context))
    return annotateResponse(jsonRes(200, patient), { ids: { patientId: String(patient.id) } })
  }

  /** Every 30-minute slot 09:00–16:30 per doctor on a date, minus booked ones. */
  slots(date: string) {
    const booked = new Set(
      this.state.appointments.list().map((r) => `${r.value.physicianId}@${r.value.startDateTime}`),
    )
    const day = Number(date.replace(/-/g, "")) % 1_000_000
    return DEFAULT_DOCTORS.flatMap((doctor) =>
      Array.from({ length: 8 }, (_, i) => {
        const hour = 9 + i
        const from = `${date}T${pad(hour)}:00:00`
        return {
          id: doctor.doctorId * 100_000_000 + day * 100 + hour,
          medicalSpecialty: doctor.medicalSpecialty,
          doctorId: doctor.doctorId,
          doctorName: doctor.doctorName,
          doctor: null,
          doctorUid: null,
          timeZone: "Mountain Standard Time",
          offset: -7,
          from,
          to: `${date}T${pad(hour)}:30:00`,
        }
      }).filter((slot) => !booked.has(`${slot.doctorId}@${slot.from}`)),
    )
  }

  private freeSlots(context: OperationContext): Response {
    const date = String(context.query.date ?? "")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return problem(400, "One or more validation errors occurred.", {
        date: [`The value '${date}' is not valid.`],
      })
    }
    if (!this.patient(Number(context.query.eligibleId))) {
      return problem(400, "Eligible patient not found.")
    }
    return jsonRes(200, this.slots(date))
  }

  private schedule(context: OperationContext): Response {
    const body = this.json(context)
    const eligibility = Number(body.patientId)
    const patient = this.patient(eligibility)
    if (!patient) return problem(400, "Eligible patient not found.")
    const doctorId = Number(body.doctorId)
    const from = String(body.from)
    const slot = this.slots(from.slice(0, 10)).find(
      (s) => s.doctorId === doctorId && s.from === from,
    )
    if (!slot) {
      return problem(400, "The selected slot is not available.", {
        from: [`Doctor ${doctorId} has no free slot at ${from}.`],
      })
    }
    const appointment: AppointmentRecord = {
      id: this.state.next("appointment"),
      eligibilityId: patient.eligibilityId,
      physicianId: doctorId,
      appointmentStatus: 1,
      startDateTime: from,
      endDateTime: String(body.to),
      createdAt: this.iso(),
    }
    this.state.appointments.insert(String(appointment.id), appointment)
    return annotateResponse(
      jsonRes(200, {
        id: appointment.id,
        patientId: null,
        eligibilityId: appointment.eligibilityId,
        appointmentStatus: appointment.appointmentStatus,
        physicianId: appointment.physicianId,
      }),
      { ids: { appointmentId: String(appointment.id) } },
    )
  }

  /** Change an appointment's status code (e.g. 3 cancelled), as CareTalk staff would. */
  setAppointmentStatus(id: number, status: number): AppointmentRecord | undefined {
    const appointment = this.state.appointments.get(String(id))
    if (!appointment) return undefined
    const next = { ...appointment, appointmentStatus: status }
    this.state.appointments.update(String(id), next)
    return next
  }

  upsertForm(form: FullFormDto): FullFormDto {
    this.state.forms.insert(String(form.id), form)
    return form
  }

  rounds(): FormRoundRecord[] {
    return this.state.rounds.list({ order: "oldest" }).map((r) => r.value)
  }

  patients(): PatientRecord[] {
    return this.state.patients.list({ order: "oldest" }).map((r) => r.value)
  }
}

export type { CareTalkRuntime, CareTalkRuntimeOptions } from "./runtime.js"
export { CARETALK_PRESETS, createRuntime } from "./runtime.js"
