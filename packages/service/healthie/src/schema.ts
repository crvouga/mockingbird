import { buildSchema, type GraphQLScalarType, type GraphQLSchema } from "graphql"

/**
 * The subset of Healthie's GraphQL schema our consumer's live documents touch, with Healthie's
 * own type, field, argument and input names (snake_case, `…Input` / `…Payload` shapes), so
 * every selection set in `healthie-client.service.ts` validates and executes unchanged.
 * Fields the consumer never selects are left out: a document asking for one fails validation
 * exactly as a typo would on the real API.
 */
export const HEALTHIE_SDL = /* GraphQL */ `
  scalar Upload

  type FieldError {
    field: String
    message: String
  }

  type OnboardingItem {
    id: ID
    item_type: String
  }

  type HealthData {
    id: ID
    last_sync_date: String
  }

  type StripeCustomerDetail {
    id: ID
    card_type: String
    card_type_label: String
    last_four: String
    stripe_id: String
    expiration: String
  }

  type Location {
    id: ID!
    name: String
    line1: String
    line2: String
    city: String
    state: String
    country: String
    zip: String
    user_id: String
  }

  type User {
    id: ID!
    active: Boolean
    first_name: String
    last_name: String
    legal_name: String
    full_name: String
    name: String
    dob: String
    gender: String
    email: String
    phone_number: String
    avatar_url: String
    timezone: String
    metadata: String
    last_conversation_id: String
    dietitian_id: String
    dietitian: User
    providers: [User!]
    other_provider_ids: [String]
    user_group_id: String
    qualifications: String
    is_patient: Boolean
    location: Location
    billing_items: [BillingItem!]
    stripe_customer_detail: StripeCustomerDetail
    apple_health: HealthData
    google_fit: HealthData
    next_onboarding_step: OnboardingItem
    next_required_step: String
    has_forms_to_complete: Boolean
    blast_seen: Boolean
    consented_to_labs: Boolean
    skipped_email: Boolean
    created_at: String
    updated_at: String
  }

  type DocumentOpen {
    id: ID
  }

  type Document {
    id: ID!
    display_name: String
    file_content_type: String
    folder_id: String
    created_at: String
    updated_at: String
    owner: User
    rel_user: User
    users: [User!]
    opens: [DocumentOpen!]
    expiring_url: String
  }

  type Folder {
    id: ID!
    name: String
    folder_id: String
    created_at: String
    owner: User
    rel_user: User
    users: [User!]
  }

  type CustomModuleForm {
    id: ID
    name: String
  }

  type FormAnswer {
    id: ID
    label: String
    answer: String
    displayed_answer: String
    custom_module_id: String
    user_id: String
    conditional_custom_module_id: String
    filter_type: String
    value_to_filter: String
  }

  type FormAnswerGroup {
    id: ID!
    name: String
    finished: Boolean
    created_at: String
    updated_at: String
    user: User
    filler: User
    custom_module_form: CustomModuleForm
    form_answers: [FormAnswer!]
  }

  type RequestedFormCompletion {
    id: ID!
    status: String
    custom_module_form_id: String
    created_at: String
    recipient: User
    sender: User
  }

  type Offering {
    id: ID!
    name: String
    description: String
    billing_frequency: String
    currency: String
    price: String
    visibility_status: String
  }

  type RecurringPayment {
    id: ID
    offering_id: String
    is_paused: Boolean
    is_canceled: Boolean
    next_payment_date: String
    billing_frequency: String
  }

  type BillingItem {
    id: ID!
    amount_paid: String
    state: String
    is_canceled: Boolean
    is_recurring: Boolean
    note: String
    created_at: String
    stripe_charge_id: String
    offering_id: String
    offering: Offering
    sender: User
    recipient: User
    recurring_payment: RecurringPayment
  }

  type Query {
    currentUser: User
    user(id: ID, or_current_user: Boolean): User
    users(
      keywords: String
      should_paginate: Boolean
      offset: Int
      page_size: Int
      sort_by: String
      active_status: String
    ): [User!]
    location(id: ID): Location
    locations(user_id: String, should_paginate: Boolean): [Location!]
    documents(
      sort_by: String
      filter: String
      keywords: String
      should_paginate: Boolean
      folder_id: String
      offset: Int
      viewable_user_id: String
    ): [Document!]
    document(id: ID): Document
    folders(
      sort_by: String
      filter: String
      keywords: String
      should_paginate: Boolean
      folder_id: String
      offset: Int
    ): [Folder!]
    requestedFormCompletion(id: ID): RequestedFormCompletion
    formAnswerGroups(
      user_id: String
      filler_id: String
      custom_module_form_id: String
      offset: Int
      should_paginate: Boolean
    ): [FormAnswerGroup!]
    formAnswerGroup(id: ID): FormAnswerGroup
    initialFormAnswers(custom_module_form_id: ID, incomplete_form_id: ID, user_id: ID): [FormAnswer!]
    offerings(
      should_paginate: Boolean
      client_visibility: String
      offering_id: ID
      keywords: String
      offset: Int
    ): [Offering!]
    billingItems(
      offerings_only: Boolean
      client_id: ID
      status: [String]
      offset: Int
      should_paginate: Boolean
    ): [BillingItem!]
  }

  input signInInput {
    email: String
    password: String
    namespace: String
    otp_attempt: String
    generate_api_token: Boolean
    allow_multiple_api_keys: Boolean
  }

  type signInPayload {
    api_key: String
    token: String
    user: User
    messages: [FieldError!]
  }

  input updateUserInput {
    id: ID
    first_name: String
    last_name: String
    email: String
    dob: String
    gender: String
    phone_number: String
    timezone: String
    seen_welcome: Boolean
    seen_onboarding_complete_page: Boolean
    avatar: Upload
    current_password: String
    password: String
    password_confirmation: String
  }

  type updateUserPayload {
    user: User
    messages: [FieldError!]
  }

  input ClientLocationInput {
    id: ID
    name: String
    line1: String
    line2: String
    city: String
    state: String
    zip: String
    country: String
  }

  input updateClientInput {
    id: ID
    first_name: String
    last_name: String
    legal_name: String
    email: String
    dob: String
    gender: String
    phone_number: String
    timezone: String
    metadata: String
    password: String
    active: Boolean
    dietitian_id: String
    user_group_id: String
    other_provider_ids: [String]
    location: ClientLocationInput
  }

  type updateClientPayload {
    user: User
    messages: [FieldError!]
  }

  input createLocationInput {
    user_id: String
    name: String
    line1: String
    line2: String
    city: String
    state: String
    zip: String
    country: String
  }

  type createLocationPayload {
    location: Location
    messages: [FieldError!]
  }

  input updateLocationInput {
    id: String
    name: String
    line1: String
    line2: String
    city: String
    state: String
    zip: String
    country: String
  }

  type updateLocationPayload {
    location: Location
    messages: [FieldError!]
  }

  input createFolderInput {
    name: String
    folder_id: String
    share_users: String
    rel_user_id: String
  }

  type createFolderPayload {
    folder: Folder
    messages: [FieldError!]
  }

  input createDocumentInput {
    file: Upload
    file_string: String
    display_name: String
    description: String
    folder_id: String
    share_users: String
    rel_user_id: String
    include_in_charting: Boolean
  }

  type createDocumentPayload {
    document: Document
    messages: [FieldError!]
  }

  input deleteDocumentInput {
    id: ID
  }

  type deleteDocumentPayload {
    document: Document
    messages: [FieldError!]
  }

  input updateBillingItemInput {
    id: ID
    is_paused: Boolean
    is_canceled: Boolean
    note: String
    state: String
  }

  type updateBillingItemPayload {
    billingItem: BillingItem
    messages: [FieldError!]
  }

  type Mutation {
    signIn(input: signInInput): signInPayload
    updateUser(input: updateUserInput): updateUserPayload
    updateClient(input: updateClientInput): updateClientPayload
    createLocation(input: createLocationInput): createLocationPayload
    updateLocation(input: updateLocationInput): updateLocationPayload
    createFolder(input: createFolderInput): createFolderPayload
    createDocument(input: createDocumentInput): createDocumentPayload
    deleteDocument(input: deleteDocumentInput): deleteDocumentPayload
    updateBillingItem(input: updateBillingItemInput): updateBillingItemPayload
  }
`

/** A file part of a GraphQL multipart request, bound to an `Upload` variable. */
export class Upload {
  constructor(
    readonly filename: string,
    readonly mimetype: string,
    readonly bytes: Uint8Array,
  ) {}
}

let built: GraphQLSchema | undefined

/** The executable schema (built once; resolvers come from the root value and source objects). */
export const healthieSchema = (): GraphQLSchema => {
  if (built) return built
  const schema = buildSchema(HEALTHIE_SDL)
  const upload = schema.getType("Upload") as GraphQLScalarType
  // Uploads only arrive through the multipart transport, already bound to variables.
  Object.assign(upload, {
    parseValue: (value: unknown) => {
      if (value instanceof Upload || value === null) return value
      throw new TypeError("Upload value must be a file part of a multipart request")
    },
    parseLiteral: () => {
      throw new TypeError("Upload literal unsupported; send the file as a multipart variable")
    },
    serialize: () => {
      throw new TypeError("Upload is an input-only scalar")
    },
  } satisfies Partial<GraphQLScalarType>)
  built = schema
  return schema
}
