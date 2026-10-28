import type { AuthType, Verified } from "./auth.js"
import type { Operation } from "./router.js"
import type { S3Core } from "./store.js"
import { doc } from "./xml.js"

export type Identity = {
  /** No credentials, or lenient mode treating an unsigned request as the owner. */
  anonymous: boolean
  accessKey?: string
}

/** Everything a handler needs about one request. */
export type Ctx = {
  core: S3Core
  request: Request
  method: string
  url: URL
  query: URLSearchParams
  headers: Headers
  /** Decoded bucket and key (`""` when absent). */
  bucket: string
  key: string
  /** Decoded request path, the `<Resource>` of an error. */
  path: string
  op: Operation
  auth: AuthType
  identity: Identity
  verified?: Verified
  now: number
  /**
   * The request payload: `aws-chunked` decoded (chunk signatures verified in strict mode),
   * `x-amz-content-sha256` and `Content-MD5` checked. Read once; later calls return the same bytes.
   */
  body(): Promise<Uint8Array>
  text(): Promise<string>
  /** Checksum trailers that arrived after an `aws-chunked` body (`x-amz-checksum-*`). */
  trailers(): Promise<Record<string, string>>
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response
export type Handlers = Partial<Record<Operation, Handler>>

/** An empty success response. */
export const ok = (headers: Record<string, string> = {}, status = 200) =>
  new Response(null, { status, headers })

/** An XML document response in MinIO's encoding. */
export const xmlResponse = (
  root: string,
  children: string,
  options: { headers?: Record<string, string>; status?: number; xmlns?: string | false } = {},
) =>
  new Response(doc(root, children, options.xmlns), {
    status: options.status ?? 200,
    headers: { "content-type": "application/xml", ...options.headers },
  })
