import {
  forwardRequestContext,
  isAdminPath,
  matchNamespacePath,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"

const templates = Object.keys(document.paths ?? {})
  .map((path) => path.split("/"))
  .sort((a, b) => a.filter(isParameter).length - b.filter(isParameter).length)

function isParameter(segment: string) {
  return segment.startsWith("{")
}

export const normalizeVendorRequest = (request: Request, adminPrefix?: string) => {
  const url = new URL(request.url)
  const scope = adminPrefix ? matchNamespacePath(url.pathname, adminPrefix) : null
  const path = scope ? (scope[2] ?? "/") : url.pathname
  if (adminPrefix && isAdminPath(path, adminPrefix)) return request
  const segments = path.split("/")
  if (segments[1]?.toLowerCase() !== "api") return request
  const template = templates.find(
    (parts) =>
      parts.length === segments.length &&
      parts.every(
        (part, index) => isParameter(part) || part.toLowerCase() === segments[index]?.toLowerCase(),
      ),
  )
  segments[1] = "api"
  const canonical = template
    ? template.map((part, index) => (isParameter(part) ? segments[index] : part)).join("/")
    : segments.join("/")
  if (canonical === path) return request
  const prefix = scope ? url.pathname.slice(0, -path.length) : ""
  url.pathname = prefix + canonical
  return forwardRequestContext(request, new Request(url, request))
}
