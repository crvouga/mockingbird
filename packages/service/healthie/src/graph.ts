import { opaqueToken, toBase64 } from "@crvouga/mockingbird-service"
import { GraphQLError } from "graphql"
import { Upload } from "./schema.js"
import type {
  BillingItemRecord,
  DocumentRecord,
  FolderRecord,
  FormAnswerGroupRecord,
  HealthieState,
  LocationRecord,
  OfferingRecord,
  RequestedFormRecord,
  UserRecord,
} from "./state.js"

/** A webhook Healthie would send: `{resource_id, resource_id_type, event_type}`. */
export type HealthieEvent = {
  resource_id: string
  resource_id_type: string
  event_type: string
  changed_fields?: string[]
}

/** What resolvers need from the instance for one request. */
export type GraphContext = {
  state: HealthieState
  viewer: UserRecord | undefined
  /** Healthie-formatted timestamp on the mock clock. */
  timestamp: () => string
  /** Absolute signed URL for a stored file (documents' `expiring_url`, avatars). */
  fileUrl: (fileId: string) => string
  emit: (event: HealthieEvent) => void
  /** Ids touched by this request, for the journal (never bodies). */
  touched: Record<string, string>
  /** Named misbehaviours switched on by fault presets for this request. */
  effects: {
    currentUserNull: boolean
    validationMessages: boolean
  }
}

type Args = Record<string, unknown>
type Input = Record<string, unknown>
type FieldError = { field: string; message: string }

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined

const has = (input: Input, key: string) => Object.hasOwn(input, key) && input[key] !== undefined

const denied = (message = "You do not have permission to access this resource") =>
  new GraphQLError(message)

const signedIn = (ctx: GraphContext): UserRecord => {
  if (!ctx.viewer) throw denied("You must be logged in to perform this action")
  return ctx.viewer
}

const isProvider = (user: UserRecord | undefined) => user?.role === "provider"

/** A patient sees itself and its care team; providers (the org) see everyone. */
const canSeeUser = (viewer: UserRecord | undefined, target: UserRecord) =>
  viewer !== undefined &&
  (isProvider(viewer) ||
    viewer.id === target.id ||
    viewer.dietitian_id === target.id ||
    viewer.other_provider_ids.includes(target.id))

/** `share_users: "user-12,user-34"` (Healthie's format) → `["12", "34"]`. */
export const parseShareUsers = (value: unknown): string[] =>
  (str(value) ?? "")
    .split(",")
    .map((part) => part.trim().replace(/^user-/, ""))
    .filter((id) => /^\d+$/.test(id))

const SHARING_FILTERS = new Set(["all", "shared", "own", "owned", "uploaded"])

const sortRows = <T extends { created_at: string; id: string }>(
  rows: T[],
  sortBy: unknown,
  name: (row: T) => string,
): T[] => {
  const sort = (str(sortBy) ?? "newestfirst").toLowerCase().replace(/[^a-z]/g, "")
  const byCreated = (a: T, b: T) =>
    a.created_at === b.created_at
      ? Number(a.id) - Number(b.id)
      : a.created_at < b.created_at
        ? -1
        : 1
  const copy = [...rows]
  if (sort === "oldestfirst" || sort === "createdatasc" || sort === "oldest")
    return copy.sort(byCreated)
  if (sort.startsWith("namea") || sort === "name") {
    return copy.sort((a, b) => name(a).localeCompare(name(b)))
  }
  if (sort.startsWith("named")) return copy.sort((a, b) => name(b).localeCompare(name(a)))
  return copy.sort((a, b) => byCreated(b, a))
}

let zones: Set<string> | undefined
/** IANA zones (Healthie validates `timezone` against its list of Rails/IANA names). */
const isTimezone = (value: string) => {
  zones ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC", "Etc/UTC"])
  return zones.has(value)
}

const DOB = /^\d{4}-\d{2}-\d{2}$/

/** Field checks shared by updateUser / updateClient, in Healthie's `messages` shape. */
const profileIssues = (input: Input): FieldError[] => {
  const issues: FieldError[] = []
  const dob = str(input.dob)
  if (dob !== undefined && dob !== "" && !DOB.test(dob)) {
    issues.push({ field: "dob", message: "Date of birth is invalid" })
  }
  const phone = str(input.phone_number)
  if (phone !== undefined && phone !== "") {
    const digits = phone.replace(/\D/g, "")
    if (digits.length < 10 || digits.length > 11) {
      issues.push({ field: "phone_number", message: "Phone number is invalid" })
    }
  }
  const timezone = str(input.timezone)
  if (timezone !== undefined && timezone !== "" && !isTimezone(timezone)) {
    issues.push({ field: "timezone", message: "Timezone is not included in the list" })
  }
  const email = str(input.email)
  if (email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    issues.push({ field: "email", message: "Email is invalid" })
  }
  return issues
}

