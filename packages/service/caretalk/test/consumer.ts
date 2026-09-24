/**
 * A port of our backend's CareTalk client (`apps/backend/src/modules/global-services/services/
 * caretalk/caretalk-client.service.ts` with its zod schemas from `caretalk.types.ts`, and the
 * form-submission transform in its forms adapter `form-adapters.ts`): the same paths,
 * headers, token cache (Redis, 3600 s), the one-shot re-login on 401, the `safeParse` →
 * `data: null` behaviour, "400 means no such patient", and `transformFormData`.
 *
 * Differences from the app, all at the seams: the base URL is injected (the app reads
 * `CARETALK_API_URL`, https-only, and `getFormData` hardcodes `https://api.caretalkbeta.com`),
 * Redis is an in-memory map on an injected clock, and Nest exceptions are plain `Error`s with
 * the same messages. The zod schemas are hand-ported as field/type checks.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class InternalServerErrorException extends Error {}
export class BadRequestException extends Error {}

type Kind = "string" | "number" | "boolean" | "array" | "null" | "unknown"
type Shape = Record<string, Kind | `${Kind}|null`>

/** A `z.object(...)` check: every key present with its type (nullable where marked). */
const matches = (value: unknown, shape: Shape): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.entries(shape).every(([key, kind]) => {
    const v = record[key]
    const [base, nullable] = kind.split("|") as [Kind, string | undefined]
    if (v === null) return nullable === "null" || base === "null" || base === "unknown"
    if (base === "unknown") return key in record
    if (base === "array") return Array.isArray(v)
    return typeof v === base
  })
}

type Schema<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } }
}
const schema = <T>(check: (value: unknown) => boolean): Schema<T> => ({
  safeParse: (value) =>
    check(value)
      ? { success: true, data: value as T }
      : { success: false, error: { message: "Invalid response shape" } },
})

export const AuthResponseSchema = schema<{ token: string }>((v) => matches(v, { token: "string" }))
export const SearchForPatientResponseSchema = schema<{
  isExists: boolean
  eligibleId: number
  programId: number
}>((v) => matches(v, { isExists: "boolean", eligibleId: "number", programId: "number" }))
const StateArraySchema = schema<{ id: number; abbreviation: string }[]>(
  (v) => Array.isArray(v) && v.every((s) => matches(s, { id: "number", abbreviation: "string" })),
)
export const InsertCareTalkUserResponseSchema = schema<{ id: number } & Record<string, unknown>>(
  (v) =>
    matches(v, {
      firstName: "string|null",
      lastName: "string|null",
      email: "string|null",
      dateOfBirth: "string|null",
      gender: "number|null",
      userStateId: "number|null",
      userState: "string|null",
      zipCode: "string|null",
      recordStatus: "string",
      recordId: "string|null",
      height: "number|null",
      programId: "number",
      eligibilityId: "number|null",
      clientId: "number",
      hG_P360_Retrieve_location: "string|null",
      patientMedications: "array|null",
      patientAppointment: "unknown",
      formRounds: "array|null",
      id: "number",
      createdAt: "string",
      updatedAt: "string|null",
      deletedAt: "string|null",
    }),
)
const FreeSlotShape: Shape = {
  id: "number",
  medicalSpecialty: "string|null",
  doctorId: "number",
  doctorName: "string",
  doctor: "string|null",
  doctorUid: "number|null",
  timeZone: "string",
  offset: "number|null",
  from: "string",
  to: "string",
}
export type FreeSlot = {
  id: number
  doctorId: number
  doctorName: string
  from: string
  to: string
}
export const GetFreeSlotsResponseSchema = schema<FreeSlot[]>(
  (v) => Array.isArray(v) && v.every((s) => matches(s, FreeSlotShape)),
)
export const ScheduleAppointmentResponseSchema = schema<{ id: number; eligibilityId: number }>(
  (v) =>
    matches(v, {
      id: "number",
      patientId: "null",
      eligibilityId: "number",
      appointmentStatus: "number",
      physicianId: "number",
    }),
)
export const GetCareTalkAppointmentResponseSchema = schema<{ id: number; startDateTime: string }[]>(
  (v) =>
    Array.isArray(v) &&
    v.every((a) =>
      matches(a, {
        id: "number",
        patientId: "number|null",
        eligibilityId: "number",
        createdAt: "string",
        appointmentStatus: "number",
        physicianId: "number",
        startDateTime: "string",
        endDateTime: "string",
      }),
    ),
)
export const FormSubmissionResponseSchema = schema<{ success: boolean; message?: string }>((v) =>
  matches(v, { success: "boolean" }),
)

