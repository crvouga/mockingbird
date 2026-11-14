/**
 * The AWS query protocol for SQS (2012-11-05): `Action=…` form parameters in, XML out. It only
 * translates. Each request becomes the AWS JSON input the handlers already take, and each JSON
 * answer becomes the documented XML, so both protocols share one implementation of every operation.
 */
import { awsXmlEscape } from "@crvouga/mockingbird-service"

type Input = Record<string, unknown>
type Params = [string, string][]

export const SQS_XMLNS = "http://queue.amazonaws.com/doc/2012-11-05/"

/** Integer members of the SQS model. They arrive as text and are numbers in AWS JSON. */
const INTEGERS = new Set([
  "DelaySeconds",
  "MaxNumberOfMessages",
  "MaxResults",
  "VisibilityTimeout",
  "WaitTimeSeconds",
])
/** Request members that are not operation input (SigV2 query auth and the API version). */
const IGNORED = new Set([
  "Action",
  "Version",
  "AWSAccessKeyId",
  "Signature",
  "SignatureMethod",
  "SignatureVersion",
  "Timestamp",
  "Expires",
  "SecurityToken",
])
/** Flattened query lists of strings: `AttributeName.1=…` (or a bare `AttributeName=…`). */
const STRING_LISTS: Record<string, string> = {
  AttributeName: "AttributeNames",
  MessageAttributeName: "MessageAttributeNames",
  MessageSystemAttributeName: "MessageSystemAttributeNames",
  TagKey: "TagKeys",
}
/** Batch entries per operation: `SendMessageBatchRequestEntry.N.*`. */
const BATCH_ENTRIES: Record<string, string> = {
  SendMessageBatch: "SendMessageBatchRequestEntry",
  DeleteMessageBatch: "DeleteMessageBatchRequestEntry",
  ChangeMessageVisibilityBatch: "ChangeMessageVisibilityBatchRequestEntry",
}

/** A query parameter's text as AWS JSON: integers become numbers, anything else stays text. */
const scalar = (name: string, value: string): unknown =>
  INTEGERS.has(name) && /^-?\d+$/.test(value) ? Number(value) : value

/** Group `Prefix.N.rest=value` by N (in index order) into `[rest, value]` lists. */
const indexed = (params: Params, prefix: string): Params[] => {
  const groups = new Map<number, Params>()
  for (const [key, value] of params) {
    const match = key.startsWith(`${prefix}.`) && /^(\d+)\.(.+)$/.exec(key.slice(prefix.length + 1))
    if (!match) continue
    const index = Number(match[1])
    groups.set(index, [...(groups.get(index) ?? []), [match[2] as string, value]])
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group)
}
const field = (group: Params, name: string) => group.find(([key]) => key === name)?.[1]

