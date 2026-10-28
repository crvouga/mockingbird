/**
 * MinIO's `internal/bucket/lifecycle`: `ParseLifecycleConfigWithID`, `Validate` and the
 * `xml.Marshal` form GetBucketLifecycle answers with, decoded in document order so the first
 * error is the one MinIO reports.
 */
import { GoError, goBool, goEl, goInt, parseGoXml, type XNode } from "./goxml.js"

const lifecycleError = (message: string) => new GoError("lifecycle", message)
const ERR = {
  tooManyRules: "Lifecycle configuration allows a maximum of 1000 rules",
  noRule: "Lifecycle configuration should have at least one rule",
  duplicateId: "Rule ID must be unique. Found same ID for more than one rule",
  notWellFormed:
    "The XML you provided was not well-formed or did not validate against our published schema",
  bucketLocked:
    "ExpiredObjectAllVersions element and DelMarkerExpiration action cannot be used on an object locked bucket",
  invalidDate: "Date must be provided in ISO 8601 format",
  invalidDays: "Days must be positive integer when used with Expiration",
  invalidExpiration:
    "Exactly one of Days (positive integer) or Date (positive ISO 8601 format) should be present inside Expiration.",
  invalidDeleteMarker:
    "Delete marker cannot be specified with Days or Date in a Lifecycle Expiration Policy",
  dateNotMidnight: "'Date' must be at midnight GMT",
  invalidDeleteAll:
    "Days (positive integer) should be present inside Expiration with ExpiredObjectAllVersions.",
  transitionDays: "Days must be 0 or greater when used with Transition",
  transitionInvalid:
    "Exactly one of Days (0 or greater) or Date (positive ISO 8601 format) should be present in Transition.",
  delMarkerDays: "Days must be a positive integer with DelMarkerExpiration",
  invalidFilter: "Filter must have exactly one of Prefix, Tag, or And specified",
  duplicateTagKey: "Duplicate Tag Keys are not allowed",
  invalidTagKey: "The TagKey you have provided is invalid",
  invalidTagValue: "The TagValue you have provided is invalid",
  duplicatedXmlTag: "duplicated XML Tag",
  unknownXmlTag: "unknown XML Tag",
  ruleId: "ID length is limited to 255 characters",
  emptyStatus: "Status should not be empty",
  invalidStatus: "Status must be set to either Enabled or Disabled",
  delMarkerTags: "Rule with DelMarkerExpiration cannot have tags based filtering",
} as const

type Tag = { key: string; value: string }
type And = { gt: number; lt: number; prefix?: string; tags: Tag[] }
type Filter = { prefix?: string; and?: And; tag?: Tag; lt: number; gt: number }
type Expiration = { days: number; date?: string; deleteMarker?: boolean; deleteAll?: boolean }
type Transition = { days: number; date?: string; storageClass: string }
type NoncurrentExpiration = { days: number; newer: number }
type NoncurrentTransition = { days: number; storageClass: string }
export type Rule = {
  id: string
  status: string
  filter?: Filter
  prefix?: string
  expiration?: Expiration
  transition?: Transition
  delMarkerDays: number
  noncurrentExpiration?: NoncurrentExpiration
  noncurrentTransition?: NoncurrentTransition
}
export type Lifecycle = { rules: Rule[] }

/** `time.Parse(time.RFC3339, s)` then MinIO's "midnight UTC" rule; returns the marshalled form. */
const parseMidnight = (text: string, invalid: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
    text,
  )
  if (!match) throw lifecycleError(invalid)
  const [, year, month, day, hour, minute, second, fraction, zone] = match as unknown as string[]
  const parts = [year, month, day, hour, minute, second].map(Number) as number[]
  const [y, mo, d, h, mi, s] = parts as [number, number, number, number, number, number]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (
    mo < 1 ||
    mo > 12 ||
    date.getUTCDate() !== d ||
    date.getUTCMonth() !== mo - 1 ||
    h > 23 ||
    mi > 59 ||
    s > 59
  )
    throw lifecycleError(invalid)
  const nanos = fraction ? Number(fraction.slice(1)) : 0
  if (
    h !== 0 ||
    mi !== 0 ||
    s !== 0 ||
    nanos !== 0 ||
    (zone !== "Z" && zone !== "+00:00" && zone !== "-00:00")
  )
    throw lifecycleError(ERR.dateNotMidnight)
  return `${year}-${month}-${day}T00:00:00Z`
}

const decodeTag = (node: XNode): Tag => {
  const tag: Tag = { key: "", value: "" }
  let key = false
  let value = false
  for (const child of node.children) {
    if (child.name === "Key") {
      if (key) throw lifecycleError(ERR.duplicatedXmlTag)
      tag.key = child.text
      key = true
    } else if (child.name === "Value") {
      if (value) throw lifecycleError(ERR.duplicatedXmlTag)
      tag.value = child.text
      value = true
    } else throw lifecycleError(ERR.unknownXmlTag)
  }
  return tag
}