/** `caretalk-forms.type.ts` (the fields our transform reads). */
export type CareTalkForm = {
  formRoundId: number
  patientAppointmentId: number | null
  submitDate: string | null
  fullFormDto: {
    id: number
    name: string
    slug: string
    description: string | null
    groups: {
      id: number
      name: string
      groupQuestions: {
        questionId: number
        question: {
          id: number
          questionText: string
          answerTypeId: number
          answerText: string | null
          questionAnswers: {
            id: number
            answer: string
            complexity: number | null
            isChecked: boolean
            freeAnswerText: string | null
          }[]
        }
      }[]
    }[]
  }
}

export type CareTalkFormSubmission = {
  fullFormDto: {
    id: number
    name: string
    groups: {
      groupQuestions: {
        questionId: number
        question: {
          id: number
          questionAnswers: { id: number; answer: string; freeAnswerText?: string }[]
        }
      }[]
    }[]
  }
}

/** `Form` / `Question` from `storefront/types/form.types` (what `transformFormData` builds). */
export type TransformedQuestion = {
  id: number
  label: string
  type: "text" | "choice" | "display_text" | "multiple_choice"
  placeholder?: string
  options?: { id: string; value: string; label: string; requiresTextualAnswer: boolean }[]
}

type ApiResponse<T> = { data: T | null; status: number; message?: string }

export type CareTalkConfig = {
  apiUrl: string
  userName: string
  password: string
  apiKey: string
  programId: number
}

export const CARE_TALK_TOKEN_TTL = 3600

export const formatPhoneNumberForCareTalk = (phone: string) =>
  phone.replace(/^\+1[\s]?(\d{3})[\s]?(\d{3})[\s]?(\d{4})$/, "($1) $2-$3")

/** `CareTalkClientService`. */
export class CareTalkConsumer {
  private cache: { token: string; expiresAt: number } | null = null
  readonly errors: string[] = []