const FORCED_MESSAGES: FieldError[] = [
  { field: "base", message: "Something went wrong while saving. Please try again." },
]

/**
 * The resolvers: the root value for queries and mutations, plus view objects whose relation
 * fields are functions (graphql-js's default resolver calls them), so only what a selection
 * set asks for is ever computed.
 */
export class HealthieGraph {
  constructor(private readonly ctx: GraphContext) {}

  private get state() {
    return this.ctx.state
  }

  private touch(key: string, id: string) {
    this.ctx.touched[key] = id
  }

  // ---- views -------------------------------------------------------------------------------

  userView(user: UserRecord | undefined): Record<string, unknown> | null {
    if (!user) return null
    const state = this.state
    const providers = () =>
      [user.dietitian_id, ...user.other_provider_ids]
        .filter((id, i, all): id is string => typeof id === "string" && all.indexOf(id) === i)
        .map((id) => this.userView(state.users.get(id)))
        .filter((view) => view !== null)
    return {
      id: user.id,
      active: user.active,
      first_name: user.first_name,
      last_name: user.last_name,
      legal_name: user.legal_name,
      full_name: `${user.first_name} ${user.last_name}`.trim(),
      name: `${user.first_name} ${user.last_name}`.trim(),
      dob: user.dob,
      gender: user.gender,
      email: user.email,
      phone_number: user.phone_number,
      avatar_url: () => (user.avatar_file_id ? this.ctx.fileUrl(user.avatar_file_id) : null),
      timezone: user.timezone,
      metadata: user.metadata,
      last_conversation_id: user.last_conversation_id,
      dietitian_id: user.dietitian_id,
      dietitian: () =>
        user.dietitian_id ? this.userView(state.users.get(user.dietitian_id)) : null,
      providers,
      other_provider_ids: user.other_provider_ids,
      user_group_id: user.user_group_id,
      qualifications: user.qualifications,
      is_patient: user.role === "patient",
      location: () =>
        this.locationView(user.location_id ? state.locations.get(user.location_id) : undefined),
      billing_items: () =>
        state.billingItems
          .list({ where: (item) => item.sender_id === user.id, order: "oldest" })
          .map((row) => this.billingItemView(row.value)),
      stripe_customer_detail: user.stripe_customer_detail,
      apple_health: null,
      google_fit: null,
      next_onboarding_step: null,
      next_required_step: null,
      has_forms_to_complete: () =>
        state.requestedForms.list({
          where: (form) => form.recipient_id === user.id && form.status !== "completed",
        }).length > 0,
      blast_seen: false,
      consented_to_labs: false,
      skipped_email: false,
      created_at: user.created_at,
      updated_at: user.updated_at,
    }
  }

  locationView(location: LocationRecord | undefined) {
    return location ? { ...location } : null
  }

  documentView(doc: DocumentRecord | undefined) {
    if (!doc) return null
    const users = () =>
      [doc.rel_user_id, ...doc.share_user_ids]
        .filter((id, i, all): id is string => typeof id === "string" && all.indexOf(id) === i)
        .map((id) => this.userView(this.state.users.get(id)))
        .filter((view) => view !== null)
    return {
      id: doc.id,
      display_name: doc.display_name,
      file_content_type: doc.file_content_type,
      folder_id: doc.folder_id,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      owner: () => this.userView(this.state.users.get(doc.owner_id)),
      rel_user: () =>
        doc.rel_user_id ? this.userView(this.state.users.get(doc.rel_user_id)) : null,
      users,
      opens: Array.from({ length: doc.opens }, (_, i) => ({ id: `${doc.id}${i + 1}` })),
      expiring_url: () => this.ctx.fileUrl(doc.file_id),
    }
  }

  folderView(folder: FolderRecord | undefined) {
    if (!folder) return null
    return {
      id: folder.id,
      name: folder.name,
      folder_id: folder.folder_id,
      created_at: folder.created_at,
      owner: () => this.userView(this.state.users.get(folder.owner_id)),
      rel_user: () =>
        folder.rel_user_id ? this.userView(this.state.users.get(folder.rel_user_id)) : null,
      users: () =>
        [folder.rel_user_id, ...folder.share_user_ids]
          .filter((id, i, all): id is string => typeof id === "string" && all.indexOf(id) === i)
          .map((id) => this.userView(this.state.users.get(id)))
          .filter((view) => view !== null),
    }
  }

