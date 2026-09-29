import { Collection, IdSequence } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"
export class RefError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type Repository = {
  id: number
  node_id: string
  name: string
  full_name: string
  owner: { login: string; id: number; node_id: string; type: "Organization" }
  private: boolean
  fork: boolean
  default_branch: string
  url: string
  html_url: string
  created_at: string
  updated_at: string
}
export type Commit = { sha: string; parents: string[] }
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
export class SeedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
function invalid(message: string): never {
  throw new SeedError(400, message)
}
const segment = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]+$/.test(value) && value !== "." && value !== ".."
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
const key = (owner: string, name: string) => `${owner.toLowerCase()}/${name.toLowerCase()}`

/** Synthetic public state and seeded ancestry; no Git execution or provider credentials. */
export class GitHubState {
  readonly repositories: Collection<Repository>
  readonly owners: Collection<Repository["owner"]>
  readonly commits: Collection<Commit>
  readonly branches: Collection<{ ref: string; sha: string; node_id: string }>
  private readonly ids: IdSequence
  constructor(
    private readonly sqlite: SqliteClient,
    namespace: string,
    private readonly now: () => number,
  ) {
    this.repositories = new Collection(sqlite, namespace, "github-repositories")
    this.owners = new Collection(sqlite, namespace, "github-owners")
    this.commits = new Collection(sqlite, namespace, "github-commits")
    this.branches = new Collection(sqlite, namespace, "github-branches")
    this.ids = new IdSequence(sqlite, namespace, "github")
  }
  repository(owner: string, name: string) {
    return this.repositories.get(key(owner, name))
  }
  commit(owner: string, name: string, id: string) {
    return this.commits.get(`${key(owner, name)}:${id}`)
  }
  reference(owner: string, name: string, ref: string) {
    const repo = this.repository(owner, name)
    const stored = this.branches.get(`${key(owner, name)}:${ref}`)
    if (!repo || !stored) return undefined
    return {
      ref: stored.ref,
      node_id: stored.node_id,
      url: `${repo.url}/git/refs/${ref.slice(5).split("/").map(encodeURIComponent).join("/")}`,
      object: { type: "commit", sha: stored.sha, url: `${repo.url}/git/commits/${stored.sha}` },
    }
  }
  references(owner: string, name: string, prefix = "") {
    const repoPrefix = `${key(owner, name)}:`
    return this.branches
      .list()
      .filter(
        (entry) => entry.id.startsWith(repoPrefix) && entry.value.ref.startsWith(`refs/${prefix}`),
      )
      .map((entry) => this.reference(owner, name, entry.value.ref))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined)
      .sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0))
  }
  writeReference(
    owner: string,
    name: string,
    ref: string,
    sha: string,
    create: boolean,
    force: boolean,
  ) {
    return this.sqlite.transaction(() => {
      const id = `${key(owner, name)}:${ref}`
      const current = this.branches.get(id)
      if (create) {
        const refs = this.references(owner, name)
        if (!refs.some((existing) => existing.ref.startsWith("refs/heads/")))
          throw new RefError(409, "Git Repository is empty.")
        if (current) throw new RefError(422, "Reference already exists")
        if (
          refs.some(
            (existing) => existing.ref.startsWith(`${ref}/`) || ref.startsWith(`${existing.ref}/`),
          )
        )
          throw new RefError(422, "Reference name conflicts with an existing reference")
      } else if (!current) throw new RefError(422, "Reference does not exist")
      if (!this.commit(owner, name, sha)) throw new RefError(422, "Object does not exist")
      if (current && !force && !this.isAncestor(owner, name, current.sha, sha))
        throw new RefError(422, "Update is not a fast forward")
      const value = { ref, sha, node_id: current?.node_id ?? this.ids.next("REF_") }
      if (current) this.branches.update(id, value)
      else this.branches.insert(id, value)
      return this.reference(owner, name, ref)
    })
  }
  isAncestor(owner: string, name: string, ancestor: string, descendant: string): boolean {
    if (!this.commit(owner, name, ancestor)) return false
    const pending = [descendant],
      seen = new Set<string>()
    while (pending.length) {
      const id = pending.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      const current = this.commit(owner, name, id)
      if (!current) continue
      if (id === ancestor) return true
      pending.push(...current.parents)
    }
    return false
  }
  seed(body: unknown): Repository {
    if (!record(body) || !segment(body.owner) || !segment(body.name))
      return invalid("Synthetic owner and name must be nonempty path segments")
    const owner = body.owner,
      name = body.name,
      repoKey = key(owner, name)
    if (this.repositories.has(repoKey))
      throw new SeedError(409, "Synthetic repository already exists")
    if (body.private !== undefined && typeof body.private !== "boolean")
      return invalid("private must be boolean")
    const defaultBranch = body.default_branch ?? "main"
    if (typeof defaultBranch !== "string" || !defaultBranch || /[\s\0]/.test(defaultBranch))
      return invalid("Invalid synthetic default branch")
    const input = body.commits ?? [],
      branches = body.branches ?? {}
    if (!Array.isArray(input) || !record(branches))
      return invalid("commits must be an array and branches an object")
    const commits = new Map<string, Commit>()
    for (const value of input) {
      if (
        !record(value) ||
        !sha(value.sha) ||
        !Array.isArray(value.parents) ||
        !value.parents.every(sha)
      )
        return invalid("Commit requires a lowercase 40-hex SHA and parent SHAs")
      if (commits.has(value.sha)) return invalid("Duplicate synthetic commit")
      commits.set(value.sha, { sha: value.sha, parents: [...value.parents] })
    }
    const remaining = new Map<string, number>()
    const children = new Map<string, string[]>()
    const ready: string[] = []
    for (const commit of commits.values()) {
      remaining.set(commit.sha, commit.parents.length)
      if (commit.parents.length === 0) ready.push(commit.sha)
      for (const parent of commit.parents) {
        if (!commits.has(parent)) invalid("Every parent must be seeded")
        const descendants = children.get(parent) ?? []
        descendants.push(commit.sha)
        children.set(parent, descendants)
      }
    }
    for (let index = 0; index < ready.length; index++) {
      for (const child of children.get(ready[index] as string) ?? []) {
        const count = (remaining.get(child) as number) - 1
        remaining.set(child, count)
        if (count === 0) ready.push(child)
      }
    }
    if (ready.length !== commits.size) invalid("Synthetic ancestry must be acyclic")
    for (const [branch, id] of Object.entries(branches)) {
      if (!branch || /[\s\0]/.test(branch) || !sha(id) || !commits.has(id))
        return invalid("Branch must name a seeded commit")
    }
    if (Object.keys(branches).length && !Object.hasOwn(branches, defaultBranch))
      return invalid("Seeded branches must include the default branch")
    return this.sqlite.transaction(() => {
      const id = this.repositories.nextSequence(),
        now = new Date(this.now()).toISOString()
      let identity = this.owners.get(owner.toLowerCase())
      if (!identity) {
        identity = {
          login: owner,
          id: this.owners.nextSequence(),
          node_id: this.ids.next("O_"),
          type: "Organization",
        }
        this.owners.insert(owner.toLowerCase(), identity)
      }
      const repo: Repository = {
        id,
        node_id: this.ids.next("R_"),
        name,
        full_name: `${identity.login}/${name}`,
        owner: identity,
        private: body.private === true,
        fork: false,
        default_branch: defaultBranch,
        url: `https://api.github.com/repos/${identity.login}/${name}`,
        html_url: `https://github.com/${identity.login}/${name}`,
        created_at: now,
        updated_at: now,
      }
      this.repositories.insert(repoKey, repo)
      for (const commit of commits.values()) this.commits.insert(`${repoKey}:${commit.sha}`, commit)
      for (const [branch, id] of Object.entries(branches))
        this.branches.insert(`${repoKey}:refs/heads/${branch}`, {
          ref: `refs/heads/${branch}`,
          sha: id as string,
          node_id: this.ids.next("REF_"),
        })
      return repo
    })
  }
}
