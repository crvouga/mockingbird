/**
 * awesome-graphql-client@0.14.1 ships types its package.json `exports` does not expose under
 * `moduleResolution: bundler`; this declares the part our consumer port uses.
 */
declare module "awesome-graphql-client" {
  export class GraphQLRequestError extends Error {
    query: string
    variables?: Record<string, unknown>
    response: Response
    extensions?: Record<string, unknown>
  }
  export class AwesomeGraphQLClient {
    constructor(config: {
      endpoint: string
      fetch?: (url: string, options?: RequestInit) => Promise<Response>
      FormData?: unknown
      fetchOptions?: RequestInit
      onError?: (error: Error) => void
      isFileUpload?: (value: unknown) => boolean
    })
    request<T = unknown>(
      query: string,
      variables?: Record<string, unknown>,
      fetchOptions?: RequestInit,
    ): Promise<T>
  }
}