  offeringView(offering: OfferingRecord | undefined) {
    return offering ? { ...offering } : null
  }

  billingItemView(item: BillingItemRecord | undefined) {
    if (!item) return null
    return {
      id: item.id,
      amount_paid: item.amount_paid,
      state: item.state,
      is_canceled: item.is_canceled,
      is_recurring: item.is_recurring,
      note: item.note,
      created_at: item.created_at,
      stripe_charge_id: item.stripe_charge_id,
      offering_id: item.offering_id,
      offering: () =>
        this.offeringView(
          item.offering_id ? this.state.offerings.get(item.offering_id) : undefined,
        ),
      sender: () => this.userView(this.state.users.get(item.sender_id)),
      recipient: () =>
        item.recipient_id ? this.userView(this.state.users.get(item.recipient_id)) : null,
      recurring_payment: item.is_recurring
        ? {
            id: `rp${item.id}`,
            offering_id: item.offering_id,
            is_paused: item.is_paused,
            is_canceled: item.is_canceled,
            next_payment_date: item.is_canceled ? null : item.next_payment_date,
            billing_frequency: item.billing_frequency,
          }
        : null,
    }
  }

  formAnswerGroupView(group: FormAnswerGroupRecord | undefined) {
    if (!group) return null
    return {
      id: group.id,
      name: group.name,
      finished: group.finished,
      created_at: group.created_at,
      updated_at: group.updated_at,
      user: () => this.userView(this.state.users.get(group.user_id)),
      filler: () => this.userView(this.state.users.get(group.filler_id)),
      custom_module_form: () => {
        const form = this.state.forms.get(group.custom_module_form_id)
        return form ? { id: form.id, name: form.name } : null
      },
      form_answers: group.form_answers.map((answer) => ({
        ...answer,
        user_id: group.user_id,
        conditional_custom_module_id: null,
        filter_type: null,
        value_to_filter: null,
      })),
    }
  }

  requestedFormView(form: RequestedFormRecord | undefined) {
    if (!form) return null
    return {
      id: form.id,
      status: form.status,
      custom_module_form_id: form.custom_module_form_id,
      created_at: form.created_at,
      recipient: () => this.userView(this.state.users.get(form.recipient_id)),
      sender: () => this.userView(this.state.users.get(form.sender_id)),
    }
  }

  // ---- visibility -------------------------------------------------------------------------

  private canSeeFile(row: {
    owner_id: string
    rel_user_id: string | null
    share_user_ids: string[]
  }) {
    const viewer = this.ctx.viewer
    if (!viewer) return false
    return (
      isProvider(viewer) ||
      row.owner_id === viewer.id ||
      row.rel_user_id === viewer.id ||
      row.share_user_ids.includes(viewer.id)
    )
  }

  private visibleUser(id: unknown): UserRecord | undefined {
    const user = str(id) ? this.state.users.get(str(id) as string) : undefined
    return user && canSeeUser(this.ctx.viewer, user) ? user : undefined
  }

  // ---- queries ----------------------------------------------------------------------------

