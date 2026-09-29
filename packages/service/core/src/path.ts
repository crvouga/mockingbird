import type { Operation } from "@crvouga/mockingbird-openapi"
import { operationMetadata } from "@crvouga/mockingbird-openapi-metadata"

/** Compile the same explicit terminal-tail contract for dispatch and observation. */
export const operationPath = (operation: Operation) => {
  const tail = operationMetadata(operation.operation).path
  if (
    tail &&
    (typeof tail.parameter !== "string" ||
      !tail.parameter ||
      !operation.path.endsWith(`/{${tail.parameter}}`) ||
      (tail.allowEmpty !== undefined && typeof tail.allowEmpty !== "boolean"))
  )
    throw new Error(`Invalid path metadata for ${operation.operationId}`)
  const segments = operation.path.split("/")
  const ordinary = (segment: string) =>
    segment.startsWith("{") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const hono = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    name === tail?.parameter ? `:${name}{.+}` : `:${name}`,
  )
  const prefix = tail ? segments.slice(0, -1).map(ordinary).join("/") : undefined
  const pattern = tail
    ? `${prefix}${tail.allowEmpty ? "(?:/.*)?" : "/.+"}`
    : segments.map(ordinary).join("/")
  const routes = [hono]
  if (tail?.allowEmpty) {
    const base = operation.path
      .slice(0, -`/{${tail.parameter}}`.length)
      .replace(/\{([^}]+)\}/g, ":$1")
    routes.push(base, `${base}/`)
  }
  return {
    routes,
    pattern: new RegExp(`^${pattern}/?$`),
    emptyParameter: tail?.allowEmpty ? tail.parameter : undefined,
  }
}
