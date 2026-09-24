import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/**
 * One Healthie user (patient or provider). Passwords are kept only so `signIn` and the
 * password-change variant of `updateUser` can check them; the journal never sees them.
 */
export type UserRecord = {
  id: string
  role: "patient" | "provider"
  active: boolean
  email: string
  password: string
  first_name: string
  last_name: string
  legal_name: string | null
  dob: string | null
  gender: string | null
  phone_number: string | null
  timezone: string | null
  metadata: string | null
  qualifications: string | null
  dietitian_id: string | null
  other_provider_ids: string[]
  user_group_id: string | null
  location_id: string | null
  avatar_file_id: string | null
  last_conversation_id: string | null
  seen_welcome: boolean
  seen_onboarding_complete_page: boolean
  stripe_customer_detail: {
    id: string
    card_type: string
    card_type_label: string
    last_four: string
    stripe_id: string
    expiration: string
  } | null
  created_at: string
  updated_at: string
}

export type ApiKeyRecord = { key: string; user_id: string; created_at: string }

export type LocationRecord = {
  id: string
  user_id: string | null
  name: string | null
  line1: string | null
  line2: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
}

/** The bytes behind a document or an avatar (base64 in SQLite; served at `/files/<token>`). */
export type FileRecord = {
  id: string
  filename: string
  content_type: string
  base64: string
  size: number
}

export type DocumentRecord = {
  id: string
  display_name: string
  file_content_type: string
  file_id: string
  folder_id: string | null
  owner_id: string
  rel_user_id: string | null
  share_user_ids: string[]
  opens: number
  created_at: string
  updated_at: string
}

export type FolderRecord = {
  id: string
  name: string
  folder_id: string | null
  owner_id: string
  rel_user_id: string | null
  share_user_ids: string[]
  created_at: string
}

export type CustomModule = { id: string; label: string; mod_type: string }

export type CustomModuleFormRecord = { id: string; name: string; custom_modules: CustomModule[] }

export type FormAnswerRecord = {
  id: string
  custom_module_id: string
  label: string
  answer: string
  displayed_answer: string
}

export type FormAnswerGroupRecord = {
  id: string
  name: string
  user_id: string
  filler_id: string
  custom_module_form_id: string
  finished: boolean
  form_answers: FormAnswerRecord[]
  created_at: string
  updated_at: string
}

export type RequestedFormRecord = {
  id: string
  recipient_id: string
  sender_id: string
  custom_module_form_id: string
  status: string
  created_at: string
}

export type OfferingRecord = {
  id: string
  name: string
  description: string | null
  billing_frequency: string
  currency: string
  price: string
  visibility_status: string
}