  root(): Record<string, (args: Args) => unknown> {
    return {
      currentUser: () => (this.ctx.effects.currentUserNull ? null : this.userView(this.ctx.viewer)),
      user: (args) => {
        if (!this.ctx.viewer) return null
        const id = str(args.id)
        if (id === undefined) return args.or_current_user ? this.userView(this.ctx.viewer) : null
        const user = this.visibleUser(id)
        if (user) this.touch("userId", user.id)
        return this.userView(user)
      },
      users: (args) => {
        const viewer = this.ctx.viewer
        if (!isProvider(viewer)) return []
        const keywords = (str(args.keywords) ?? "").trim().toLowerCase()
        const status = str(args.active_status)
        const rows = this.state.users
          .list({ where: (u) => u.role === "patient", order: "oldest" })
          .map((row) => row.value)
          .filter((u) => status !== "active" || u.active)
          .filter((u) => status !== "archived" || !u.active)
          .filter(
            (u) =>
              keywords === "" ||
              [u.email, u.first_name, u.last_name, `${u.first_name} ${u.last_name}`].some((field) =>
                field.toLowerCase().includes(keywords),
              ),
          )
        return this.paginate(rows, args).map((u) => this.userView(u))
      },
      location: (args) => {
        const location = str(args.id) ? this.state.locations.get(str(args.id) as string) : undefined
        if (!location || !this.ctx.viewer) return null
        if (!isProvider(this.ctx.viewer) && location.user_id !== this.ctx.viewer.id) return null
        return this.locationView(location)
      },
      locations: (args) => {
        const viewer = this.ctx.viewer
        if (!viewer) return []
        const userId = isProvider(viewer) ? (str(args.user_id) ?? viewer.id) : viewer.id
        return this.state.locations
          .list({ where: (l) => l.user_id === userId, order: "oldest" })
          .map((row) => this.locationView(row.value))
      },
      documents: (args) => {
        if (!this.ctx.viewer) return []
        const folderId = str(args.folder_id) ?? null
        const keyword = this.keywordOf(args)
        const rows = this.state.documents
          .list({ where: (d) => d.folder_id === folderId && this.canSeeFile(d) })
          .map((row) => row.value)
          .filter((d) => this.sharingMatches(d, args.filter))
          .filter((d) => !keyword || d.display_name.toLowerCase().includes(keyword))
        return this.paginate(
          sortRows(rows, args.sort_by, (d) => d.display_name),
          args,
        ).map((d) => this.documentView(d))
      },
      document: (args) => {
        const doc = str(args.id) ? this.state.documents.get(str(args.id) as string) : undefined
        if (!doc || !this.canSeeFile(doc)) return null
        this.touch("documentId", doc.id)
        return this.documentView(doc)
      },
      folders: (args) => {
        if (!this.ctx.viewer) return []
        const folderId = str(args.folder_id) ?? null
        const keyword = this.keywordOf(args)
        const rows = this.state.folders
          .list({ where: (f) => f.folder_id === folderId && this.canSeeFile(f) })
          .map((row) => row.value)
          .filter((f) => this.sharingMatches(f, args.filter))
          .filter((f) => !keyword || f.name.toLowerCase().includes(keyword))
        return this.paginate(
          sortRows(rows, args.sort_by, (f) => f.name),
          args,
        ).map((f) => this.folderView(f))
      },
      requestedFormCompletion: (args) => {
        const form = str(args.id)
          ? this.state.requestedForms.get(str(args.id) as string)
          : undefined
        const viewer = this.ctx.viewer
        if (!form || !viewer) return null
        if (!isProvider(viewer) && form.recipient_id !== viewer.id) return null
        this.touch("requestedFormId", form.id)
        return this.requestedFormView(form)
      },
      formAnswerGroups: (args) => {
        const viewer = this.ctx.viewer
        if (!viewer) return []
        const userId = str(args.user_id) ?? viewer.id
        if (!isProvider(viewer) && userId !== viewer.id) return []
        const formId = str(args.custom_module_form_id)
        const fillerId = str(args.filler_id)
        const rows = this.state.formAnswerGroups
          .list({ where: (g) => g.user_id === userId, order: "newest" })
          .map((row) => row.value)
          .filter((g) => formId === undefined || g.custom_module_form_id === formId)
          .filter((g) => fillerId === undefined || g.filler_id === fillerId)
        return this.paginate(rows, args).map((g) => this.formAnswerGroupView(g))
      },
      formAnswerGroup: (args) => {
        const group = str(args.id)
          ? this.state.formAnswerGroups.get(str(args.id) as string)
          : undefined
        const viewer = this.ctx.viewer
        if (!group || !viewer) return null
        if (!isProvider(viewer) && group.user_id !== viewer.id) return null
        this.touch("formAnswerGroupId", group.id)
        return this.formAnswerGroupView(group)
      },
      initialFormAnswers: (args) => this.initialFormAnswers(args),
      offerings: (args) => {
        if (!this.ctx.viewer) return []
        const visibility = str(args.client_visibility) ?? "visible"
        const offeringId = str(args.offering_id)
        const keyword = (str(args.keywords) ?? "").toLowerCase()
        const rows = this.state.offerings
          .list({ order: "oldest" })
          .map((row) => row.value)
          .filter((o) => visibility === "all" || o.visibility_status === visibility)
          .filter((o) => offeringId === undefined || o.id === offeringId)
          .filter((o) => keyword === "" || o.name.toLowerCase().includes(keyword))
        return this.paginate(rows, args).map((o) => this.offeringView(o))
      },
      billingItems: (args) => {
        const viewer = this.ctx.viewer
        if (!viewer) return []
        const clientId = str(args.client_id)
        const statuses = Array.isArray(args.status) ? args.status.map(String) : undefined
        const rows = this.state.billingItems
          .list({ order: "newest" })
          .map((row) => row.value)
          .filter((b) => (isProvider(viewer) ? true : b.sender_id === viewer.id))
          .filter((b) => clientId === undefined || b.sender_id === clientId)
          .filter((b) => args.offerings_only !== true || b.offering_id !== null)
          .filter((b) => statuses === undefined || statuses.includes(b.state))
        return this.paginate(rows, args).map((b) => this.billingItemView(b))
      },
    }
  }

