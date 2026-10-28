/**
 * Every operation's handler. Each area owns one module; an operation with no handler here is
 * answered NotImplemented.
 */
import type { Handlers } from "../context.js"
import { aclHandlers } from "./acl.js"
import { attributesHandlers } from "./attributes.js"
import { bucketHandlers } from "./buckets.js"
import { configHandlers } from "./config.js"
import { copyHandlers } from "./copy.js"
import { deleteHandlers } from "./delete.js"
import { listingHandlers } from "./listing.js"
import { lockHandlers } from "./lock.js"
import { multipartHandlers } from "./multipart.js"
import { objectHandlers } from "./objects.js"
import { postHandlers } from "./post.js"
import { taggingHandlers } from "./tagging.js"
import { versioningHandlers } from "./versioning.js"

const modules: Handlers[] = [
  aclHandlers,
  attributesHandlers,
  bucketHandlers,
  configHandlers,
  copyHandlers,
  deleteHandlers,
  listingHandlers,
  lockHandlers,
  multipartHandlers,
  objectHandlers,
  postHandlers,
  taggingHandlers,
  versioningHandlers,
]

export const handlers: Handlers = {}
for (const module of modules)
  for (const [op, handler] of Object.entries(module)) {
    if (op in handlers) throw new Error(`two handlers for ${op}`)
    ;(handlers as Record<string, unknown>)[op] = handler
  }