const decodeAnd = (node: XNode): And => {
  const and: And = { gt: 0, lt: 0, tags: [] }
  for (const child of node.children) {
    if (child.name === "ObjectSizeGreaterThan") and.gt = goInt(child.text)
    else if (child.name === "ObjectSizeLessThan") and.lt = goInt(child.text)
    else if (child.name === "Prefix") and.prefix = child.text
    else if (child.name === "Tag") and.tags.push(decodeTag(child))
  }
  return and
}

const decodeFilter = (node: XNode): Filter => {
  const filter: Filter = { lt: 0, gt: 0 }
  for (const child of node.children) {
    switch (child.name) {
      case "Prefix":
        filter.prefix = child.text
        break
      case "And":
        filter.and = decodeAnd(child)
        break
      case "Tag":
        filter.tag = decodeTag(child)
        break
      case "ObjectSizeLessThan":
        filter.lt = goInt(child.text)
        break
      case "ObjectSizeGreaterThan":
        filter.gt = goInt(child.text)
        break
      default:
        throw lifecycleError(ERR.unknownXmlTag)
    }
  }
  return filter
}

const decodeExpiration = (node: XNode): Expiration => {
  const expiration: Expiration = { days: 0 }
  for (const child of node.children) {
    if (child.name === "Days") {
      const days = goInt(child.text)
      if (days <= 0) throw lifecycleError(ERR.invalidDays)
      expiration.days = days
    } else if (child.name === "Date") expiration.date = parseMidnight(child.text, ERR.invalidDate)
    else if (child.name === "ExpiredObjectDeleteMarker")
      expiration.deleteMarker = goBool(child.text)
    else if (child.name === "ExpiredObjectAllVersions") expiration.deleteAll = goBool(child.text)
  }
  return expiration
}

const decodeTransition = (node: XNode): Transition => {
  const transition: Transition = { days: 0, storageClass: "" }
  for (const child of node.children) {
    if (child.name === "Days") {
      const days = goInt(child.text)
      if (days < 0) throw lifecycleError(ERR.transitionDays)
      transition.days = days
    } else if (child.name === "Date") transition.date = parseMidnight(child.text, ERR.invalidDate)
    else if (child.name === "StorageClass") transition.storageClass = child.text
  }
  return transition
}

const decodeRule = (node: XNode): Rule => {
  const rule: Rule = { id: "", status: "", delMarkerDays: 0 }
  for (const child of node.children) {
    switch (child.name) {
      case "ID":
        rule.id = child.text
        break
      case "Status":
        rule.status = child.text
        break
      case "Filter":
        rule.filter = decodeFilter(child)
        break
      case "Prefix":
        rule.prefix = child.text
        break
      case "Expiration":
        rule.expiration = decodeExpiration(child)
        break
      case "Transition":
        rule.transition = decodeTransition(child)
        break
      case "DelMarkerExpiration": {
        let days = 0
        for (const grand of child.children) if (grand.name === "Days") days = goInt(grand.text)
        if (days <= 0) throw lifecycleError(ERR.delMarkerDays)
        rule.delMarkerDays = days
        break
      }
      case "NoncurrentVersionExpiration": {
        const value: NoncurrentExpiration & { max: number } = { days: 0, newer: 0, max: 0 }
        for (const grand of child.children) {
          if (grand.name === "NoncurrentDays") {
            const days = goInt(grand.text)
            if (days <= 0) throw lifecycleError(ERR.invalidDays)
            value.days = days
          } else if (grand.name === "NewerNoncurrentVersions") value.newer = goInt(grand.text)
          else if (grand.name === "MaxNoncurrentVersions") value.max = goInt(grand.text)
        }
        rule.noncurrentExpiration = {
          days: value.days,
          newer: value.max > 0 ? value.max : value.newer,
        }
        break
      }
      case "NoncurrentVersionTransition": {
        const value: NoncurrentTransition = { days: 0, storageClass: "" }
        for (const grand of child.children) {
          if (grand.name === "NoncurrentDays") {
            const days = goInt(grand.text)
            if (days < 0) throw lifecycleError(ERR.transitionDays)
            value.days = days
          } else if (grand.name === "StorageClass") value.storageClass = grand.text
        }
        rule.noncurrentTransition = value
        break
      }
    }
  }
  return rule
}