  private keywordOf(args: Args): string | undefined {
    const keywords = str(args.keywords)
    if (keywords) return keywords.toLowerCase()
    const filter = str(args.filter)
    // Our consumer passes the folder name as `filter` (filterFoldersByKeyword); Healthie
    // treats values it does not recognise as a sharing filter as a keyword.
    return filter && !SHARING_FILTERS.has(filter.toLowerCase()) ? filter.toLowerCase() : undefined
  }

  private sharingMatches(row: { owner_id: string }, filter: unknown): boolean {
    const value = str(filter)?.toLowerCase()
    const viewer = this.ctx.viewer
    if (!viewer || value === undefined || !SHARING_FILTERS.has(value) || value === "all")
      return true
    return value === "shared" ? row.owner_id !== viewer.id : row.owner_id === viewer.id
  }

  /** `should_paginate` (default true) pages by 10 from `offset`, as Healthie's default page. */
  private paginate<T>(rows: T[], args: Args): T[] {
    if (args.should_paginate === false) return rows
    const offset = typeof args.offset === "number" ? args.offset : 0
    const size = typeof args.page_size === "number" ? args.page_size : 10
    return rows.slice(offset, offset + size)
  }

  private initialFormAnswers(args: Args) {
    const viewer = this.ctx.viewer
    if (!viewer) return []
    const form = str(args.custom_module_form_id)
      ? this.state.forms.get(str(args.custom_module_form_id) as string)
      : undefined
    if (!form) throw new GraphQLError("Custom module form not found")
    const userId = str(args.user_id) ?? viewer.id
    if (!isProvider(viewer) && userId !== viewer.id) throw denied()
    const incomplete = str(args.incomplete_form_id)
    const source = incomplete
      ? this.state.formAnswerGroups.get(incomplete)
      : this.state.formAnswerGroups
          .list({
            where: (g) => g.user_id === userId && g.custom_module_form_id === form.id,
            order: "newest",
          })
          .at(0)?.value
    return form.custom_modules.map((module) => {
      const answered = source?.form_answers.find((a) => a.custom_module_id === module.id)
      return {
        answer: answered?.answer ?? "",
        custom_module_id: module.id,
        user_id: userId,
        conditional_custom_module_id: null,
        filter_type: null,
        value_to_filter: null,
        label: module.label,
      }
    })
  }

  // ---- mutations --------------------------------------------------------------------------

  mutations(): Record<string, (args: Args) => unknown> {
    return {
      signIn: (args) => this.signIn((args.input ?? {}) as Input),
      updateUser: (args) => this.updateUser((args.input ?? {}) as Input),
      updateClient: (args) => this.updateClient((args.input ?? {}) as Input),
      createLocation: (args) => this.createLocation((args.input ?? {}) as Input),
      updateLocation: (args) => this.updateLocation((args.input ?? {}) as Input),
      createFolder: (args) => this.createFolder((args.input ?? {}) as Input),
      createDocument: (args) => this.createDocument((args.input ?? {}) as Input),
      deleteDocument: (args) => this.deleteDocument((args.input ?? {}) as Input),
      updateBillingItem: (args) => this.updateBillingItem((args.input ?? {}) as Input),
    }
  }

  /** Issue an API key for `user` (`generate_api_token`), revoking older ones unless multiple. */
  issueApiKey(user: UserRecord, keepOthers: boolean): string {
    if (!keepOthers) {
      for (const row of this.state.apiKeys.list({ where: (k) => k.user_id === user.id })) {
        this.state.apiKeys.delete(row.id)
      }
    }
    const n = this.state.nextId("api_key")
    const key = `gh_sbox_${opaqueToken(`healthie:api-key:${user.id}:${n}`, 40)}`
    this.state.apiKeys.insert(key, { key, user_id: user.id, created_at: this.ctx.timestamp() })
    return key
  }

  private signIn(input: Input) {
    const settings = this.state.current()
    const user = str(input.email) ? this.state.userByEmail(str(input.email) as string) : undefined
    const namespaceOk = settings.namespace === null || str(input.namespace) === settings.namespace
    if (!user || !namespaceOk || user.password !== str(input.password)) {
      return {
        api_key: null,
        token: null,
        user: null,
        messages: [{ field: "password", message: "Invalid email or password" }],
      }
    }
    this.touch("userId", user.id)
    const key =
      input.generate_api_token === true
        ? this.issueApiKey(user, input.allow_multiple_api_keys === true)
        : null
    return { api_key: key, token: key, user: this.userView(user), messages: null }
  }

