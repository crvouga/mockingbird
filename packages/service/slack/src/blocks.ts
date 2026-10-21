/**
 * Block Kit limits, from the per-block reference pages on docs.slack.dev (best guess, not
 * oracle-verified: the exact messages Slack returns were never observed live). Only the documented
 * constraints are checked, and only on fields that are present; required-field rules (a section
 * with neither `text` nor `fields`, an image without `alt_text`) are not modelled.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Every block `type` Block Kit documents; anything else is `invalid_blocks`. */
export const BLOCK_TYPES: ReadonlySet<string> = new Set([
  "actions",
  "alert",
  "call",
  "card",
  "carousel",
  "context",
  "context_actions",
  "divider",
  "file",
  "header",
  "image",
  "input",
  "markdown",
  "plan",
  "rich_text",
  "section",
  "table",
  "task_card",
  "video",
])

/** At most this many blocks in a message (top level, and inside each attachment). */
export const MAX_BLOCKS = 50

type Issues = string[]

/** A text object (`plain_text` or `mrkdwn`), `text` at most `max` characters; the header allows only plain text. */
const checkText = (
  value: unknown,
  path: string,
  max: number,
  issues: Issues,
  plainOnly = false,
): void => {
  if (!isRecord(value)) {
    issues.push(`must be a text object [json-pointer:${path}]`)
    return
  }
  if (value.type !== "plain_text" && !(value.type === "mrkdwn" && !plainOnly)) {
    issues.push(
      `must be of type ${plainOnly ? "plain_text" : "plain_text or mrkdwn"} [json-pointer:${path}/type]`,
    )
  }
  if (typeof value.text !== "string" || value.text.length === 0) {
    issues.push(`must be a non-empty string [json-pointer:${path}/text]`)
  } else if (value.text.length > max) {
    issues.push(`must be less than ${max + 1} characters [json-pointer:${path}/text]`)
  }
}

const checkList = (
  value: unknown,
  path: string,
  max: number,
  issues: Issues,
  each?: (item: unknown, itemPath: string) => void,
): void => {
  if (!Array.isArray(value)) {
    issues.push(`must be an array [json-pointer:${path}]`)
    return
  }
  if (value.length > max)
    issues.push(`must have fewer than ${max + 1} items [json-pointer:${path}]`)
  if (!each) return
  for (const [index, item] of value.entries()) each(item, `${path}/${index}`)
}

const checkBlock = (block: unknown, path: string, issues: Issues): void => {
  if (!isRecord(block) || typeof block.type !== "string") {
    issues.push(`must be an object with a type [json-pointer:${path}]`)
    return
  }
  if (!BLOCK_TYPES.has(block.type)) {
    issues.push(`unsupported type: ${block.type} [json-pointer:${path}/type]`)
    return
  }
  if (block.block_id !== undefined) {
    if (typeof block.block_id !== "string" || block.block_id.length > 255) {
      issues.push(`must be a string of at most 255 characters [json-pointer:${path}/block_id]`)
    }
  }
  switch (block.type) {
    case "section":
      if (block.text !== undefined) checkText(block.text, `${path}/text`, 3000, issues)
      if (block.fields !== undefined) {
        checkList(block.fields, `${path}/fields`, 10, issues, (field, fieldPath) =>
          checkText(field, fieldPath, 2000, issues),
        )
      }
      break
    case "header":
      if (block.text !== undefined) checkText(block.text, `${path}/text`, 150, issues, true)
      break
    case "context":
      if (block.elements !== undefined) checkList(block.elements, `${path}/elements`, 10, issues)
      break
    case "actions":
      if (block.elements !== undefined) checkList(block.elements, `${path}/elements`, 25, issues)
      break
  }
}

/** The problems with a `blocks` array (empty when it is acceptable). */
export const blockIssues = (blocks: unknown, path = "/blocks"): string[] => {
  const issues: Issues = []
  checkList(blocks, path, MAX_BLOCKS, issues, (block, blockPath) =>
    checkBlock(block, blockPath, issues),
  )
  return issues
}

/** The problems with the `blocks` inside each `attachments[]` entry (other attachment fields are not checked). */
export const attachmentBlockIssues = (attachments: unknown): string[] => {
  if (!Array.isArray(attachments)) return []
  const issues: Issues = []
  attachments.forEach((attachment, index) => {
    if (isRecord(attachment) && attachment.blocks !== undefined && attachment.blocks !== null) {
      issues.push(...blockIssues(attachment.blocks, `/attachments/${index}/blocks`))
    }
  })
  return issues
}
