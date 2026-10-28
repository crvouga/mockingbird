/**
 * The other bucket configuration documents MinIO decodes: server-side encryption
 * (`internal/bucket/encryption`), event notification (`internal/event`) and replication
 * (`internal/bucket/replication`), each with the errors MinIO raises in document order.
 */
import type { ErrorName } from "../errors.js"
import { GoError, goInt, parseGoXml, type XNode } from "./goxml.js"

const expectRoot = (root: XNode, name: string) => {
  if (root.name !== name)
    throw new GoError("unmarshal", `expected element type <${name}> but have <${root.name}>`)
}

// ── encryption ───────────────────────────────────────────────────────────────

/** `sse.ParseBucketSSEConfig` + `validateBucketSSEConfig`; throws `GoError("plain" | ...)`. */
export const parseSseConfig = (body: string) => {
  const root = parseGoXml(body)
  expectRoot(root, "ServerSideEncryptionConfiguration")
  const rules: { algorithm: string; key: string }[] = []
  for (const rule of root.children) {
    if (rule.name !== "Rule") continue
    const parsed = { algorithm: "", key: "" }
    for (const action of rule.children) {
      if (action.name !== "ApplyServerSideEncryptionByDefault") continue
      for (const field of action.children) {
        if (field.name === "SSEAlgorithm") {
          if (field.text !== "AES256" && field.text !== "aws:kms")
            throw new GoError("plain", "Unknown SSE algorithm")
          parsed.algorithm = field.text
        } else if (field.name === "KMSMasterKeyID") parsed.key = field.text
      }
    }
    rules.push(parsed)
  }
  if (rules.length !== 1)
    throw new GoError("plain", "only one server-side encryption rule is allowed at a time")
  for (const rule of rules) {
    if (rule.algorithm === "AES256" && rule.key !== "")
      throw new GoError("plain", "MasterKeyID is allowed with aws:kms only")
    if (rule.algorithm === "aws:kms") {
      if (rule.key === "") throw new GoError("plain", "MasterKeyID is missing with aws:kms")
      if (rule.key.startsWith(" ") || rule.key.endsWith(" "))
        throw new GoError("plain", "MasterKeyID contains unsupported characters")
    }
  }
  return rules
}

// ── notification ─────────────────────────────────────────────────────────────

export const EVENT_NAMES = new Set([
  "s3:BucketCreated:*",
  "s3:BucketRemoved:*",
  "s3:ObjectAccessed:*",
  "s3:ObjectAccessed:Get",
  "s3:ObjectAccessed:GetRetention",
  "s3:ObjectAccessed:GetLegalHold",
  "s3:ObjectAccessed:Head",
  "s3:ObjectAccessed:Attributes",
  "s3:ObjectCreated:*",
  "s3:ObjectCreated:CompleteMultipartUpload",
  "s3:ObjectCreated:Copy",
  "s3:ObjectCreated:Post",
  "s3:ObjectCreated:Put",
  "s3:ObjectCreated:PutRetention",
  "s3:ObjectCreated:PutLegalHold",
  "s3:ObjectCreated:PutTagging",
  "s3:ObjectCreated:DeleteTagging",
  "s3:ObjectRemoved:*",
  "s3:ObjectRemoved:Delete",
  "s3:ObjectRemoved:DeleteMarkerCreated",
  "s3:ObjectRemoved:NoOP",
  "s3:ObjectRemoved:DeleteAllVersions",
  "s3:LifecycleDelMarkerExpiration:Delete",
  "s3:Replication:*",
  "s3:Replication:OperationFailedReplication",
  "s3:Replication:OperationCompletedReplication",
  "s3:Replication:OperationMissedThreshold",
  "s3:Replication:OperationReplicatedAfterThreshold",
  "s3:Replication:OperationNotTracked",
  "s3:ObjectRestore:*",
  "s3:ObjectRestore:Post",
  "s3:ObjectRestore:Completed",
  "s3:ObjectTransition:Failed",
  "s3:ObjectTransition:Complete",
  "s3:ObjectTransition:*",
  "s3:Scanner:ManyVersions",
  "s3:Scanner:LargeVersions",
  "s3:Scanner:BigPrefix",
])

/** An `internal/event` error: the API error `toAPIError` maps it to. */
export class EventError extends Error {
  constructor(readonly api: ErrorName) {
    super(api)
  }
}

type Queue = {
  id: string
  rules: { name: string; value: string }[]
  events: string[]
  arn: { region: string; id: string; name: string }
}

const parseArn = (value: string) => {
  const tokens = value.split(":")
  if (!value.startsWith("arn:minio:sqs:") || tokens.length !== 6 || !tokens[4] || !tokens[5])
    throw new EventError("ARNNotification")
  return { region: tokens[3] as string, id: tokens[4] as string, name: tokens[5] as string }
}