  private updateUser(input: Input) {
    const viewer = signedIn(this.ctx)
    const target = has(input, "id") ? this.state.users.get(str(input.id) ?? "") : viewer
    if (!target) return { user: null, messages: [{ field: "id", message: "User not found" }] }
    if (target.id !== viewer.id && !isProvider(viewer)) throw denied()
    if (this.ctx.effects.validationMessages) return { user: null, messages: FORCED_MESSAGES }
    const issues = profileIssues(input)
    const next: UserRecord = { ...target }
    if (
      has(input, "password") ||
      has(input, "current_password") ||
      has(input, "password_confirmation")
    ) {
      const password = str(input.password) ?? ""
      if (target.id === viewer.id && str(input.current_password) !== target.password) {
        issues.push({ field: "current_password", message: "Current password is incorrect" })
      }
      if (password.length < 8) {
        issues.push({
          field: "password",
          message: "Password is too short (minimum is 8 characters)",
        })
      }
      if (password !== str(input.password_confirmation)) {
        issues.push({
          field: "password_confirmation",
          message: "Password confirmation doesn't match Password",
        })
      }
      next.password = password
    }
    if (issues.length > 0) return { user: null, messages: issues }
    for (const key of ["first_name", "last_name"] as const) {
      if (has(input, key)) next[key] = str(input[key]) ?? ""
    }
    for (const key of ["dob", "gender", "phone_number", "timezone"] as const) {
      if (has(input, key)) next[key] = str(input[key]) ?? null
    }
    if (has(input, "email")) next.email = (str(input.email) as string).toLowerCase()
    if (has(input, "seen_welcome")) next.seen_welcome = input.seen_welcome === true
    if (has(input, "seen_onboarding_complete_page")) {
      next.seen_onboarding_complete_page = input.seen_onboarding_complete_page === true
    }
    if (Object.hasOwn(input, "avatar")) {
      if (input.avatar === null) {
        if (next.avatar_file_id) this.state.files.delete(next.avatar_file_id)
        next.avatar_file_id = null
      } else if (input.avatar instanceof Upload) {
        if (next.avatar_file_id) this.state.files.delete(next.avatar_file_id)
        next.avatar_file_id = this.storeFile(input.avatar)
      }
    }
    next.updated_at = this.ctx.timestamp()
    this.state.users.update(target.id, next)
    this.touch("userId", target.id)
    this.patientUpdated(
      next,
      Object.keys(input).filter((k) => k !== "id" && !k.includes("password")),
    )
    return { user: this.userView(next), messages: null }
  }

  private updateClient(input: Input) {
    const viewer = signedIn(this.ctx)
    if (!isProvider(viewer)) throw denied()
    const target = this.state.users.get(str(input.id) ?? "")
    if (!target) return { user: null, messages: [{ field: "id", message: "Client not found" }] }
    if (this.ctx.effects.validationMessages) return { user: null, messages: FORCED_MESSAGES }
    const issues = profileIssues(input)
    const password = str(input.password)
    if (password !== undefined && password.length < 8) {
      issues.push({ field: "password", message: "Password is too short (minimum is 8 characters)" })
    }
    const dietitian = str(input.dietitian_id)
    if (dietitian !== undefined && this.state.users.get(dietitian)?.role !== "provider") {
      issues.push({ field: "dietitian_id", message: "Provider not found" })
    }
    if (issues.length > 0) return { user: null, messages: issues }
    const next: UserRecord = { ...target }
    for (const key of ["first_name", "last_name"] as const) {
      if (has(input, key)) next[key] = str(input[key]) ?? ""
    }
    for (const key of [
      "legal_name",
      "dob",
      "gender",
      "phone_number",
      "timezone",
      "metadata",
      "user_group_id",
    ] as const) {
      if (has(input, key)) next[key] = str(input[key]) ?? null
    }
    if (has(input, "email")) next.email = (str(input.email) as string).toLowerCase()
    if (password !== undefined) next.password = password
    if (typeof input.active === "boolean") next.active = input.active
    if (dietitian !== undefined) next.dietitian_id = dietitian
    if (Array.isArray(input.other_provider_ids)) {
      next.other_provider_ids = input.other_provider_ids
        .map(String)
        .filter((id) => id !== next.dietitian_id)
    }
    if (input.location !== undefined && input.location !== null) {
      next.location_id = this.upsertLocation(next, input.location as Input)
    }
    next.updated_at = this.ctx.timestamp()
    this.state.users.update(target.id, next)
    this.touch("userId", target.id)
    this.patientUpdated(
      next,
      Object.keys(input).filter((k) => k !== "id" && k !== "password"),
    )
    return { user: this.userView(next), messages: null }
  }