/** `lifecycle.ParseLifecycleConfigWithID`: decode, then give every rule without an ID a UUID. */
export const parseLifecycle = (body: string, uuid: () => string): Lifecycle => {
  const root = parseGoXml(body)
  if (root.name !== "LifecycleConfiguration" && root.name !== "BucketLifecycleConfiguration")
    throw new GoError(
      "unmarshal",
      `expected element type <LifecycleConfiguration>/<BucketLifecycleConfiguration> but have <${root.name}>`,
    )
  const rules: Rule[] = []
  for (const child of root.children) {
    if (child.name === "Rule") rules.push(decodeRule(child))
    else if (child.name !== "ExpiryUpdatedAt")
      throw new GoError("unmarshal", `expected element type <Rule> but have <${child.name}>`)
  }
  for (const rule of rules) if (rule.id === "") rule.id = uuid()
  return { rules }
}

const tagEmpty = (tag?: Tag) => !tag || tag.key === ""
const andEmpty = (and?: And) =>
  !and || (and.tags.length === 0 && and.prefix === undefined && and.gt === 0 && and.lt === 0)

const validateTag = (tag: Tag) => {
  if (tag.key.length === 0 || [...tag.key].length > 128) throw lifecycleError(ERR.invalidTagKey)
  if ([...tag.value].length > 256) throw lifecycleError(ERR.invalidTagValue)
}

const validateFilter = (filter: Filter) => {
  let count = 0
  let kind: "none" | "prefix" | "and" | "tag" | "lt" | "gt" = "none"
  if (!andEmpty(filter.and)) {
    kind = "and"
    count++
  }
  if (filter.prefix !== undefined) {
    kind = "prefix"
    count++
  }
  if (!tagEmpty(filter.tag)) {
    kind = "tag"
    count++
  }
  if (filter.gt !== 0) {
    kind = "gt"
    count++
  }
  if (filter.lt !== 0) {
    kind = "lt"
    count++
  }
  if (count > 1) throw lifecycleError(ERR.invalidFilter)
  if (kind === "and") {
    const and = filter.and as And
    let predicates = and.tags.length
    if (and.prefix !== undefined) predicates++
    if (and.gt > 0) predicates++
    if (and.lt > 0) predicates++
    if (predicates < 2) throw lifecycleError(ERR.notWellFormed)
    if (new Set(and.tags.map((tag) => tag.key)).size !== and.tags.length)
      throw lifecycleError(ERR.duplicateTagKey)
    for (const tag of and.tags) validateTag(tag)
    if (and.gt < 0 || and.lt < 0) throw lifecycleError(ERR.notWellFormed)
  } else if (kind === "tag") validateTag(filter.tag as Tag)
  else if ((kind === "lt" && filter.lt < 0) || (kind === "gt" && filter.gt < 0))
    throw lifecycleError(ERR.notWellFormed)
}

const validateRule = (rule: Rule) => {
  if (rule.id.length > 255) throw lifecycleError(ERR.ruleId)
  if (rule.status.length === 0) throw lifecycleError(ERR.emptyStatus)
  if (rule.status !== "Enabled" && rule.status !== "Disabled")
    throw lifecycleError(ERR.invalidStatus)
  const expiration = rule.expiration
  if (expiration) {
    const daysNull = expiration.days === 0
    const dateNull = expiration.date === undefined
    if ((!daysNull || !dateNull) && expiration.deleteMarker !== undefined)
      throw lifecycleError(ERR.invalidDeleteMarker)
    if (
      expiration.deleteMarker === undefined &&
      expiration.deleteAll === undefined &&
      daysNull &&
      dateNull
    )
      throw lifecycleError(ERR.notWellFormed)
    if (!daysNull && !dateNull) throw lifecycleError(ERR.invalidExpiration)
    if (expiration.deleteAll !== undefined && daysNull) throw lifecycleError(ERR.invalidDeleteAll)
  }
  const noncurrent = rule.noncurrentExpiration
  if (noncurrent && ((noncurrent.days === 0 && noncurrent.newer === 0) || noncurrent.newer < 0))
    throw lifecycleError(ERR.notWellFormed)
  if (rule.prefix !== undefined && rule.filter && rule.filter.prefix !== undefined)
    throw lifecycleError(ERR.notWellFormed)
  if (rule.filter) validateFilter(rule.filter)
  if (rule.transition) {
    if (rule.transition.date !== undefined && rule.transition.days > 0)
      throw lifecycleError(ERR.transitionInvalid)
    if (rule.transition.storageClass === "") throw lifecycleError(ERR.notWellFormed)
  }
  if (rule.noncurrentTransition && rule.noncurrentTransition.storageClass === "")
    throw lifecycleError(ERR.notWellFormed)
  if (
    (!tagEmpty(rule.filter?.tag) || (rule.filter?.and?.tags.length ?? 0) !== 0) &&
    rule.delMarkerDays !== 0
  )
    throw lifecycleError(ERR.delMarkerTags)
  if (
    !rule.expiration &&
    !rule.transition &&
    !rule.noncurrentExpiration &&
    !rule.noncurrentTransition &&
    rule.delMarkerDays === 0
  )
    throw lifecycleError(ERR.notWellFormed)
}

