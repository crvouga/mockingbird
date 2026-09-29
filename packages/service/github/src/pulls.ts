import {
  Collection,
  DroppedConnectionError,
  faultEffect,
  IdSequence,
  jsonRes,
  markMutationAccepted,
  type OperationHandler,
} from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
import { type GitHubState, type Repository, record } from "./state.js"

type Branch = { label: string; ref: string; sha: string; repo: Repository }
export type PullRequest = {
  id: number
  node_id: string
  number: number
  url: string
  html_url: string
  state: "open" | "closed"
  title: string
  body: string | null
  draft: boolean
  created_at: string
  updated_at: string
  closed_at: string | null
  merged: false
  merged_at: null
  mergeable: null
  merge_commit_sha: null
  maintainer_can_modify: boolean
  head: Branch
  base: Branch
}
class PullError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}
function invalid(field: string): never {
  throw new PullError(422, "Validation Failed", field)
}
function unsupported(feature: string): never {
  throw new PullError(501, `Mockingbird does not model ${feature}`)
}
const repoKey = (repo: Repository) => repo.full_name.toLowerCase()

export class GitHubPulls {
  private readonly rows: Collection<PullRequest>
  private readonly ids: IdSequence
  constructor(
    private readonly sqlite: SqliteClient,
    private readonly namespace: string,
    private readonly state: GitHubState,
    private readonly now: () => number,
  ) {
    this.rows = new Collection(sqlite, namespace, "github-pulls")
    this.ids = new IdSequence(sqlite, namespace, "github-pulls")
  }
  private branch(repo: Repository, name: string): Branch {
    const ref = this.state.reference(repo.owner.login, repo.name, `refs/heads/${name}`)
    if (!ref) return invalid("base/head")
    return { label: `${repo.owner.login}:${name}`, ref: name, sha: ref.object.sha, repo }
  }
  private project(pr: PullRequest): PullRequest {
    if (pr.state === "closed") return pr
    return {
      ...pr,
      head: this.branch(pr.head.repo, pr.head.ref),
      base: this.branch(pr.base.repo, pr.base.ref),
    }
  }
  private entries(repo: Repository) {
    return this.rows
      .list()
      .filter((row) => repoKey(row.value.base.repo) === repoKey(repo))
      .map((row) => row.value)
  }
  get(repo: Repository, number: number): PullRequest {
    const pr = this.rows.get(`${repoKey(repo)}:${number}`)
    if (!pr) throw new PullError(404, "Not Found")
    return this.project(pr)
  }
  private validateFields(input: Record<string, unknown>) {
    if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim()))
      invalid("title")
    if (input.body !== undefined && typeof input.body !== "string") invalid("body")
    if (
      input.maintainer_can_modify !== undefined &&
      typeof input.maintainer_can_modify !== "boolean"
    )
      invalid("maintainer_can_modify")
  }
  private checkPair(repo: Repository, head: Branch, base: Branch, except?: number) {
    if (
      this.entries(repo).some(
        (pr) =>
          pr.state === "open" &&
          pr.number !== except &&
          pr.head.ref === head.ref &&
          pr.base.ref === base.ref,
      )
    )
      throw new PullError(422, `A pull request already exists for ${head.label}.`)
    if (this.state.isAncestor(repo.owner.login, repo.name, head.sha, base.sha))
      throw new PullError(422, `No commits between ${base.ref} and ${head.ref}`)
  }
  create(repo: Repository, input: Record<string, unknown>) {
    return this.sqlite.transaction(() => {
      if (input.issue !== undefined) unsupported("issue conversion")
      if (input.head_repo !== undefined) unsupported("cross-repository heads")
      this.validateFields(input)
      if (typeof input.title !== "string" || !input.title.trim()) invalid("title")
      if (typeof input.head !== "string" || !input.head) invalid("head")
      if (typeof input.base !== "string" || !input.base) invalid("base")
      if (input.draft !== undefined && typeof input.draft !== "boolean") invalid("draft")
      const parts = input.head.split(":")
      if (parts.length > 2) invalid("head")
      if (parts.length === 2 && parts[0]?.toLowerCase() !== repo.owner.login.toLowerCase())
        unsupported("cross-repository heads")
      const head = this.branch(repo, parts.at(-1) as string),
        base = this.branch(repo, input.base)
      this.checkPair(repo, head, base)
      const number = new Collection(
        this.sqlite,
        this.namespace,
        `github-pr-numbers:${repoKey(repo)}`,
      ).nextSequence()
      const now = new Date(this.now()).toISOString()
      const pr: PullRequest = {
        id: this.rows.nextSequence(),
        node_id: this.ids.next("PR_"),
        number,
        url: `${repo.url}/pulls/${number}`,
        html_url: `${repo.html_url}/pull/${number}`,
        state: "open",
        title: input.title,
        body: typeof input.body === "string" ? input.body : null,
        draft: input.draft === true,
        created_at: now,
        updated_at: now,
        closed_at: null,
        merged: false,
        merged_at: null,
        mergeable: null,
        merge_commit_sha: null,
        maintainer_can_modify: input.maintainer_can_modify !== false,
        head,
        base,
      }
      this.rows.insert(`${repoKey(repo)}:${number}`, pr)
      return pr
    })
  }
  update(repo: Repository, number: number, input: Record<string, unknown>) {
    return this.sqlite.transaction(() => {
      const before = this.get(repo, number)
      this.validateFields(input)
      if (input.state !== undefined && input.state !== "open" && input.state !== "closed")
        invalid("state")
      if (input.base !== undefined && (typeof input.base !== "string" || !input.base))
        invalid("base")
      const state = input.state ?? before.state
      const head = this.branch(repo, before.head.ref)
      const base = this.branch(repo, typeof input.base === "string" ? input.base : before.base.ref)
      if (state === "open" && (before.state === "closed" || input.base !== undefined))
        this.checkPair(repo, head, base, number)
      const now = new Date(this.now()).toISOString()
      const pr: PullRequest = {
        ...before,
        state,
        head,
        base,
        updated_at: now,
        title: typeof input.title === "string" ? input.title : before.title,
        body: typeof input.body === "string" ? input.body || null : before.body,
        maintainer_can_modify:
          typeof input.maintainer_can_modify === "boolean"
            ? input.maintainer_can_modify
            : before.maintainer_can_modify,
        closed_at: state === "closed" ? (before.closed_at ?? now) : null,
      }
      this.rows.update(`${repoKey(repo)}:${number}`, pr)
      return pr
    })
  }
  list(repo: Repository, url: URL) {
    const query = url.searchParams,
      state = query.get("state") ?? "open",
      sort = query.get("sort") ?? "created"
    if (!["open", "closed", "all"].includes(state)) invalid("state")
    if (["popularity", "long-running"].includes(sort)) unsupported(`${sort} sorting`)
    if (!["created", "updated"].includes(sort)) invalid("sort")
    const direction = query.get("direction") ?? (sort === "created" ? "desc" : "asc")
    if (!["asc", "desc"].includes(direction)) invalid("direction")
    const integer = (name: string, fallback: number) => {
      const value = query.get(name)
      if (value === null) return fallback
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid(name)
      return Number(value)
    }
    const page = integer("page", 1),
      perPage = Math.min(integer("per_page", 30), 100)
    const headFilter = query.get("head"),
      baseFilter = query.get("base")
    const matches = this.entries(repo)
      .filter((pr) => {
        if (state !== "all" && pr.state !== state) return false
        if (baseFilter !== null && pr.base.ref !== baseFilter) return false
        if (headFilter !== null) {
          const colon = headFilter.indexOf(":")
          if (
            colon < 0 ||
            headFilter.slice(0, colon).toLowerCase() !== repo.owner.login.toLowerCase() ||
            headFilter.slice(colon + 1) !== pr.head.ref
          )
            return false
        }
        return true
      })
      .sort((left, right) => {
        const field = sort === "updated" ? "updated_at" : "created_at"
        const diff =
          left[field] < right[field]
            ? -1
            : left[field] > right[field]
              ? 1
              : left.number - right.number
        return direction === "asc" ? diff : -diff
      })
    const last = Math.ceil(matches.length / perPage),
      links: string[] = []
    const add = (rel: string, target: number) => {
      const link = new URL(url)
      link.searchParams.set("page", String(target))
      links.push(`<${link.href}>; rel="${rel}"`)
    }
    if (page < last) {
      add("next", page + 1)
      add("last", last)
    }
    if (page > 1 && last > 0) {
      add("first", 1)
      add("prev", page - 1)
    }
    return jsonRes(
      200,
      matches.slice((page - 1) * perPage, page * perPage).map((pr) => this.project(pr)),
      links.length ? { link: links.join(", ") } : undefined,
    )
  }
}