  private upsertLocation(user: UserRecord, input: Input): string {
    const existing = user.location_id ? this.state.locations.get(user.location_id) : undefined
    const base: LocationRecord = existing ?? {
      id: this.state.nextId("location"),
      user_id: user.id,
      name: null,
      line1: null,
      line2: null,
      city: null,
      state: null,
      zip: null,
      country: "US",
    }
    const next = { ...base }
    for (const key of ["name", "line1", "line2", "city", "state", "zip", "country"] as const) {
      if (has(input, key)) next[key] = str(input[key]) ?? null
    }
    this.state.locations.insert(next.id, next)
    return next.id
  }

  private locationIssues(input: Input, creating: boolean): FieldError[] {
    const issues: FieldError[] = []
    if (creating && !str(input.line1))
      issues.push({ field: "line1", message: "Address line 1 can't be blank" })
    const zip = str(input.zip)
    if (zip !== undefined && zip !== "" && !/^\d{5}(-\d{4})?$/.test(zip)) {
      issues.push({ field: "zip", message: "Zip is invalid" })
    }
    return issues
  }

  private createLocation(input: Input) {
    const viewer = signedIn(this.ctx)
    const owner = this.state.users.get(str(input.user_id) ?? viewer.id)
    if (!owner)
      return { location: null, messages: [{ field: "user_id", message: "User not found" }] }
    if (owner.id !== viewer.id && !isProvider(viewer)) throw denied()
    if (this.ctx.effects.validationMessages) return { location: null, messages: FORCED_MESSAGES }
    const issues = this.locationIssues(input, true)
    if (issues.length > 0) return { location: null, messages: issues }
    const location: LocationRecord = {
      id: this.state.nextId("location"),
      user_id: owner.id,
      name: str(input.name) ?? null,
      line1: str(input.line1) ?? null,
      line2: str(input.line2) ?? null,
      city: str(input.city) ?? null,
      state: str(input.state) ?? null,
      zip: str(input.zip) ?? null,
      country: str(input.country) ?? null,
    }
    this.state.locations.insert(location.id, location)
    if (!owner.location_id) {
      this.state.users.update(owner.id, {
        ...owner,
        location_id: location.id,
        updated_at: this.ctx.timestamp(),
      })
    }
    this.touch("locationId", location.id)
    return { location: this.locationView(location), messages: null }
  }

  private updateLocation(input: Input) {
    const viewer = signedIn(this.ctx)
    const location = this.state.locations.get(str(input.id) ?? "")
    if (!location)
      return { location: null, messages: [{ field: "id", message: "Location not found" }] }
    if (location.user_id !== viewer.id && !isProvider(viewer)) throw denied()
    if (this.ctx.effects.validationMessages) return { location: null, messages: FORCED_MESSAGES }
    const issues = this.locationIssues(input, false)
    if (issues.length > 0) return { location: null, messages: issues }
    const next = { ...location }
    for (const key of ["name", "line1", "line2", "city", "state", "zip", "country"] as const) {
      if (has(input, key)) next[key] = str(input[key]) ?? null
    }
    this.state.locations.update(next.id, next)
    this.touch("locationId", next.id)
    return { location: this.locationView(next), messages: null }
  }

  private createFolder(input: Input) {
    const viewer = signedIn(this.ctx)
    if (this.ctx.effects.validationMessages) return { folder: null, messages: FORCED_MESSAGES }
    const name = (str(input.name) ?? "").trim()
    if (name === "")
      return { folder: null, messages: [{ field: "name", message: "Name can't be blank" }] }
    const parentId = str(input.folder_id) ?? null
    if (parentId !== null) {
      const parent = this.state.folders.get(parentId)
      if (!parent || !this.canSeeFile(parent)) {
        return { folder: null, messages: [{ field: "folder_id", message: "Folder not found" }] }
      }
    }
    const folder: FolderRecord = {
      id: this.state.nextId("folder"),
      name,
      folder_id: parentId,
      owner_id: viewer.id,
      rel_user_id: str(input.rel_user_id) ?? null,
      share_user_ids: parseShareUsers(input.share_users),
      created_at: this.ctx.timestamp(),
    }
    this.state.folders.insert(folder.id, folder)
    this.touch("folderId", folder.id)
    return { folder: this.folderView(folder), messages: null }
  }