export type BillingItemRecord = {
  id: string
  amount_paid: string
  state: string
  is_canceled: boolean
  is_recurring: boolean
  is_paused: boolean
  note: string | null
  offering_id: string | null
  sender_id: string
  recipient_id: string | null
  stripe_charge_id: string | null
  next_payment_date: string | null
  billing_frequency: string | null
  created_at: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** Organization API keys (the app's `HEALTHIE_API_AUTH_TOKEN`), bound to the org admin. */
  orgApiKeys: string[]
  /** When set, `signIn` with a different `namespace` finds no user (Healthie's sub-orgs). */
  namespace: string | null
  /** How long an `expiring_url` stays valid, on the mock clock. Default 5 min (S3 presign). */
  expiringUrlSeconds: number
}

export const DEFAULT_SETTINGS: Settings = {
  orgApiKeys: ["gh_sbox_org_api_key"],
  namespace: null,
  expiringUrlSeconds: 300,
}

/** Stable ids of the seeded rows (tests and parity walks refer to them). */
export const SEED = {
  orgAdminId: "100001",
  dietitianId: "100002",
  patientId: "100003",
  patientEmail: "patient@healthie.mock",
  patientPassword: "Password123!",
  adminEmail: "admin@healthie.mock",
  membershipOfferingId: "200001",
  addonOfferingId: "200002",
  intakeFormId: "300001",
} as const

export class HealthieState {
  readonly users: Collection<UserRecord>
  readonly apiKeys: Collection<ApiKeyRecord>
  readonly locations: Collection<LocationRecord>
  readonly files: Collection<FileRecord>
  readonly documents: Collection<DocumentRecord>
  readonly folders: Collection<FolderRecord>
  readonly forms: Collection<CustomModuleFormRecord>
  readonly formAnswerGroups: Collection<FormAnswerGroupRecord>
  readonly requestedForms: Collection<RequestedFormRecord>
  readonly offerings: Collection<OfferingRecord>
  readonly billingItems: Collection<BillingItemRecord>
  readonly settings: Collection<Settings>
  private readonly counters: Collection<number>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: { settings: Partial<Settings>; timestamp: () => string },
  ) {
    this.users = new Collection(sqlite, namespace, "users")
    this.apiKeys = new Collection(sqlite, namespace, "api_keys")
    this.locations = new Collection(sqlite, namespace, "locations")
    this.files = new Collection(sqlite, namespace, "files")
    this.documents = new Collection(sqlite, namespace, "documents")
    this.folders = new Collection(sqlite, namespace, "folders")
    this.forms = new Collection(sqlite, namespace, "custom_module_forms")
    this.formAnswerGroups = new Collection(sqlite, namespace, "form_answer_groups")
    this.requestedForms = new Collection(sqlite, namespace, "requested_forms")
    this.offerings = new Collection(sqlite, namespace, "offerings")
    this.billingItems = new Collection(sqlite, namespace, "billing_items")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.counters = new Collection(sqlite, namespace, "counters")
    this.ensureSeeded()
  }

  /**
   * Healthie ids are numeric strings. Each kind counts from its own base (users 100001…,
   * offerings 200001…, forms 300001…, billing items 400001…, folders 500001…, documents
   * 600001…, locations 700001…, form answer groups 800001…, requested forms 900001…).
   */
  nextId(kind: keyof typeof ID_BASES): string {
    const next = (this.counters.get(kind) ?? 0) + 1
    this.counters.insert(kind, next)
    return String(ID_BASES[kind] + next)
  }

  current(): Settings {
    return this.settings.get("settings") ?? { ...DEFAULT_SETTINGS, ...this.seed.settings }
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  /** Seed the org admin, a dietitian, a demo patient, offerings and an intake form. */
  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
    }
    if (this.users.count() > 0) return
    this.addUser({
      role: "provider",
      email: SEED.adminEmail,
      password: "Admin123!",
      first_name: "Acme",
      last_name: "Admin",
      qualifications: "Organization admin",
    })
    const dietitian = this.addUser({
      role: "provider",
      email: "dietitian@healthie.mock",
      password: "Dietitian123!",
      first_name: "Dana",
      last_name: "Rivera",
      qualifications: "MD",
      timezone: "America/Phoenix",
    })
    this.addUser({
      role: "patient",
      email: SEED.patientEmail,
      password: SEED.patientPassword,
      first_name: "Pat",
      last_name: "Member",
      dietitian_id: dietitian.id,
      timezone: "America/Phoenix",
      metadata: JSON.stringify({ has_scheduled_bloodwork: false }),
    })
    this.addOffering({
      name: "Acme Membership",
      description: null,
      billing_frequency: "Monthly",
      currency: "usd",
      price: "149.0",
      visibility_status: "visible",
    })
    this.addOffering({
      name: "Bloodwork Add-on",
      description: null,
      billing_frequency: "One-Time",
      currency: "usd",
      price: "99.0",
      visibility_status: "hidden",
    })
    const formId = this.nextId("form")
    this.forms.insert(formId, {
      id: formId,
      name: "Intake form",
      custom_modules: [
        { id: "310001", label: "Primary health goal", mod_type: "text" },
        { id: "310002", label: "Current medications", mod_type: "textarea" },
      ],
    })
  }

  addOffering(input: Omit<OfferingRecord, "id">): OfferingRecord {
    const offering = { id: this.nextId("offering"), ...input }
    this.offerings.insert(offering.id, offering)
    return offering
  }

  addUser(input: {
    role: UserRecord["role"]
    email: string
    password: string
    first_name: string
    last_name: string
    active?: boolean
    qualifications?: string
    dietitian_id?: string
    timezone?: string
    metadata?: string
    phone_number?: string
    dob?: string
    gender?: string
  }): UserRecord {
    const at = this.seed.timestamp()
    const user: UserRecord = {
      id: this.nextId("user"),
      role: input.role,
      active: input.active ?? true,
      email: input.email.toLowerCase(),
      password: input.password,
      first_name: input.first_name,
      last_name: input.last_name,
      legal_name: null,
      dob: input.dob ?? null,
      gender: input.gender ?? null,
      phone_number: input.phone_number ?? null,
      timezone: input.timezone ?? null,
      metadata: input.metadata ?? null,
      qualifications: input.qualifications ?? null,
      dietitian_id: input.dietitian_id ?? null,
      other_provider_ids: [],
      user_group_id: null,
      location_id: null,
      avatar_file_id: null,
      last_conversation_id: null,
      seen_welcome: false,
      seen_onboarding_complete_page: false,
      stripe_customer_detail: null,
      created_at: at,
      updated_at: at,
    }
    this.users.insert(user.id, user)
    return user
  }

  userByEmail(email: string): UserRecord | undefined {
    const wanted = email.trim().toLowerCase()
    return this.users.list({ where: (u) => u.email === wanted }).at(0)?.value
  }

  /** The user an API key belongs to; org keys resolve to the org admin. */
  userForKey(key: string): UserRecord | undefined {
    if (this.current().orgApiKeys.includes(key)) return this.orgAdmin()
    const bound = this.apiKeys.get(key)
    return bound ? this.users.get(bound.user_id) : undefined
  }

  orgAdmin(): UserRecord | undefined {
    return this.users.list({ where: (u) => u.role === "provider", order: "oldest" }).at(0)?.value
  }
}

const ID_BASES = {
  user: 100_000,
  offering: 200_000,
  form: 300_000,
  billing_item: 400_000,
  folder: 500_000,
  document: 600_000,
  location: 700_000,
  form_answer_group: 800_000,
  requested_form: 900_000,
  file: 1_000_000,
  form_answer: 1_100_000,
  api_key: 0,
} as const
