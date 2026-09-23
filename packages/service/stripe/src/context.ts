import { accountOf } from "./account.js"
import { type ApiEra, eraOf, STRIPE_API_VERSION } from "./version.js"

/** What the mock decided about a request before routing it. */
export type RequestInfo = {
  /** The account partition the request reads and writes. */
  account: string
  /** The API version the response is rendered at. */
  version: string
  era: ApiEra
  /** Made with a publishable key (the Stripe.js stand-in): only client-secret calls pass. */
  publishable: boolean
  /** Public base URL of the mock as this caller reaches it (hosted pages link back to it). */
  origin: string
  /** Validated `expand[]` paths, applied to the response after the handler runs. */
  expand?: string[]
  /** The query carried `expand=` (an empty list), which Stripe refuses once the read resolves. */
  expandEmpty?: boolean
}

const infos = new WeakMap<Request, RequestInfo>()

export const setRequestInfo = (request: Request, info: RequestInfo): void => {
  infos.set(request, info)
}

/** The request's info, or a default derived from its bearer key (direct handler use). */
export const requestInfo = (request: Request): RequestInfo =>
  infos.get(request) ?? {
    account: accountOf(request),
    version: STRIPE_API_VERSION,
    era: eraOf(STRIPE_API_VERSION),
    publishable: false,
    origin: new URL(request.url).origin,
  }
