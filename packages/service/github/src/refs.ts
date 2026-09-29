import {
  DroppedConnectionError,
  faultEffect,
  jsonRes,
  markMutationAccepted,
  type OperationHandler,
} from "@crvouga/mockingbird-service"
import { type GitHubState, RefError, record } from "./state.js"

export const validRef = (value: string): boolean =>
  value.startsWith("refs/") &&
  value.split("/").length >= 3 &&
  !/[~^:?*[\\]/.test(value) &&
  !Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
  !value.includes("..") &&
  !value.includes("@{") &&
  !value.endsWith(".") &&
  value.split("/").every((part) => !!part && !part.startsWith(".") && !part.endsWith(".lock"))

/** Commit-backed synthetic refs only; no Git objects, transport or authorization policy. */
export const refHandlers = (
  state: GitHubState,
): Record<
  "git/get-ref" | "git/list-matching-refs" | "git/create-ref" | "git/update-ref",
  OperationHandler
> => {
  const handle =
    (kind: "get" | "list" | "create" | "update"): OperationHandler =>
    ({ params, body, request }) => {
      const owner = params.owner ?? "",
        name = params.repo ?? ""
      const docs = `https://docs.github.com/rest/git/refs#${kind === "get" ? "get-a-reference" : kind === "list" ? "list-matching-references" : kind === "create" ? "create-a-reference" : "update-a-reference"}`
      try {
        if (!state.repository(owner, name)) throw new RefError(404, "Not Found")
        if (kind === "list") return jsonRes(200, state.references(owner, name, params.ref ?? ""))
        if (kind === "get") {
          const ref = state.reference(owner, name, `refs/${params.ref ?? ""}`)
          if (!ref) throw new RefError(404, "Not Found")
          return jsonRes(200, ref)
        }
        const input = body.kind === "json" && record(body.value) ? body.value : {}
        if (typeof input.sha !== "string" || !/^[a-fA-F0-9]{40}$/.test(input.sha))
          throw new RefError(422, "Invalid request: sha must be a 40-character hexadecimal value")
        const ref = kind === "create" ? input.ref : `refs/${params.ref ?? ""}`
        if (typeof ref !== "string" || !validRef(ref))
          throw new RefError(422, "Reference name is not valid")
        if (ref.startsWith("refs/pull/"))
          return jsonRes(501, {
            code: "mockingbird_unsupported",
            message: "Mockingbird does not model provider-managed pull refs",
          })
        if (kind === "update" && input.force !== undefined && typeof input.force !== "boolean")
          throw new RefError(422, "Invalid request: force must be boolean")
        const result = state.writeReference(
          owner,
          name,
          ref,
          input.sha.toLowerCase(),
          kind === "create",
          input.force === true,
        )
        markMutationAccepted(request, { ids: { ref } })
        if (faultEffect(request, "github.accepted_drop")) throw new DroppedConnectionError()
        return jsonRes(kind === "create" ? 201 : 200, result)
      } catch (error) {
        if (!(error instanceof RefError)) throw error
        return jsonRes(error.status, {
          message: error.message,
          documentation_url: docs,
          status: String(error.status),
        })
      }
    }
  return {
    "git/get-ref": handle("get"),
    "git/list-matching-refs": handle("list"),
    "git/create-ref": handle("create"),
    "git/update-ref": handle("update"),
  }
}