export const pullHandlers = (
  state: GitHubState,
  pulls: GitHubPulls,
): Record<"pulls/create" | "pulls/get" | "pulls/list" | "pulls/update", OperationHandler> => {
  const handle =
    (kind: "create" | "get" | "list" | "update"): OperationHandler =>
    ({ params, body, url, request }) => {
      const docs = `https://docs.github.com/rest/pulls/pulls#${kind === "list" ? "list-pull-requests" : kind === "get" ? "get-a-pull-request" : kind === "create" ? "create-a-pull-request" : "update-a-pull-request"}`
      try {
        const repo = state.repository(params.owner ?? "", params.repo ?? "")
        if (!repo) throw new PullError(404, "Not Found")
        if (kind === "list") return pulls.list(repo, url)
        const number = Number(params.pull_number)
        if (kind !== "create" && (!Number.isSafeInteger(number) || number < 1))
          throw new PullError(404, "Not Found")
        if (kind === "get") return jsonRes(200, pulls.get(repo, number))
        if (body.kind === "invalid") throw new PullError(400, "Problems parsing JSON")
        if (body.kind === "json" && !record(body.value)) invalid("body")
        if (body.kind !== "empty" && body.kind !== "json")
          unsupported("non-JSON pull request bodies")
        const input = body.kind === "json" && record(body.value) ? body.value : {}
        const result =
          kind === "create" ? pulls.create(repo, input) : pulls.update(repo, number, input)
        markMutationAccepted(request, { ids: { pullNumber: String(result.number) } })
        if (faultEffect(request, "github.accepted_drop")) throw new DroppedConnectionError()
        return jsonRes(kind === "create" ? 201 : 200, result)
      } catch (error) {
        if (!(error instanceof PullError)) throw error
        if (error.status === 501)
          return jsonRes(501, { code: "mockingbird_unsupported", message: error.message })
        if (error.status === 422)
          return jsonRes(422, {
            message: "Validation Failed",
            errors: [
              {
                resource: "PullRequest",
                code: error.field ? "invalid" : "custom",
                ...(error.field ? { field: error.field } : { message: error.message }),
              },
            ],
            documentation_url: docs,
            status: "422",
          })
        return jsonRes(error.status, {
          message: error.message,
          documentation_url: docs,
          status: String(error.status),
        })
      }
    }
  return {
    "pulls/create": handle("create"),
    "pulls/get": handle("get"),
    "pulls/list": handle("list"),
    "pulls/update": handle("update"),
  }
}
