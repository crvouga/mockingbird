import { type ErrorName, MINIO_ERRORS } from "./errors.generated.js"

export type { ErrorName }

export type S3ErrorOptions = {
  /** Replace the catalog message. */
  message?: string
  /** Replace the catalog status. */
  status?: number
  /** Replace the catalog code (for codes MinIO builds on the fly, e.g. `BadRequest`). */
  code?: string
  /** Extra response headers (e.g. `x-amz-delete-marker`). */
  headers?: Record<string, string>
  /** Override the `<Key>` / `<BucketName>` the request context would add ("" removes it). */
  key?: string
  bucket?: string
  /** Override `<Resource>`. */
  resource?: string
  /** `<ActualObjectSize>` / `<RangeRequested>` on InvalidRange. */
  actualObjectSize?: string
  rangeRequested?: string
  /** Extra elements after `<Message>` (e.g. `<Method>`/`<ResourceType>` on a CORS refusal). */
  fields?: Record<string, string>
  /** Answer with the `x-minio-error-*` headers and no body even for GET (`writeErrorResponseHeadersOnly`). */
  headersOnly?: boolean
}

/** An S3 error response from MinIO's own error table. Throw it from any handler. */
export class S3Error extends Error {
  readonly code: string
  readonly status: number
  constructor(
    readonly errorName: ErrorName,
    readonly options: S3ErrorOptions = {},
  ) {
    const [code, message, status] = MINIO_ERRORS[errorName]
    super(options.message ?? message)
    this.code = options.code ?? code
    this.status = options.status ?? status
  }
}

export const fail = (name: ErrorName, options?: S3ErrorOptions): never => {
  throw new S3Error(name, options)
}
