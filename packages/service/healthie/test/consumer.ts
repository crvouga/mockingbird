/**
 * A port of our backend's Healthie client (`B/global-services/services/healthie-client/
 * healthie-client.service.ts`), restricted to the live methods, plus the two webhook
 * receivers (`B/users/users.service.ts` updatePatientWebhookData, `B/forms/forms.service.ts`
 * formRequestStatus) and the sign-in outcome mapping (`B/users/users.service.ts` signIn).
 *
 * It uses the same two transports the backend does: `graphql-request`'s `GraphQLClient` for
 * plain documents and `awesome-graphql-client` for the multipart `Upload` documents, with the
 * documents copied verbatim (selection sets, variable declarations, aliases), the same
 * headers (`Authorization`, `AuthorizationSource: API`) and the same `handleError` mapping.
 * The acceptance tests drive the mock only through this port.
 */
import { AwesomeGraphQLClient, GraphQLRequestError } from "awesome-graphql-client"
import { GraphQLClient, gql } from "graphql-request"

export type Fetch = (request: Request) => Promise<Response>

/** Nest's HttpException family, reduced to what the tests assert on. */
export class HttpException extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(typeof body === "string" ? body : JSON.stringify(body))
  }
}

type GraphQLErrorLike = { message: string }
type HealthieErrorResponse = {
  response: { errors?: GraphQLErrorLike[]; status: number; error?: unknown }
}

/** `handleError`, verbatim in behaviour: 401 for a bad key, 500 for "500", else 400. */
export const handleError = (error: unknown): never => {
  if (error instanceof HttpException) throw error
  if (error instanceof GraphQLRequestError) {
    if ((error as Error).message.includes("API Key is Invalid")) {
      throw new HttpException(401, "Invalid API Key")
    }
  }
  const errors = (error as HealthieErrorResponse).response.errors ?? []
  if (errors.length > 0) {
    const errorMessages = errors.map((e) => e.message)
    if (errorMessages.includes("API Key is Invalid")) {
      throw new HttpException(401, "Invalid API Key")
    } else if (errorMessages.some((message) => message.includes("500"))) {
      throw new HttpException(500, errors)
    } else {
      throw new HttpException(400, errors)
    }
  }
  const errorResponse = (error as HealthieErrorResponse).response
  switch (errorResponse.status) {
    case 401:
      throw new HttpException(401, "Invalid API Key")
    case 500:
      throw new HttpException(500, errorResponse.error)
    case 404:
      throw new HttpException(404, errorResponse.error)
    default:
      throw new HttpException(400, errorResponse.error)
  }
}

/** A multer-like upload: our backend streams `file.path`; the port hands the bytes over. */
export type UploadedFile = { originalname: string; mimetype: string; bytes: Uint8Array }

const toBlob = (file: UploadedFile) =>
  new File([file.bytes as BlobPart], file.originalname, { type: file.mimetype })

export type HealthieFile = {
  id: string
  name: string
  contentType?: string
  createdAt: string
  owner: { id: string; email: string }
  users: { id: string; email: string }[]
  fileType: "document" | "folder"
  parentFolderId: string | null
  expiring_url?: string
}

type FieldMessages = { field: string; message: string }[] | null

// biome-ignore lint/suspicious/noExplicitAny: GraphQL payloads are untyped at this boundary, as in the consumer.
type Any = any

const dateToISOString = (date: string) => (date ? new Date(Date.parse(date)).toISOString() : date)

export class HealthieConsumer {
  private readonly graphqlClient: GraphQLClient
  private readonly graphqlFileUploadClient: AwesomeGraphQLClient

  constructor(
    apiUrl: string,
    private readonly config: { HEALTHIE_API_AUTH_TOKEN: string; HEALTHIE_NAMESPACE?: string },
    private readonly fetchImpl: Fetch,
  ) {
    const fetchLike = (input: RequestInfo | URL, init?: RequestInit) =>
      fetchImpl(new Request(input as RequestInfo, init))
    this.graphqlClient = new GraphQLClient(apiUrl, { fetch: fetchLike as typeof fetch })
    this.graphqlFileUploadClient = new AwesomeGraphQLClient({
      endpoint: apiUrl,
      fetch: fetchLike as typeof fetch,
      FormData,
    })
  }

  /** Download an `expiring_url` / `avatar_url` (what the member app or a queue does with it). */
  fetchFile(url: string): Promise<Response> {
    return this.fetchImpl(new Request(url))
  }

  private orgHeaders() {
    return {
      Authorization: `Bearer ${this.config.HEALTHIE_API_AUTH_TOKEN}`,
      AuthorizationSource: "API",
    }
  }