const decodeQueue = (node: XNode): Queue => {
  const queue: Queue = { id: "", rules: [], events: [], arn: { region: "", id: "", name: "" } }
  for (const child of node.children) {
    if (child.name === "Id") queue.id = child.text
    else if (child.name === "Event") {
      if (!EVENT_NAMES.has(child.text)) throw new EventError("EventNotification")
      queue.events.push(child.text)
    } else if (child.name === "Queue") queue.arn = parseArn(child.text)
    else if (child.name === "Filter") {
      for (const key of child.children) {
        if (key.name !== "S3Key") continue
        const rules: { name: string; value: string }[] = []
        for (const ruleNode of key.children) {
          if (ruleNode.name !== "FilterRule") continue
          const rule = { name: "", value: "" }
          for (const field of ruleNode.children) {
            if (field.name === "Name") rule.name = field.text
            else if (field.name === "Value") rule.value = field.text
          }
          if (rule.name !== "prefix" && rule.name !== "suffix")
            throw new EventError("FilterNameInvalid")
          rules.push(rule)
        }
        const seen = new Set<string>()
        for (const rule of rules) {
          if (seen.has(rule.name))
            throw new EventError(rule.name === "prefix" ? "FilterNamePrefix" : "FilterNameSuffix")
          seen.add(rule.name)
        }
        queue.rules = rules
      }
    }
  }
  if (queue.events.length === 0) throw new GoError("plain", "missing event name(s)")
  if (new Set(queue.events).size !== queue.events.length) throw new EventError("OverlappingConfigs")
  return queue
}

/**
 * `event.ParseConfig` against MinIO's (empty) target list: only a configuration with no queues
 * is accepted, so the stored document is always the empty one.
 */
export const parseNotificationConfig = (body: string, region: string) => {
  const root = parseGoXml(body)
  expectRoot(root, "NotificationConfiguration")
  const queues: Queue[] = []
  let unsupported = false
  for (const child of root.children) {
    if (child.name === "QueueConfiguration") queues.push(decodeQueue(child))
    else if (child.name === "CloudFunctionConfiguration" || child.name === "TopicConfiguration")
      unsupported = true
  }
  for (let index = 0; index < queues.length - 1; index++)
    for (const other of queues.slice(index + 1)) {
      const first = queues[index] as Queue
      const second =
        other.arn.region !== "" && first.arn.region === ""
          ? { ...other, arn: { ...other.arn, region: "" } }
          : other
      if (JSON.stringify(first) === JSON.stringify(second))
        throw new EventError("OverlappingFilterNotification")
    }
  if (unsupported) throw new EventError("UnsupportedNotification")
  for (const queue of queues) {
    if (queue.arn.region !== "" && region !== "" && queue.arn.region !== region)
      throw new EventError("RegionNotification")
    throw new EventError("ARNNotification")
  }
}

/** The configuration MinIO stores and answers with: an empty one. */
export const EMPTY_NOTIFICATION =
  '<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></NotificationConfiguration>'

// ── replication ──────────────────────────────────────────────────────────────

/** `replication.ParseConfig`: the destination ARNs (or the `Role` ARN) the config names. */
export const parseReplicationConfig = (body: string) => {
  const root = parseGoXml(body)
  expectRoot(root, "ReplicationConfiguration")
  let role = ""
  const destinations: string[] = []
  for (const child of root.children) {
    if (child.name === "Role") role = child.text
    else if (child.name === "Rule") {
      let destination = ""
      for (const field of child.children) {
        if (field.name === "Priority") goInt(field.text)
        else if (field.name === "Destination") {
          let bucket = ""
          let storageClass = ""
          for (const part of field.children) {
            if (part.name === "Bucket") bucket = part.text
            else if (part.name === "StorageClass") storageClass = part.text
          }
          if (!bucket.startsWith("arn:aws:s3:::") && !bucket.startsWith("arn:minio:replication:"))
            throw new GoError("plain", `invalid destination '${bucket}'`)
          if (storageClass && storageClass !== "STANDARD" && storageClass !== "REDUCED_REDUNDANCY")
            throw new GoError("plain", `unknown storage class ${storageClass}`)
          destination = bucket
        }
      }
      destinations.push(destination)
    }
  }
  return role ? [role] : destinations
}

// ── durations ────────────────────────────────────────────────────────────────

const UNITS = new Set(["ns", "us", "µs", "μs", "ms", "s", "m", "h"])

/** Go's `time.ParseDuration` validity; returns the error message, or undefined when valid. */
export const goDurationError = (value: string): string | undefined => {
  const quoted = `"${value}"`
  let rest = value
  if (rest.startsWith("-") || rest.startsWith("+")) rest = rest.slice(1)
  if (rest === "0") return undefined
  if (rest === "") return `time: invalid duration ${quoted}`
  while (rest !== "") {
    const number = /^(\d*)(\.\d*)?/.exec(rest)
    const digits = number?.[0] ?? ""
    if (digits === "" || digits === "." || !/\d/.test(digits))
      return `time: invalid duration ${quoted}`
    rest = rest.slice(digits.length)
    const unit = /^[^0-9.]*/.exec(rest)?.[0] ?? ""
    if (unit === "") return `time: missing unit in duration ${quoted}`
    if (!UNITS.has(unit)) return `time: unknown unit "${unit}" in duration ${quoted}`
    rest = rest.slice(unit.length)
  }
  return undefined
}
