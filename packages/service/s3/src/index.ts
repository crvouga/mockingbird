import { sigV4AccessKeyId } from "@crvouga/mockingbird-service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"

export type { S3APIOptions, S3SeedObject } from "./api.js"
export { S3_MAX_UPLOAD_BYTES, S3_NAMESPACE, S3API } from "./api.js"
export type { S3Runtime, S3RuntimeOptions } from "./runtime.js"
export { createRuntime, S3_PRESETS } from "./runtime.js"
export type {
  BucketRecord,
  MultipartPart,
  MultipartUpload,
  ObjectVersion,
  ObjectVersion as S3Object,
} from "./state.js"
export type { S3Notification } from "./store.js"
export { document, operationIds, supportedOperationIds }
export const accessKeyCredential = sigV4AccessKeyId