  async signIn(signInDto: { email: string; password: string }) {
    const NAMESPACE = this.config.HEALTHIE_NAMESPACE
    const variables: Record<string, unknown> = {
      email: signInDto.email,
      password: signInDto.password,
      namespace: NAMESPACE,
    }
    if (!NAMESPACE) delete variables.namespace
    const mutation = gql`
      mutation signIn(
        $email: String
        $password: String
        ${NAMESPACE ? "$namespace: String" : ""}
      ) {
        signIn(
          input: {
            email: $email
            password: $password
            ${NAMESPACE ? "namespace: $namespace" : ""}
            generate_api_token: true
            allow_multiple_api_keys: true
          }
        ) {
          api_key
          user {
            id
            active
            first_name
            last_name
            dob
            gender
            email
            phone_number
            avatar_url
            timezone
            metadata
            last_conversation_id
            apple_health {
              id
              last_sync_date
            }
            google_fit {
              id
              last_sync_date
            }
            dietitian_id
            dietitian {
              id
              full_name
              avatar_url
              qualifications
            }
            timezone
            next_onboarding_step {
              id
              item_type
            }
            next_required_step
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(mutation, variables, {
        AuthorizationSource: "API",
      })
      return response.signIn as { api_key: string | null; user: Any }
    } catch (error) {
      handleError(error)
      return { user: null, api_key: null }
    }
  }

  async getUsers() {
    const query = gql`
      query getUsers {
        users(should_paginate: false) {
          id
          first_name
          last_name
          email
          phone_number
          avatar_url
          timezone
          last_conversation_id
          dietitian_id
          created_at
          updated_at
          next_onboarding_step {
            id
            item_type
          }
          next_required_step
        }
      }
    `
    return this.graphqlClient.request<Any>(query, undefined, this.orgHeaders())
  }

  async getUserById(id: string, authHeader?: string): Promise<Any> {
    const query = gql`
      query getUserById($id: ID!) {
        user(id: $id) {
          id
          full_name
          first_name
          last_name
          dob
          gender
          email
          phone_number
          avatar_url
          timezone
          metadata
          last_conversation_id
          dietitian_id
          providers {
            id
            email
          }
          location {
            id
            line1
            state
            city
            zip
          }
          dietitian {
            id
            email
            full_name
            avatar_url
            qualifications
          }
          created_at
          updated_at
          next_onboarding_step {
            id
            item_type
          }
          next_required_step
          other_provider_ids
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(
        query,
        { id },
        {
          Authorization: authHeader ?? `Bearer ${this.config.HEALTHIE_API_AUTH_TOKEN}`,
          AuthorizationSource: "API",
        },
      )
      return response.user as Any
    } catch (error) {
      return handleError(error)
    }
  }

  async updateUserById(
    id: string,
    authorization: string,
    updateUserDto: {
      firstName?: string
      lastName?: string
      phoneNumber?: string
      timeZone?: string
      dob?: string
      gender?: string
      seenWelcome?: boolean
      seenOnboardingCompletePage?: boolean
    },
    file?: UploadedFile,
  ) {
    const variables = {
      id,
      ...(updateUserDto.firstName && { first_name: updateUserDto.firstName }),
      ...(updateUserDto.lastName && { last_name: updateUserDto.lastName }),
      ...(updateUserDto.phoneNumber && { phone_number: updateUserDto.phoneNumber }),
      ...(updateUserDto.timeZone && { timezone: updateUserDto.timeZone }),
      ...(updateUserDto.dob && { dob: updateUserDto.dob }),
      ...(updateUserDto.gender && { gender: updateUserDto.gender }),
      ...(updateUserDto.seenWelcome && { seen_welcome: updateUserDto.seenWelcome }),
      ...(updateUserDto.seenOnboardingCompletePage && {
        seen_onboarding_complete_page: updateUserDto.seenOnboardingCompletePage,
      }),
      ...(file && { avatar: toBlob(file) }),
    }
    const mutation = gql`
      mutation updateUser(
        $id: ID
        $first_name: String
        $last_name: String
        $dob: String
        $gender: String
        $phone_number: String
        $timezone: String
        $seen_welcome: Boolean
        $seen_onboarding_complete_page: Boolean
        $avatar: Upload
      ) {
        updateUser(
          input: {
            id: $id
            first_name: $first_name
            last_name: $last_name
            dob: $dob
            gender: $gender
            phone_number: $phone_number
            timezone: $timezone
            seen_welcome: $seen_welcome
            seen_onboarding_complete_page: $seen_onboarding_complete_page
            avatar: $avatar
          }
        ) {
          user {
            id
            first_name
            last_name
            dob
            gender
            email
            phone_number
            avatar_url
            timezone
            metadata
            location {
              id
              line1
              city
              state
              zip
            }
            last_conversation_id
            dietitian_id
            billing_items {
              id
              is_canceled
              recurring_payment {
                next_payment_date
              }
              offering {
                id
              }
            }
            dietitian {
              id
              full_name
              avatar_url
              qualifications
            }
            stripe_customer_detail {
              card_type
              card_type_label
              last_four
              stripe_id
            }
            created_at
            updated_at
            next_onboarding_step {
              id
              item_type
            }
            next_required_step
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlFileUploadClient.request(mutation, variables, {
        headers: { Authorization: authorization, AuthorizationSource: "API" },
      })
      return response.updateUser as { user: Any; messages?: FieldMessages }
    } catch (error) {
      handleError(error)
      return { user: null } as Any
    }
  }

  async removeProfilePhoto(id: string, authorization: string) {
    const mutation = gql`
      mutation updateUser($id: ID) {
        updateUser(input: { id: $id, avatar: null }) {
          user {
            id
            avatar_url
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(
        mutation,
        { id },
        { Authorization: authorization, AuthorizationSource: "API" },
      )
      return response.updateUser as { user: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { user: null } as Any
    }
  }

  async updateUserInformation(
    authorization: string,
    id: string,
    updateUserDto: {
      firstName?: string
      lastName?: string
      phoneNumber?: string
      timeZone?: string
    },
  ) {
    const variables: Record<string, string> = { id }
    if (updateUserDto.firstName) variables.first_name = updateUserDto.firstName
    if (updateUserDto.lastName) variables.last_name = updateUserDto.lastName
    if (updateUserDto.phoneNumber) variables.phone_number = updateUserDto.phoneNumber
    if (updateUserDto.timeZone) variables.timezone = updateUserDto.timeZone
    const mutation = gql`
      mutation updateUser(
        $id: ID
        $first_name: String
        $last_name: String
        $phone_number: String
        $timezone: String
      ) {
        updateUser(
          input: {
            id: $id
            first_name: $first_name
            last_name: $last_name
            phone_number: $phone_number
            timezone: $timezone
          }
        ) {
          user {
            id
            first_name
            last_name
            email
            phone_number
            timezone
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(mutation, variables, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })
      return response.updateUser as { user: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { user: null } as Any
    }
  }

  async updateUserPassword(
    id: string,
    authorization: string,
    updatePasswordDto: { oldPassword?: string; newPassword?: string; confirmNewPassword?: string },
  ) {
    const variables: Record<string, string> = { id }
    if (updatePasswordDto.oldPassword) variables.current_password = updatePasswordDto.oldPassword
    if (updatePasswordDto.newPassword) variables.password = updatePasswordDto.newPassword
    if (updatePasswordDto.confirmNewPassword) {
      variables.password_confirmation = updatePasswordDto.confirmNewPassword
    }
    const mutation = gql`
      mutation updateUser(
        $current_password: String
        $password: String
        $password_confirmation: String
      ) {
        updateUser(
          input: {
            current_password: $current_password
            password: $password
            password_confirmation: $password_confirmation
          }
        ) {
          user {
            next_required_step
            blast_seen
            id
            email
            consented_to_labs
            skipped_email
            __typename
          }
          messages {
            field
            message
            __typename
          }
          __typename
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(mutation, variables, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })
      return response.updateUser as { user: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { user: null } as Any
    }
  }

  async getLocationById(locationId: string, authorization: string) {
    const query = gql`
      query location($id: ID) {
        location(id: $id) {
          id
          line1
          state
          city
          zip
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(
        query,
        { id: locationId },
        { Authorization: authorization, AuthorizationSource: "API" },
      )
      return response.location as Any
    } catch (error: unknown) {
      handleError(error)
      return {}
    }
  }

  async listAllLocations(authorization: string) {
    const query = gql`
      query locations {
        locations {
          id
          line1
          state
          city
          zip
        }
      }
    `
    try {
      return (await this.graphqlClient.request(query, undefined, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })) as Any
    } catch (error: unknown) {
      handleError(error)
      return {}
    }
  }

  async createLocation(
    id: string,
    userLocationsDto: {
      line1: string
      line2?: string
      state: string
      country: string
      zip: string
    },
    authorization: string,
  ) {
    const variables = {
      user_id: id,
      line1: userLocationsDto.line1,
      // Verbatim consumer bug: the city variable is filled from line2 (see acceptance test).
      city: userLocationsDto.line2,
      state: userLocationsDto.state,
      country: userLocationsDto.country,
      zip: userLocationsDto.zip,
      ...(userLocationsDto.line2 && { line2: userLocationsDto.line2 }),
    }
    const mutation = gql`
      mutation createLocation(
        $user_id: String
        $line1: String
        $zip: String
        $city: String
        $country: String
        $state: String
      ) {
        createLocation(
          input: {
            user_id: $user_id
            line1: $line1
            zip: $zip
            city: $city
            country: $country
            state: $state
          }
        ) {
          location {
            id
            line1
            line2
            city
            state
            country
            zip
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlFileUploadClient.request(mutation, variables, {
        headers: { Authorization: authorization, AuthorizationSource: "API" },
      })
      return response.createLocation as { location: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { location: null } as Any
    }
  }

  async updateHealthieAddress(
    healthieLocationId: string,
    dto: {
      line1?: string
      line2?: string
      city?: string
      state?: string
      country?: string
      zip?: string
    },
    authorization: string,
  ) {
    const variables: Record<string, string> = { location_id: healthieLocationId }
    if (dto.line1) variables.address_line1 = dto.line1
    if (dto.line2) variables.address_line2 = dto.line2
    if (dto.city) variables.city = dto.city
    if (dto.state) variables.state = dto.state
    if (dto.country) variables.country = dto.country
    if (dto.zip) variables.zip = dto.zip
    const mutation = gql`
      mutation updateLocation(
        $location_id: String
        $address_line1: String
        $address_line2: String
        $city: String
        $state: String
        $country: String
        $zip: String
      ) {
        updateLocation(
          input: {
            id: $location_id
            line1: $address_line1
            line2: $address_line2
            city: $city
            state: $state
            country: $country
            zip: $zip
          }
        ) {
          location {
            id
            line1
            line2
            city
            state
            country
            zip
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(mutation, variables, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })
      return response.updateLocation as { location: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { location: null } as Any
    }
  }

  async getCurrentUser(authorization: string) {
    const query = gql`
      query getCurrentUser {
        currentUser {
          id
          active
          first_name
          last_name
          dob
          gender
          email
          phone_number
          avatar_url
          timezone
          metadata
          location {
            id
            state
            line1
            line2
            city
            zip
          }
          metadata
          last_conversation_id
          dietitian_id
          dietitian {
            id
            full_name
            avatar_url
            qualifications
            timezone
          }
          providers {
            id
            full_name
            avatar_url
            qualifications
            timezone
          }
          stripe_customer_detail {
            card_type
            card_type_label
            last_four
            stripe_id
          }
          created_at
          updated_at
          next_onboarding_step {
            id
            item_type
          }
          next_required_step
          has_forms_to_complete
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(query, undefined, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })
      return response.currentUser as Any
    } catch (error) {
      handleError(error)
      return null
    }
  }

  async getUserByEmail(email: string) {
    const query = gql`
      query ListPatients($email: String) {
        users(keywords: $email) {
          id
          email
          first_name
          dietitian {
            id
            full_name
            avatar_url
            qualifications
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(query, { email }, this.orgHeaders())
      return response.users as Any[]
    } catch (error) {
      handleError(error)
      return []
    }
  }

  async updateClientById(id: string, metadata: string | null, phoneNumber?: string) {
    const variables = {
      id,
      ...(metadata && { metadata }),
      ...(phoneNumber && { phone_number: phoneNumber }),
    }
    const paramTypes = ["$id: ID"]
    const paramValues = ["id: $id"]
    if (metadata) {
      paramTypes.push("$metadata: String")
      paramValues.push("metadata: $metadata")
    }
    if (phoneNumber) {
      paramTypes.push("$phone_number: String")
      paramValues.push("phone_number: $phone_number")
    }
    const mutation = gql`
      mutation updateClient(${paramTypes.join(", ")}) {
        updateClient(input: {${paramValues.join(", ")}}) {
          user {
            id
            first_name
            last_name
            dob
            gender
            email
            phone_number
            avatar_url
            timezone
            metadata
            location {
              id
              line1
              line2
              city
              state
              zip
            }
            last_conversation_id
            dietitian_id
            billing_items {
              id
              is_canceled
              recurring_payment {
                next_payment_date
              }
              offering {
                id
              }
            }
            dietitian {
              id
              full_name
              avatar_url
              qualifications
            }
            stripe_customer_detail {
              card_type
              card_type_label
              last_four
              stripe_id
            }
            created_at
            updated_at
            next_onboarding_step {
              id
              item_type
            }
            next_required_step
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(mutation, variables, this.orgHeaders())
      return response.updateClient as { user: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { user: null, messages: null } as Any
    }
  }

  async updateClientGroupById(id: string, userGroupId: string, providerIds: string[] = []) {
    const variables = {
      id,
      user_group_id: userGroupId,
      ...(providerIds.length && { other_provider_ids: providerIds }),
    }
    const mutation = gql`
    mutation updateClient($id: ID, $user_group_id: String${providerIds.length !== 0 ? ", $other_provider_ids: [String]" : ""}) {
      updateClient(input: { id: $id, user_group_id: $user_group_id${providerIds.length !== 0 ? ", other_provider_ids: $other_provider_ids" : ""} }) {
        user {
          id
          email
        }
        messages {
          field
          message
        }
      }
    }
  `
    try {
      const response: Any = await this.graphqlClient.request(mutation, variables, this.orgHeaders())
      return response.updateClient as { user: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { user: null, messages: null } as Any
    }
  }

  async updateClientPassword(id: string, password: string) {
    const mutation = gql`
      mutation updateClient($id: ID, $password: String) {
        updateClient(input: { id: $id, password: $password }) {
          user {
            id
            first_name
            email
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(
        mutation,
        { id, password },
        this.orgHeaders(),
      )
      return response.updateClient as { user: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { user: null, messages: null } as Any
    }
  }

  async updateCheckoutPatientById(data: {
    id: string
    first_name: string
    last_name: string
    timezone: string
    dob: string
    gender: string
    phone_number: string
    location: { city: string; line1: string; line2?: string; state: string; zip: string }
  }) {
    const variables = {
      id: data.id,
      first_name: data.first_name,
      last_name: data.last_name,
      timezone: data.timezone,
      dob: data.dob,
      gender: data.gender,
      phone_number: data.phone_number,
      location: {
        city: data.location.city,
        line1: data.location.line1,
        line2: data.location.line2,
        state: data.location.state,
        zip: data.location.zip,
      },
    }
    const mutation = gql`
      mutation updateClient(
        $id: ID!
        $first_name: String
        $last_name: String
        $dob: String
        $gender: String
        $phone_number: String
        $location: ClientLocationInput
      ) {
        updateClient(
          input: {
            id: $id
            first_name: $first_name
            last_name: $last_name
            dob: $dob
            gender: $gender
            phone_number: $phone_number
            location: $location
          }
        ) {
          user {
            id
            first_name
            last_name
            legal_name
            email
            gender
            dob
            phone_number
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(mutation, variables, this.orgHeaders())
      return response.updateClient as { user: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { user: null, messages: null } as Any
    }
  }

  async addProvidersToUser(userId: string, newProviderIds: string[] = []) {
    const user = await this.getUserById(userId)
    if (!user) return false
    const primaryProvider = user.dietitian_id
    const existingOtherProviders: string[] = user.other_provider_ids ?? []
    const allOtherProviders = [
      ...new Set([
        ...existingOtherProviders,
        ...newProviderIds.filter((id) => id !== primaryProvider),
      ]),
    ]
    const mutation = gql`
      mutation updateClient($id: ID!, $other_provider_ids: [String]) {
        updateClient(input: { id: $id, other_provider_ids: $other_provider_ids }) {
          user {
            id
            other_provider_ids
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(
        mutation,
        { id: userId, other_provider_ids: allOtherProviders },
        this.orgHeaders(),
      )
      if (response.updateClient.messages?.length) return false
      return true
    } catch (error) {
      handleError(error)
      return false
    }
  }

  async listFiles(
    authorization: string,
    listFilesDto: { fileSharingFilter: "shared" | "all" | "uploaded"; sortBy?: string },
    folderId?: string,
  ) {
    const { fileSharingFilter, sortBy } = listFilesDto
    const variables = {
      sort_by: sortBy,
      should_paginate: false,
      ...(folderId && { folder_id: folderId }),
    }
    const query = gql`
      query listFiles(
        $sort_by: String
        $filter: String
        $should_paginate: Boolean
        $folder_id: String
      ) {
        currentUser {
          id
        }

        documents(
          sort_by: $sort_by
          filter: $filter
          should_paginate: $should_paginate
          folder_id: $folder_id
        ) {
          id
          display_name
          file_content_type
          created_at
          owner {
            id
            email
          }
          rel_user {
            id
            email
          }
          expiring_url
        }

        folders(
          sort_by: $sort_by
          filter: $filter
          should_paginate: $should_paginate
          folder_id: $folder_id
        ) {
          id
          name
          folder_id
          created_at
          owner {
            id
            email
          }
          rel_user {
            id
            email
          }
        }
      }
    `
    let response: Any = { currentUser: null, documents: [], folders: [] }
    try {
      response = await this.graphqlClient.request(query, variables, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })
    } catch (error: unknown) {
      handleError(error)
    }
    const { documents, folders, currentUser } = response
    if (!currentUser) throw new HttpException(401, "Invalid API Key")
    const files: HealthieFile[] = [
      ...((documents as Any[] | undefined)?.map((document) => ({
        id: document.id,
        name: document.display_name,
        contentType: document.file_content_type,
        createdAt: dateToISOString(document.created_at),
        owner: document.owner,
        users: document.rel_user ? [document.rel_user] : [],
        fileType: "document" as const,
        parentFolderId: folderId ?? null,
        expiring_url: document.expiring_url ?? undefined,
      })) ?? []),
      ...((folders as Any[] | undefined)?.map((folder) => ({
        id: folder.id,
        name: folder.name,
        createdAt: dateToISOString(folder.created_at),
        owner: folder.owner,
        users: folder.rel_user ? [folder.rel_user] : [],
        fileType: "folder" as const,
        parentFolderId: folder.folder_id,
      })) ?? []),
    ]
    let filteredFiles: HealthieFile[] = []
    switch (fileSharingFilter) {
      case "uploaded":
        filteredFiles = files.filter((file) => file.owner.id === currentUser.id)
        break
      case "shared":
        filteredFiles = files.filter((file) => file.owner.id !== currentUser.id)
        break
      case "all":
        filteredFiles = files
        break
    }
    return { files: filteredFiles }
  }

  async getDocumentById(authorization: string, id: string) {
    const query = gql`
      query document($id: ID) {
        document(id: $id) {
          id
          display_name
          file_content_type
          opens {
            id
          }
          owner {
            id
            email
          }
          users {
            id
            email
          }
          expiring_url
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(
        query,
        { id },
        { Authorization: authorization, AuthorizationSource: "API" },
      )
      return response.document as Any
    } catch (error: unknown) {
      return handleError(error)
    }
  }

  async filterFoldersByKeyword(authorization: string, keywords: string, parentFolderId?: string) {
    const variables = {
      shouldPaginate: false,
      keywords,
      ...(parentFolderId && { folder_id: parentFolderId }),
    }
    const query = gql`
      query filterFoldersByKeyword(
        $shouldPaginate: Boolean
        $keywords: String
        $folder_id: String
      ) {
        folders(should_paginate: $shouldPaginate, filter: $keywords, folder_id: $folder_id) {
          id
          name
          folder_id
          created_at
          owner {
            id
            email
          }
          users {
            id
            email
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(query, variables, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })
      return response.folders as { id: string; name: string }[]
    } catch (error: unknown) {
      return handleError(error)
    }
  }

  async getFolderByPath(authorization: string, path: string, createIfNotFound = false) {
    const segments = path.split("/")
    let currentFolder: { id: string; name: string } | undefined
    let startCreatingFolders = false
    for (const segment of segments) {
      const folders = !startCreatingFolders
        ? ((await this.filterFoldersByKeyword(authorization, segment, currentFolder?.id))?.filter(
            (f) => f.name.toLowerCase() === segment.toLowerCase(),
          ) ?? [])
        : []
      if (folders.length) {
        currentFolder = folders[0]
      } else if (createIfNotFound) {
        const { folder, messages } = (await this.createFolder(authorization, {
          folderName: segment,
          parentFolderId: currentFolder?.id,
        })) as { folder: Any; messages?: FieldMessages }
        if (!folder || messages) {
          throw new HttpException(
            500,
            `Failed to create folder "${segment}" for path "${path}"` +
              (messages ? `: ${messages.map((m) => m.message).join(", ")}` : ""),
          )
        }
        currentFolder = folder
        startCreatingFolders = true
      }
    }
    return currentFolder
  }

  async createDocument(
    authorization: string,
    createDocumentDto: { filename: string; parentFolderId?: string | undefined },
    file: UploadedFile,
    shareUsers?: string,
  ) {
    const variables = {
      file: toBlob(file),
      display_name: createDocumentDto.filename,
      ...(createDocumentDto.parentFolderId && { folder_id: createDocumentDto.parentFolderId }),
      ...(shareUsers && { share_users: shareUsers }),
    }
    const mutation = gql`
      mutation createDocument(
        $file: Upload
        $display_name: String
        $folder_id: String
        $share_users: String
      ) {
        createDocument(
          input: {
            file: $file
            display_name: $display_name
            folder_id: $folder_id
            share_users: $share_users
          }
        ) {
          document {
            id
            display_name
            file_content_type
            opens {
              id
            }
            owner {
              id
              email
            }
            users {
              id
              first_name
              email
            }
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlFileUploadClient.request(mutation, variables, {
        headers: { Authorization: authorization, AuthorizationSource: "API" },
      })
      return response.createDocument as { document: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { document: null } as Any
    }
  }

  async createFolder(
    authorization: string,
    createFolderDto: { folderName: string; parentFolderId?: string | undefined },
    shareUsers?: string,
  ) {
    const { files } = await this.listFiles(
      authorization,
      { sortBy: "newestfirst", fileSharingFilter: "all" },
      createFolderDto.parentFolderId ?? undefined,
    )
    if (
      files.some((file) => file.name === createFolderDto.folderName && file.fileType === "folder")
    ) {
      throw new HttpException(400, "Folder with the same name already exists")
    }
    const variables = {
      name: createFolderDto.folderName,
      ...(createFolderDto.parentFolderId && { folder_id: createFolderDto.parentFolderId }),
      ...(shareUsers && { share_users: shareUsers }),
    }
    const mutation = gql`
      mutation createFolder($name: String, $folder_id: String) {
        createFolder(input: { name: $name, folder_id: $folder_id }) {
          folder {
            id
            name
            folder_id
            owner {
              id
              email
            }
            users {
              id
              email
            }
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(mutation, variables, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })
      return response.createFolder as { folder: Any; messages: FieldMessages }
    } catch (error) {
      handleError(error)
      return { folder: null } as Any
    }
  }

  async deleteDocumentById(authorization: string, id: string) {
    const query = gql`
      mutation deleteDocument($id: ID) {
        deleteDocument(input: { id: $id }) {
          document {
            id
          }

          messages {
            field
            message
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(
        query,
        { id },
        { Authorization: authorization, AuthorizationSource: "API" },
      )
      return response.deleteDocument as { document: Any; messages: FieldMessages }
    } catch (error: unknown) {
      handleError(error)
      return { document: null } as Any
    }
  }

  async getFormAnswers(
    authorization: string,
    id: string | undefined,
    getFormAnswersDto: { formId: string },
    userId: string,
  ) {
    const variables = {
      ...(id && { incomplete_form_id: id }),
      custom_module_form_id: getFormAnswersDto.formId,
      user_id: userId,
    }
    const query = gql`
      query initialFormAnswers($incomplete_form_id: ID, $custom_module_form_id: ID, $user_id: ID) {
        initialFormAnswers(
          custom_module_form_id: $custom_module_form_id
          incomplete_form_id: $incomplete_form_id
          user_id: $user_id
        ) {
          answer
          custom_module_id
          user_id
          conditional_custom_module_id
          filter_type
          value_to_filter
          label
        }
      }
    `
    try {
      return (await this.graphqlClient.request(query, variables, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })) as Any
    } catch (error: unknown) {
      handleError(error)
      return { initialFormAnswers: undefined }
    }
  }

  async getRequestedFormById(id: string) {
    const query = gql`
      query requestedFormCompletion($id: ID) {
        requestedFormCompletion(id: $id) {
          id
          recipient {
            first_name
            email
          }
          sender {
            full_name
            qualifications
            avatar_url
          }
        }
      }
    `
    try {
      const response: Any = await this.graphqlClient.request(query, { id }, this.orgHeaders())
      return response.requestedFormCompletion as Any
    } catch (error: unknown) {
      handleError(error)
      return undefined
    }
  }

  async listBillingItems(
    authorization: string,
    offeringsOnly = true,
    clientId?: string,
    status?: string[],
  ) {
    const variables = {
      offerings_only: offeringsOnly,
      ...(clientId && { client_id: clientId }),
      ...(status && { status }),
    }
    const query = gql`
      query billingItems($offerings_only: Boolean${clientId ? ", $client_id: ID" : ""}${status ? ", $status: [String]" : ""}) {
        billingItems(offerings_only: $offerings_only${clientId ? ", client_id: $client_id" : ""}${status ? ", status: $status" : ""}) {
          id
          amount_paid
          state
          is_canceled
          created_at
          stripe_charge_id
          is_recurring
          is_canceled
          offering_id
          offering {
            id
            name
            billing_frequency
            currency
            price
          }
          sender {
            stripe_customer_detail {
              last_four
              card_type
            }
          }
          recurring_payment {
            offering_id
            is_paused
            next_payment_date
            billing_frequency
          }
        }
      }
    `
    try {
      return (await this.graphqlClient.request(query, variables, {
        Authorization: authorization,
        AuthorizationSource: "API",
      })) as Any
    } catch (error) {
      handleError(error)
      return { billingItems: [] }
    }
  }

  async pauseBillingItem(billingItemId: string, isPaused: boolean) {
    const variables = { id: billingItemId, is_paused: isPaused, note: Date.now().toString() }
    const mutation = gql`
      mutation updateBillingItem($id: ID, $is_paused: Boolean, $note: String) {
        updateBillingItem(input: { id: $id, is_paused: $is_paused }) {
          billingItem {
            id
            note
            recurring_payment {
              is_paused
              next_payment_date
            }
            offering {
              id
            }
            sender {
              id
              metadata
            }
          }
          messages {
            field
            message
          }
        }
        updateBillingWebhook: updateBillingItem(input: { id: $id, note: $note }) {
          billingItem {
            id
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      return (await this.graphqlClient.request(mutation, variables, this.orgHeaders())) as Any
    } catch (error) {
      handleError(error)
      return null
    }
  }

  async cancelSubscription(billingItemId: string) {
    const variables = { id: billingItemId, is_canceled: true, note: Date.now().toString() }
    const mutation = gql`
      mutation updateBillingItem($id: ID, $is_canceled: Boolean, $note: String) {
        updateBillingItem(input: { id: $id, is_canceled: $is_canceled }) {
          billingItem {
            id
          }
          messages {
            field
            message
          }
        }
        updateBillingWebhook: updateBillingItem(input: { id: $id, note: $note }) {
          billingItem {
            id
          }
          messages {
            field
            message
          }
        }
      }
    `
    try {
      return (await this.graphqlClient.request(mutation, variables, this.orgHeaders())) as Any
    } catch (error) {
      handleError(error)
      return null
    }
  }

  async fetchOfferingsById(id: string) {
    const variables = { client_visibility: "all", should_paginate: false, offering_id: id }
    const query = gql`
      query getOfferings($should_paginate: Boolean, $client_visibility: String, $offering_id: ID) {
        offerings(
          should_paginate: $should_paginate
          client_visibility: $client_visibility
          offering_id: $offering_id
        ) {
          id
          name
          billing_frequency
          currency
          price
          visibility_status
        }
      }
    `
    try {
      return (await this.graphqlClient.request(query, variables, this.orgHeaders())) as Any
    } catch (error) {
      handleError(error)
      return { offerings: [] }
    }
  }

  async getAllChartingNoteDocuments(userId: string) {
    const query = gql`
      query GetUserDocuments($user_id: String!) {
        formAnswerGroups(user_id: $user_id) {
          id
          name
          filler {
            id
            name
            email
          }
          created_at
          updated_at
        }
      }
    `
    try {
      return (await this.graphqlClient.request(
        query,
        { user_id: userId },
        this.orgHeaders(),
      )) as Any
    } catch (error: unknown) {
      handleError(error)
      return { formAnswerGroups: null }
    }
  }

  async getSingleChartingNoteDocument(documentId: string) {
    const query = gql`
      query GetDocumentContent($id: ID!) {
        formAnswerGroup(id: $id) {
          id
          name
          created_at
          updated_at
          user {
            id
            full_name
          }
          custom_module_form {
            name
          }
          form_answers {
            id
            label
            displayed_answer
          }
        }
      }
    `
    try {
      return (await this.graphqlClient.request(query, { id: documentId }, this.orgHeaders())) as Any
    } catch (error: unknown) {
      handleError(error)
      return { formAnswerGroup: null }
    }
  }
}

/** `UsersService.signIn`'s outcome mapping over `HealthieClientService.signIn`. */
export const signInOutcome = async (
  client: HealthieConsumer,
  dto: { email: string; password: string },
): Promise<{ user: Any; api_key: string }> => {
  const { user, api_key: apiKey } = await client.signIn(dto)
  if (!user?.id || !apiKey) throw new HttpException(401, "INVALID_SIGN_IN_CREDENTIALS")
  if (!user.active) throw new HttpException(401, "USER_ARCHIVED")
  return { user, api_key: apiKey }
}

const allowedIps = (configured: string | undefined) =>
  configured?.split(",").filter((ip) => ip) ?? []

export type ReceiverOutcome =
  | { handled: false; reason: "no-ip" | "ip-not-configured" | "ip-not-allowed" | "not-found" }
  | { handled: true; action: string; detail?: Record<string, unknown> }

/**
 * `UsersController` `POST /users/webhook/status` + `UsersService.updatePatientWebhookData`:
 * only `x-forwarded-for` guards it; the user is re-read and caches are invalidated.
 */
export const receivePatientWebhook = async (
  client: HealthieConsumer,
  headers: Headers,
  body: { resource_id: string },
  HEALTHIE_WEBHOOK_IP_ADDRESS: string,
): Promise<ReceiverOutcome> => {
  const ip = headers.get("x-forwarded-for")
  if (!ip) return { handled: false, reason: "no-ip" }
  const ipAddresses = allowedIps(HEALTHIE_WEBHOOK_IP_ADDRESS)
  if (ipAddresses.length === 0) return { handled: false, reason: "ip-not-configured" }
  if (!ipAddresses.includes(ip)) return { handled: false, reason: "ip-not-allowed" }
  const users = await client.getUserById(body.resource_id)
  if (!users) return { handled: false, reason: "not-found" }
  if (!users.dietitian) return { handled: true, action: "flush-all-user-auth-caches" }
  return { handled: true, action: `flush-user-auth-cache:${users.id}` }
}

/**
 * `FormsController` `POST /forms/webhooks/status` + `FormsService.formRequestStatus`: reads
 * the requested form and builds the "you have a form to complete" email.
 */
export const receiveFormWebhook = async (
  client: HealthieConsumer,
  headers: Headers,
  body: { resource_id: string },
  HEALTHIE_WEBHOOK_IP_ADDRESS: string,
): Promise<ReceiverOutcome> => {
  const ip = headers.get("x-forwarded-for")
  if (!ip) return { handled: false, reason: "no-ip" }
  const ipAddress = allowedIps(HEALTHIE_WEBHOOK_IP_ADDRESS)
  if (ipAddress.length === 0) return { handled: false, reason: "ip-not-configured" }
  if (!ipAddress.includes(ip)) return { handled: false, reason: "ip-not-allowed" }
  const res = await client.getRequestedFormById(body.resource_id)
  if (!res) return { handled: false, reason: "not-found" }
  // Verbatim: the cache key reads recipient.id, which the query never selects.
  const userAuthCacheKey = `user-auth:${res.recipient.id}`
  return {
    handled: true,
    action: "send-forms-email",
    detail: {
      userAuthCacheKey,
      username: res.recipient.first_name,
      toEmail: res.recipient.email,
      provider_full_name: res.sender.full_name,
      avatar_url: res.sender.avatar_url ?? "",
      qualifications: res.sender.qualifications,
    },
  }
}