  constructor(
    private readonly config: CareTalkConfig,
    private readonly fetchImpl: Fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** `getAuthToken`: Redis-cached for `CARE_TALK_TOKEN_TTL` seconds. */
  async getAuthToken(): Promise<string> {
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache.token
    const response = await this.fetchImpl(`${this.config.apiUrl}/externalapi/Auth/client-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify({ userName: this.config.userName, password: this.config.password }),
    })
    if (!response.ok) throw new Error("Failed to get auth token")
    const parsed = AuthResponseSchema.safeParse(await response.json())
    if (!parsed.success) throw new Error(parsed.error.message)
    this.cache = { token: parsed.data.token, expiresAt: this.now() + CARE_TALK_TOKEN_TTL * 1000 }
    return parsed.data.token
  }

  private async makeApiRequest<T>(
    endpoint: string,
    options: { schema: Schema<T>; config?: { method?: string; body?: string } },
  ): Promise<ApiResponse<T>> {
    try {
      let token = await this.getAuthToken()
      const config = {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } as Record<
          string,
          string
        >,
        ...(options.config ?? {}),
      }
      const response = await this.fetchImpl(`${this.config.apiUrl}${endpoint}`, config)
      if (response.status === 401) {
        this.cache = null
        token = await this.getAuthToken()
        config.headers.Authorization = `Bearer ${token}`
        const retryResponse = await this.fetchImpl(`${this.config.apiUrl}${endpoint}`, config)
        if (!retryResponse.ok) throw new Error("API request failed after token refresh")
        const parsedRetry = options.schema.safeParse(await retryResponse.json())
        return {
          data: parsedRetry.success ? parsedRetry.data : null,
          status: retryResponse.status,
          message: parsedRetry.success ? response.statusText : parsedRetry.error.message,
        }
      }
      const parsed = options.schema.safeParse(await response.json())
      return {
        data: parsed.success ? parsed.data : null,
        status: response.status,
        message: parsed.success ? response.statusText : parsed.error.message,
      }
    } catch (error) {
      this.errors.push(`API request failed: ${endpoint}`)
      this.errors.push(error instanceof Error ? error.message : String(error))
      throw new InternalServerErrorException("Failed to make API request")
    }
  }

  async searchForPatient(params: {
    firstName: string
    lastName: string
    zipCode: string
    dateOfBirth: string
  }) {
    const response = await this.makeApiRequest(
      `/externalapi/Patients/SearchForPatient?FirstName=${encodeURIComponent(params.firstName)}&LastName=${encodeURIComponent(params.lastName)}&zipCode=${encodeURIComponent(params.zipCode)}&DateOfBirth=${encodeURIComponent(params.dateOfBirth)}`,
      { schema: SearchForPatientResponseSchema },
    )
    if (response.status === 400) return false
    const parsed = SearchForPatientResponseSchema.safeParse(response.data)
    if (!parsed.success) throw new Error("Invalid response format from CareTalk API")
    return parsed.data
  }

  async getStateId(state: string): Promise<number> {
    const response = await this.makeApiRequest("/externalapi/States", { schema: StateArraySchema })
    if (!response.data) throw new BadRequestException("Unable to get states from caretalk!")
    const found = response.data.find((s) => s.abbreviation === state)
    if (!found) throw new BadRequestException("Invalid State")
    return found.id
  }

  async insertPatient(data: Record<string, unknown>) {
    const response = await this.makeApiRequest("/externalapi/Patients", {
      schema: InsertCareTalkUserResponseSchema,
      config: { method: "POST", body: JSON.stringify(data) },
    })
    if (!response.data) throw new BadRequestException("Unable to add patient to caretalk!")
    return response.data
  }

  mapGenderForCareTalk(gender: string) {
    switch (gender.toLowerCase()) {
      case "male":
        return 1
      case "female":
        return 2
      default:
        return 0
    }
  }

  /** `getFormData`: the static `CARETALK_API_KEY` as the bearer, no re-login. */
  async getFormData(formName: string, appointmentId: number, patientId: number) {
    const url = `${this.config.apiUrl}/externalapi/Forms/GetForm/${encodeURIComponent(formName)}?AppointmentId=${appointmentId}&PatientId=${patientId}`
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "*/*",
        "Content-Type": "application/json",
      },
    })
    if (!response.ok) throw new Error(`Failed to fetch form data: ${response.statusText}`)
    return (await response.json()) as CareTalkForm[]
  }

  async getFormByName(formName: string): Promise<CareTalkForm[]> {
    try {
      let token = await this.getAuthToken()
      const config = {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      }
      const baseUrl = `${this.config.apiUrl}/externalapi/Forms/GetForm/${encodeURIComponent(formName)}`
      const response = await this.fetchImpl(baseUrl, config)
      if (response.status === 401) {
        this.cache = null
        token = await this.getAuthToken()
        config.headers.Authorization = `Bearer ${token}`
        const retryResponse = await this.fetchImpl(baseUrl, config)
        if (!retryResponse.ok)
          throw new BadRequestException("API request failed after token refresh")
        return (await retryResponse.json()) as CareTalkForm[]
      }
      if (!response.ok) throw new Error(`API request failed: ${response.statusText}`)
      return (await response.json()) as CareTalkForm[]
    } catch (error) {
      this.errors.push("API request failed for caretalk form data")
      this.errors.push(error instanceof Error ? error.message : String(error))
      throw new InternalServerErrorException("Failed to fetch form data")
    }
  }

  transformFormData(apiResponse: CareTalkForm[]) {
    if (apiResponse.length === 0) throw new Error("Invalid form.")
    const form = (apiResponse[0] as CareTalkForm).fullFormDto
    const questions: TransformedQuestion[] = form.groups.flatMap((group) =>
      group.groupQuestions.map((groupQuestion): TransformedQuestion => {
        const question = groupQuestion.question
        const options = question.questionAnswers.map((answer) => ({
          id: `${answer.id}`,
          value: answer.answer,
          label: answer.answer,
          requiresTextualAnswer: !!answer.complexity,
        }))
        switch (question.answerTypeId) {
          case 1:
            return {
              id: question.id,
              label: question.questionText,
              type: "text",
              placeholder: "Enter your answer",
            }
          case 2:
          case 4:
            return { id: question.id, label: question.questionText, type: "choice", options }
          case 5:
            return {
              id: question.id,
              label: question.questionText,
              type: "display_text",
              placeholder: "Display text",
            }
          default:
            return {
              id: question.id,
              label: question.questionText,
              type: "multiple_choice",
              options,
            }
        }
      }),
    )
    return {
      id: form.id,
      name: form.name,
      description: form.description ?? "No description provided",
      group: "Caretalk",
      version: 1,
      is_active: true,
      questions,
    }
  }

  /** `getFreeSlots`: note the app hardcodes `programId=21` in the URL. */
  async getFreeSlots(date: string, _programId: number, eligibleId: number) {
    const response = await this.makeApiRequest(
      `/externalapi/PatientAppointments/GetFreeSlots?date=${encodeURIComponent(date)}&programId=21&eligibleId=${eligibleId}`,
      { schema: GetFreeSlotsResponseSchema },
    )
    return response.data
  }

  async getAvailableSlotsForCareTalkAppointment(params: {
    firstName: string
    lastName: string
    zipCode: string
    dateOfBirth: string
    date: string
  }) {
    const formattedDob = params.dateOfBirth.slice(0, 10)
    const patient = await this.searchForPatient({ ...params, dateOfBirth: formattedDob })
    if (patient === false) return null
    return this.getFreeSlots(params.date, patient.programId, patient.eligibleId)
  }

  async scheduleAppointment(data: {
    doctorId: number
    patientId: number
    from: string
    to: string
  }) {
    const response = await this.makeApiRequest("/externalapi/PatientAppointments", {
      schema: ScheduleAppointmentResponseSchema,
      config: { method: "POST", body: JSON.stringify(data) },
    })
    if (!response.data) throw new BadRequestException("Unable to book appointment on caretalk!")
    return response.data.id
  }

  async getPatientAppointments(patientId: number) {
    const response = await this.makeApiRequest(
      `/externalapi/PatientAppointments/GetPatientAppointmentsByEligibleId/${patientId}`,
      { schema: GetCareTalkAppointmentResponseSchema },
    )
    return response.data
  }

  /** `savePatientForm`: what the form-submission queue calls. */
  async savePatientForm(patientId: number, answers: CareTalkFormSubmission) {
    try {
      const response = await this.makeApiRequest(
        `/externalapi/Forms/SavePatientForm?patientId=${patientId}`,
        {
          schema: FormSubmissionResponseSchema,
          config: { method: "POST", body: JSON.stringify(answers) },
        },
      )
      if (response.status !== 200)
        throw new Error(`Failed to submit patient form: ${response.message}`)
    } catch (error) {
      this.errors.push("Error submitting patient form")
      this.errors.push(error instanceof Error ? error.message : String(error))
      throw new InternalServerErrorException("Error submitting patient form")
    }
  }

  /** `submitPatientForm` (AoE answers against an appointment). */
  async submitPatientForm(
    patientId: number,
    appointmentId: number,
    answers: {
      markerId: number
      formName: string
      questionId: number
      answer?: string
      freeAnswerText?: string
    }[],
  ) {
    try {
      const first = answers[0] as (typeof answers)[number]
      const formAnswers: CareTalkFormSubmission = {
        fullFormDto: {
          id: first.markerId,
          name: first.formName,
          groups: [
            {
              groupQuestions: answers.map((answer) => ({
                questionId: answer.questionId,
                question: {
                  id: answer.questionId,
                  questionAnswers: answer.answer
                    ? [
                        {
                          id: answer.markerId,
                          answer: answer.answer,
                          ...(answer.freeAnswerText && { freeAnswerText: answer.freeAnswerText }),
                        },
                      ]
                    : [],
                },
              })),
            },
          ],
        },
      }
      const response = await this.makeApiRequest(
        `/externalapi/Forms/SavePatientForm?patientId=${patientId}&patientAppointmentId=${appointmentId}`,
        {
          schema: FormSubmissionResponseSchema,
          config: { method: "POST", body: JSON.stringify(formAnswers) },
        },
      )
      if (response.status !== 200)
        throw new Error(`Failed to submit patient form: ${response.message}`)
    } catch (error) {
      this.errors.push("Error submitting patient form")
      this.errors.push(error instanceof Error ? error.message : String(error))
      throw new InternalServerErrorException("Error submitting patient form")
    }
  }

  /**
   * `createAccountForExistingUsers`, for the given users instead of a database read: search,
   * skip existing, resolve the state id, insert (the 2 s pause between users is dropped).
   */
  async createAccountForExistingUsers(
    users: {
      firstName: string
      lastName: string
      email: string
      dob: string
      sex: string
      phoneNumber: string
      address: { line1: string; city: string; state: string; zip: string }
    }[],
    nextRecordId: () => number,
  ) {
    const created: { id: number }[] = []
    for (const user of users) {
      try {
        const [y, m, d] = user.dob.slice(0, 10).split("-")
        const exists = await this.searchForPatient({
          firstName: user.firstName,
          lastName: user.lastName,
          zipCode: user.address.zip,
          dateOfBirth: `${m}/${d}/${y}`,
        })
        if (exists !== false) continue
        const stateId = await this.getStateId(user.address.state)
        const recordId = nextRecordId()
        const result = await this.insertPatient({
          firstName: user.firstName,
          lastName: user.lastName,
          mobilePhone: formatPhoneNumberForCareTalk(user.phoneNumber),
          email: user.email,
          dateOfBirth: `${user.dob.slice(0, 10)}T00:00:00.000Z`,
          gender: this.mapGenderForCareTalk(user.sex),
          address: user.address.line1,
          state: user.address.state,
          city: user.address.city,
          userStateId: stateId,
          programId: this.config.programId,
          zipCode: user.address.zip,
          height: 70,
          weight: 180,
          highBloodPressure: 120,
          lowBloodPressure: 80,
          recordStatus: "Active",
          recordId: `GV-${recordId <= 99 ? recordId.toString().padStart(3, "0") : recordId}`,
          dateFinalized: new Date(this.now()).toISOString(),
          tokenDate: new Date(this.now()).toISOString(),
        })
        created.push(result)
      } catch (error) {
        this.errors.push(`Failed to create CareTalk account for user ${user.email}`)
        this.errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return { message: "CareTalk accounts created for existing users", createdAccounts: created }
  }
}