/** `Attribute.N.Name/Value` (or `Tag.N.Key/Value`) as a JSON map. */
const map = (params: Params, prefix: string, key: string, value: string) => {
  const entries = indexed(params, prefix)
    .map((group) => [field(group, key), field(group, value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[0] !== undefined)
  return entries.length
    ? Object.fromEntries(entries.map(([name, text]) => [name, text ?? ""]))
    : undefined
}

/** `MessageAttribute.N.Name` and `.Value.DataType|StringValue|BinaryValue` as JSON attributes. */
const messageAttributes = (params: Params, prefix: string) => {
  const result: Record<string, Record<string, string>> = {}
  for (const group of indexed(params, prefix)) {
    const name = field(group, "Name")
    if (name === undefined) continue
    result[name] = Object.fromEntries(
      group
        .filter(([key]) => key.startsWith("Value."))
        .map(([key, value]) => [key.slice("Value.".length), value]),
    )
  }
  return Object.keys(result).length ? result : undefined
}

/** One request's (or one batch entry's) parameters as its AWS JSON shape. */
const structure = (params: Params): Input => {
  const input: Input = {}
  for (const [key, value] of params)
    if (!key.includes(".") && !IGNORED.has(key)) input[key] = scalar(key, value)
  for (const [name, member] of Object.entries(STRING_LISTS)) {
    const values = params
      .filter(([key]) => key === name || new RegExp(`^${name}\\.\\d+$`).test(key))
      .sort(([a], [b]) => Number(a.split(".")[1] ?? 0) - Number(b.split(".")[1] ?? 0))
      .map(([, value]) => value)
    if (values.length) input[member] = values
  }
  const attributes = map(params, "Attribute", "Name", "Value")
  if (attributes) input.Attributes = attributes
  const tags = map(params, "Tag", "Key", "Value")
  if (tags) input.Tags = tags
  const message = messageAttributes(params, "MessageAttribute")
  if (message) input.MessageAttributes = message
  const system = messageAttributes(params, "MessageSystemAttribute")
  if (system) input.MessageSystemAttributes = system
  return input
}

/**
 * The AWS JSON input for a query request. `QueueUrl` may be a parameter or the request path
 * (`/<account>/<queue>`), as the query examples in the SQS API reference send it.
 */
export const queryInput = (action: string, params: Params, url: URL): Input => {
  const input = structure(params)
  const entries = BATCH_ENTRIES[action]
  if (entries) input.Entries = indexed(params, entries).map(structure)
  // CreateQueue's tag member is lower-case `tags` in AWS JSON; TagQueue's is `Tags`.
  if (action === "CreateQueue" && input.Tags) {
    input.tags = input.Tags
    delete input.Tags
  }
  if (input.QueueUrl === undefined && url.pathname.split("/").filter(Boolean).length >= 2)
    input.QueueUrl = `${url.origin}${url.pathname}`
  return input
}

/** XML text: AWS escapes markup and carriage returns, which an XML parser would otherwise fold. */
const text = (value: unknown) => awsXmlEscape(value).replace(/\r/g, "&#xD;")
const element = (tag: string, value: unknown) =>
  value === undefined || value === null ? "" : `<${tag}>${text(value)}</${tag}>`
const nameValues = (tag: string, record: unknown, key = "Name") =>
  Object.entries((record ?? {}) as Record<string, unknown>)
    .map(([name, value]) => `<${tag}>${element(key, name)}${element("Value", value)}</${tag}>`)
    .join("")
const fields = (value: unknown, names: readonly string[]) =>
  names.map((name) => element(name, (value as Input)[name])).join("")

const SEND_RESULT = [
  "Id",
  "MessageId",
  "MD5OfMessageBody",
  "MD5OfMessageAttributes",
  "MD5OfMessageSystemAttributes",
  "SequenceNumber",
] as const
const BATCH_ERROR = ["Id", "SenderFault", "Code", "Message"] as const

const message = (value: Input) => {
  const attributes = Object.entries((value.MessageAttributes ?? {}) as Record<string, Input>)
    .map(
      ([name, attribute]) =>
        `<MessageAttribute>${element("Name", name)}<Value>${fields(attribute, ["StringValue", "BinaryValue", "DataType"])}</Value></MessageAttribute>`,
    )
    .join("")
  return `<Message>${fields(value, ["MessageId", "ReceiptHandle", "MD5OfBody", "Body"])}${nameValues("Attribute", value.Attributes)}${element("MD5OfMessageAttributes", value.MD5OfMessageAttributes)}${attributes}</Message>`
}
const batch = (result: Input, entry: string, names: readonly string[]) =>
  [
    ...((result.Successful ?? []) as Input[]).map(
      (item) => `<${entry}>${fields(item, names)}</${entry}>`,
    ),
    ...((result.Failed ?? []) as Input[]).map(
      (item) => `<BatchResultErrorEntry>${fields(item, BATCH_ERROR)}</BatchResultErrorEntry>`,
    ),
  ].join("")

/** Each operation's `<Action>Result` body; operations missing here answer no Result element. */
const RESULTS: Record<string, (result: Input) => string> = {
  CreateQueue: (result) => element("QueueUrl", result.QueueUrl),
  GetQueueUrl: (result) => element("QueueUrl", result.QueueUrl),
  ListQueues: (result) =>
    ((result.QueueUrls ?? []) as unknown[]).map((url) => element("QueueUrl", url)).join("") +
    element("NextToken", result.NextToken),
  ListDeadLetterSourceQueues: (result) =>
    ((result.queueUrls ?? []) as unknown[]).map((url) => element("QueueUrl", url)).join("") +
    element("NextToken", result.NextToken),
  GetQueueAttributes: (result) => nameValues("Attribute", result.Attributes),
  ListQueueTags: (result) => nameValues("Tag", result.Tags, "Key"),
  SendMessage: (result) => fields(result, SEND_RESULT.slice(1)),
  SendMessageBatch: (result) => batch(result, "SendMessageBatchResultEntry", SEND_RESULT),
  DeleteMessageBatch: (result) => batch(result, "DeleteMessageBatchResultEntry", ["Id"]),
  ChangeMessageVisibilityBatch: (result) =>
    batch(result, "ChangeMessageVisibilityBatchResultEntry", ["Id"]),
  ReceiveMessage: (result) => ((result.Messages ?? []) as Input[]).map(message).join(""),
}

const xml = (body: string, status: number, requestId: string) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/xml", "x-amzn-requestid": requestId },
  })

/** An SQS query error: `ErrorResponse` with `Type` Sender (4xx) or Receiver (5xx). */
export const queryError = (code: string, message: string, status: number, requestId: string) =>
  xml(
    `<ErrorResponse xmlns="${SQS_XMLNS}"><Error><Type>${status >= 500 ? "Receiver" : "Sender"}</Type>${element("Code", code)}${element("Message", message)}<Detail/></Error>${element("RequestId", requestId)}</ErrorResponse>`,
    status,
    requestId,
  )

/** Re-encode an AWS JSON handler answer as the query protocol's XML answer. */
export const queryResponse = async (action: string, response: Response): Promise<Response> => {
  const requestId = response.headers.get("x-amzn-requestid") ?? ""
  const body = (await response.json().catch(() => ({}))) as Input
  if (response.status >= 400)
    return queryError(
      String(body.__type ?? "InternalFailure"),
      String(body.message ?? ""),
      response.status,
      requestId,
    )
  const result = RESULTS[action]
  return xml(
    `<${action}Response xmlns="${SQS_XMLNS}">${result ? `<${action}Result>${result(body)}</${action}Result>` : ""}<ResponseMetadata>${element("RequestId", requestId)}</ResponseMetadata></${action}Response>`,
    response.status,
    requestId,
  )
}
