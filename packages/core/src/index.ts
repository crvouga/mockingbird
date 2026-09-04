/**
 * Anything that can answer a Fetch `Request` with a `Response`.
 *
 * Every Mockingbird service implements this, and every runtime adapter consumes it.
 * It is the only contract shared across the whole graph.
 */
export interface FetchAPI {
  fetch(request: Request): Promise<Response>
}

/** A bare function form of {@link FetchAPI}, compatible with `Bun.serve`, workerd, and Deno. */
export type FetchHandler = (request: Request) => Promise<Response>

/** Convert a {@link FetchAPI} into a plain {@link FetchHandler}. */
export const toFetchHandler = (api: FetchAPI): FetchHandler => {
  return (request) => api.fetch(request)
}

/** Wrap a plain handler as a {@link FetchAPI}. */
export const fromFetchHandler = (handler: FetchHandler): FetchAPI => {
  return { fetch: handler }
}