/** `Lifecycle.Validate(lockRetention)`. */
export const validateLifecycle = (config: Lifecycle, objectLock: boolean) => {
  if (config.rules.length > 1000) throw lifecycleError(ERR.tooManyRules)
  if (config.rules.length === 0) throw lifecycleError(ERR.noRule)
  for (const rule of config.rules) {
    validateRule(rule)
    if (objectLock && (rule.expiration?.deleteAll === true || rule.delMarkerDays !== 0))
      throw lifecycleError(ERR.bucketLocked)
  }
  for (let index = 0; index < config.rules.length - 1; index++)
    for (const other of config.rules.slice(index + 1))
      if ((config.rules[index] as Rule).id === other.id) throw lifecycleError(ERR.duplicateId)
}

/** MinIO's `validateTransitionTier`: no tiers are configured, so any storage class is invalid. */
export const hasTransitionTier = (config: Lifecycle) =>
  config.rules.some(
    (rule) =>
      (rule.transition?.storageClass ?? "") !== "" ||
      (rule.noncurrentTransition?.storageClass ?? "") !== "",
  )

const marshalTag = (tag: Tag) =>
  `<Tag>${tag.key ? goEl("Key", tag.key) : ""}${tag.value ? goEl("Value", tag.value) : ""}</Tag>`

const marshalFilter = (filter: Filter) => {
  let inner = ""
  if (!andEmpty(filter.and)) {
    const and = filter.and as And
    inner = `<And>${and.gt ? goEl("ObjectSizeGreaterThan", and.gt) : ""}${and.lt ? goEl("ObjectSizeLessThan", and.lt) : ""}${and.prefix !== undefined ? goEl("Prefix", and.prefix) : ""}${and.tags.map(marshalTag).join("")}</And>`
  } else if (!tagEmpty(filter.tag)) inner = marshalTag(filter.tag as Tag)
  else
    inner = `${filter.prefix !== undefined ? goEl("Prefix", filter.prefix) : ""}${filter.lt > 0 ? goEl("ObjectSizeLessThan", filter.lt) : ""}${filter.gt > 0 ? goEl("ObjectSizeGreaterThan", filter.gt) : ""}`
  return `<Filter>${inner}</Filter>`
}

const marshalRule = (rule: Rule) => {
  let out = `<Rule>${rule.id ? goEl("ID", rule.id) : ""}${goEl("Status", rule.status)}`
  if (rule.filter) out += marshalFilter(rule.filter)
  if (rule.prefix !== undefined) out += goEl("Prefix", rule.prefix)
  const expiration = rule.expiration
  if (expiration)
    out += `<Expiration>${expiration.days ? goEl("Days", expiration.days) : ""}${expiration.date ? goEl("Date", expiration.date) : ""}${expiration.deleteMarker !== undefined ? goEl("ExpiredObjectDeleteMarker", expiration.deleteMarker) : ""}${expiration.deleteAll !== undefined ? goEl("ExpiredObjectAllVersions", expiration.deleteAll) : ""}</Expiration>`
  const transition = rule.transition
  if (transition)
    out += `<Transition>${transition.days ? goEl("Days", transition.days) : ""}${transition.date ? goEl("Date", transition.date) : ""}${transition.storageClass ? goEl("StorageClass", transition.storageClass) : ""}</Transition>`
  if (rule.delMarkerDays)
    out += `<DelMarkerExpiration>${goEl("Days", rule.delMarkerDays)}</DelMarkerExpiration>`
  const noncurrent = rule.noncurrentExpiration
  if (noncurrent && (noncurrent.days !== 0 || noncurrent.newer !== 0))
    out += `<NoncurrentVersionExpiration>${noncurrent.days ? goEl("NoncurrentDays", noncurrent.days) : ""}${noncurrent.newer ? goEl("NewerNoncurrentVersions", noncurrent.newer) : ""}</NoncurrentVersionExpiration>`
  const noncurrentTransition = rule.noncurrentTransition
  if (noncurrentTransition?.storageClass)
    out += `<NoncurrentVersionTransition>${goEl("NoncurrentDays", noncurrentTransition.days)}${goEl("StorageClass", noncurrentTransition.storageClass)}</NoncurrentVersionTransition>`
  return `${out}</Rule>`
}

/** `xml.Marshal(lifecycle)` (no XML header, no namespace), as GetBucketLifecycle writes it. */
export const marshalLifecycle = (config: Lifecycle) =>
  `<LifecycleConfiguration>${config.rules.map(marshalRule).join("")}</LifecycleConfiguration>`