  private storeFile(upload: Upload): string {
    const id = this.state.nextId("file")
    this.state.files.insert(id, {
      id,
      filename: upload.filename,
      content_type: upload.mimetype || "application/octet-stream",
      base64: toBase64(upload.bytes),
      size: upload.bytes.byteLength,
    })
    return id
  }

  private createDocument(input: Input) {
    const viewer = signedIn(this.ctx)
    if (this.ctx.effects.validationMessages) return { document: null, messages: FORCED_MESSAGES }
    let upload = input.file instanceof Upload ? input.file : undefined
    const fileString = str(input.file_string)
    if (!upload && fileString) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(fileString)
      if (match) {
        const raw = match[2] ? atob(match[3] ?? "") : decodeURIComponent(match[3] ?? "")
        upload = new Upload(
          str(input.display_name) ?? "document",
          match[1] ?? "application/octet-stream",
          Uint8Array.from(raw, (c) => c.charCodeAt(0)),
        )
      }
    }
    if (!upload)
      return { document: null, messages: [{ field: "file", message: "File can't be blank" }] }
    const folderId = str(input.folder_id) ?? null
    if (folderId !== null) {
      const folder = this.state.folders.get(folderId)
      if (!folder || !this.canSeeFile(folder)) {
        return { document: null, messages: [{ field: "folder_id", message: "Folder not found" }] }
      }
    }
    const at = this.ctx.timestamp()
    const doc: DocumentRecord = {
      id: this.state.nextId("document"),
      display_name: str(input.display_name) || upload.filename,
      file_content_type: upload.mimetype || "application/octet-stream",
      file_id: this.storeFile(upload),
      folder_id: folderId,
      owner_id: viewer.id,
      rel_user_id: str(input.rel_user_id) ?? null,
      share_user_ids: parseShareUsers(input.share_users),
      opens: 0,
      created_at: at,
      updated_at: at,
    }
    this.state.documents.insert(doc.id, doc)
    this.touch("documentId", doc.id)
    return { document: this.documentView(doc), messages: null }
  }

  private deleteDocument(input: Input) {
    const viewer = signedIn(this.ctx)
    const doc = this.state.documents.get(str(input.id) ?? "")
    if (!doc || !this.canSeeFile(doc)) {
      return { document: null, messages: [{ field: "id", message: "Document not found" }] }
    }
    if (doc.owner_id !== viewer.id && !isProvider(viewer)) throw denied()
    this.state.documents.delete(doc.id)
    this.state.files.delete(doc.file_id)
    this.touch("documentId", doc.id)
    return { document: { id: doc.id }, messages: null }
  }

  private updateBillingItem(input: Input) {
    const viewer = signedIn(this.ctx)
    const item = this.state.billingItems.get(str(input.id) ?? "")
    if (!item)
      return { billingItem: null, messages: [{ field: "id", message: "Billing item not found" }] }
    if (!isProvider(viewer) && item.sender_id !== viewer.id) throw denied()
    if (this.ctx.effects.validationMessages) return { billingItem: null, messages: FORCED_MESSAGES }
    const next = { ...item }
    const changed: string[] = []
    if (typeof input.is_paused === "boolean") {
      if (!item.is_recurring) {
        return {
          billingItem: null,
          messages: [{ field: "is_paused", message: "Only recurring payments can be paused" }],
        }
      }
      next.is_paused = input.is_paused
      changed.push("is_paused")
    }
    if (input.is_canceled === true) {
      next.is_canceled = true
      next.state = "canceled"
      changed.push("is_canceled")
    }
    if (has(input, "note")) {
      next.note = str(input.note) ?? null
      changed.push("note")
    }
    if (has(input, "state")) {
      next.state = str(input.state) ?? next.state
      changed.push("state")
    }
    this.state.billingItems.update(next.id, next)
    this.touch("billingItemId", next.id)
    this.ctx.emit({
      resource_id: next.id,
      resource_id_type: "BillingItem",
      event_type: "billing_item.updated",
      changed_fields: changed,
    })
    return { billingItem: this.billingItemView(next), messages: null }
  }

  private patientUpdated(user: UserRecord, changed: string[]) {
    if (user.role !== "patient") return
    this.ctx.emit({
      resource_id: user.id,
      resource_id_type: "User",
      event_type: "patient.updated",
      changed_fields: changed,
    })
  }
}
