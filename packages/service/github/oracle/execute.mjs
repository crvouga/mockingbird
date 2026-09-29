import { isDeepStrictEqual } from "node:util"
import { digest, validateExecution } from "./plan.mjs"

const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
const refView = (body) => ({
  ref: body.ref,
  object: { type: body.object?.type, sha: body.object?.sha },
})
const repoView = (body) => ({
  full_name: body.full_name,
  owner: body.owner?.login,
  private: body.private,
  default_branch: body.default_branch,
})
const prView = (body) => ({
  title: body.title,
  body: body.body,
  state: body.state,
  draft: body.draft,
  head: { ref: body.head?.ref, sha: body.head?.sha },
  base: { ref: body.base?.ref, sha: body.base?.sha },
})
const errorView = (body) => ({ message: body.message, errors: body.errors })

/** Fixed-origin bounded oracle. Dependency injection is for offline transport tests only. */
export async function executeOracle(
  plan,
  grants,
  { fetch: transport = globalThis.fetch, mock, save = async () => {} } = {},
) {
  validateExecution(plan, grants)
  if (!mock) throw new Error("Local comparison mock required")
  const root = `/repos/${plan.repository}`
  const report = {
    planDigest: digest(plan),
    repository: plan.repository,
    apiVersion: plan.apiVersion,
    startedAt: new Date().toISOString(),
    requests: [],
    comparisons: [],
    receipts: { refs: [], pull: null },
    cleanup: [],
    uncertainWrites: [],
    failures: [],
    retained: plan.retained,
    complete: false,
  }
  let count = 0
  const request = async (label, method, path, body) => {
    if (++count > plan.limits.requests) throw new Error("Request budget exhausted")
    if (!path.startsWith(`${root}/`) && path !== root)
      throw new Error("Out-of-scope repository path")
    const entry = { label, method, path, status: null }
    report.requests.push(entry)
    await save(report)
    let response
    let markedUncertain = false
    const markUncertain = () => {
      if (method !== "GET" && !markedUncertain) {
        report.uncertainWrites.push({ label, method, path })
        markedUncertain = true
      }
    }
    try {
      response = await transport(
        new Request(`${plan.origin}${path}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": plan.apiVersion,
            Authorization: `Bearer ${grants.token}`,
            "content-type": "application/json",
            "user-agent": "mockingbird-bounded-oracle",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    } catch {
      markUncertain()
      await save(report)
      throw new Error(`Transport failed at ${label}; no automatic retry`)
    }
    entry.status = response.status
    if (response.status >= 500) markUncertain()
    entry.selectedVersion = response.headers.get("x-github-api-version-selected")
    entry.requestId = response.headers.get("x-github-request-id")
    let value
    try {
      value = response.status === 204 ? null : await response.json()
    } catch {
      markUncertain()
      await save(report)
      throw new Error(`Unreadable response at ${label}`)
    }
    await save(report)
    return { status: response.status, body: value, version: entry.selectedVersion }
  }
  const requireStatus = (result, status, label) => {
    if (result.status !== status)
      throw new Error(`${label}: expected${status}, received${result.status}`)
    return result.body
  }
  const compare = async (operation, label, method, path, body, real, project) => {
    const response = await mock.fetch(
      new Request(`https://api.github.com${path}`, {
        method,
        headers: { "content-type": "application/json", "X-GitHub-Api-Version": plan.apiVersion },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const value = await response.json()
    const matched =
      response.status === real.status && isDeepStrictEqual(project(real.body), project(value))
    report.comparisons.push({
      operation,
      label,
      realStatus: real.status,
      mockStatus: response.status,
      matched,
    })
    await save(report)
    return value
  }
  let repo, original, first, second, localNumber
  const ownedRef = (name) => `refs/heads/${name}`
  const refPath = (name) => `${root}/git/ref/heads/${name}`
  try {
    const observed = await request("repository", "GET", root)
    repo = requireStatus(observed, 200, "Repository read")
    if (observed.version !== plan.apiVersion)
      throw new Error("Requested API version was not confirmed")
    if (
      repo.full_name?.toLowerCase() !== plan.repository.toLowerCase() ||
      typeof repo.default_branch !== "string"
    )
      throw new Error("Repository identity not confirmed")
    if (Object.values(plan.branches).includes(repo.default_branch))
      throw new Error("Default branch is outside permitted write scope")
    const defaultRef = requireStatus(
      await request("default-ref", "GET", refPath(encodeURIComponent(repo.default_branch))),
      200,
      "Default ref",
    )
    original = defaultRef.object?.sha
    if (!sha(original)) throw new Error("Invalid default commit identity")
    const baseCommit = requireStatus(
      await request("default-commit", "GET", `${root}/git/commits/${original}`),
      200,
      "Commit read",
    )
    if (!sha(baseCommit.tree?.sha)) throw new Error("Invalid base tree identity")
    for (const name of Object.values(plan.branches))
      requireStatus(
        await request("prefix-preflight", "GET", refPath(name)),
        404,
        "Fresh branch preflight",
      )
    let parent = original,
      tree = baseCommit.tree.sha
    const commits = []
    for (let i = 1; i <= 2; i++) {
      const createdTree = requireStatus(
        await request(`fixture-tree-${i}`, "POST", `${root}/git/trees`, {
          base_tree: tree,
          tree: [
            {
              path: plan.file,
              mode: "100644",
              type: "blob",
              content: `Synthetic Mockingbird oracle ${plan.runId} revision${i}\n`,
            },
          ],
        }),
        201,
        "Fixture tree",
      )
      if (!sha(createdTree.sha)) throw new Error("Invalid created tree identity")
      tree = createdTree.sha
      const author = { name: "Mockingbird Oracle", email: "mockingbird-oracle@example.invalid" }
      const created = requireStatus(
        await request(`fixture-commit-${i}`, "POST", `${root}/git/commits`, {
          message: `Synthetic oracle ${plan.runId} revision${i}`,
          tree,
          parents: [parent],
          author,
          committer: author,
        }),
        201,
        "Fixture commit",
      )
      if (!sha(created.sha)) throw new Error("Invalid created commit identity")
      commits.push({ sha: created.sha, parents: [parent] })
      parent = created.sha
    }
    first = commits[0].sha
    second = commits[1].sha
    mock.state.seed({
      owner: repo.owner.login,
      name: repo.name,
      private: repo.private,
      default_branch: repo.default_branch,
      commits: [{ sha: original, parents: [] }, ...commits],
      branches: { [repo.default_branch]: original },
    })
    await compare("repos/get", "repository", "GET", root, undefined, observed, repoView)
    for (const [name, target] of [
      [plan.branches.base, original],
      [plan.branches.head, first],
    ]) {
      const body = { ref: ownedRef(name), sha: target }
      const real = await request("create-owned-ref", "POST", `${root}/git/refs`, body)
      const created = requireStatus(real, 201, "Create owned ref")
      const pendingRef = {
        label: "create-owned-ref",
        method: "POST",
        path: `${root}/git/refs`,
        ...body,
      }
      report.uncertainWrites.push(pendingRef)
      await save(report)
      if (created.ref !== body.ref || created.object?.sha !== target)
        throw new Error("Created ref identity not confirmed")
      report.receipts.refs.push({ name, sha: target })
      report.uncertainWrites.splice(report.uncertainWrites.indexOf(pendingRef), 1)
      await save(report)
      await compare(
        "git/create-ref",
        "create-owned-ref",
        "POST",
        `${root}/git/refs`,
        body,
        real,
        refView,
      )
    }
    const read = await request("read-head", "GET", refPath(plan.branches.head))
    requireStatus(read, 200, "Head read")
    await compare(
      "git/get-ref",
      "read-head",
      "GET",
      refPath(plan.branches.head),
      undefined,
      read,
      refView,
    )
    const listPath = `${root}/git/matching-refs/heads/mockingbird-oracle/${plan.runId}/`
    const refs = await request("list-owned-refs", "GET", listPath)
    requireStatus(refs, 200, "Ref list")
    await compare(
      "git/list-matching-refs",
      "list-owned-refs",
      "GET",
      listPath,
      undefined,
      refs,
      (values) => values.map(refView).sort((a, b) => a.ref.localeCompare(b.ref)),
    )
    const updatePath = `${root}/git/refs/heads/${plan.branches.head}`
    const updateBody = { sha: second, force: false }
    const moved = await request("fast-forward", "PATCH", updatePath, updateBody)
    const movedBody = requireStatus(moved, 200, "Fast forward")
    if (movedBody.object?.sha !== second) throw new Error("Updated ref identity not confirmed")
    report.receipts.refs.find((ref) => ref.name === plan.branches.head).sha = second
    await save(report)
    await compare("git/update-ref", "fast-forward", "PATCH", updatePath, updateBody, moved, refView)
    const staleBody = { sha: first, force: false }
    const stale = await request("non-fast-forward", "PATCH", updatePath, staleBody)
    requireStatus(stale, 422, "Non-fast-forward rejection")
    await compare(
      "git/update-ref",
      "non-fast-forward",
      "PATCH",
      updatePath,
      staleBody,
      stale,
      errorView,
    )
    const prBody = {
      title: plan.title,
      body: `Synthetic bounded oracle ${plan.runId}`,
      head: plan.branches.head,
      base: plan.branches.base,
    }
    const created = await request("create-owned-pr", "POST", `${root}/pulls`, prBody)
    const pull = requireStatus(created, 201, "PR create")
    const pendingPull = { label: "create-owned-pr", method: "POST", path: `${root}/pulls` }
    report.uncertainWrites.push(pendingPull)
    await save(report)
    if (
      typeof pull.node_id !== "string" ||
      !pull.node_id ||
      !Number.isSafeInteger(pull.number) ||
      pull.number < 1 ||
      pull.head?.ref !== plan.branches.head ||
      pull.base?.ref !== plan.branches.base ||
      pull.title !== plan.title
    )
      throw new Error("Created PR identity not confirmed")
    report.receipts.pull = { number: pull.number, nodeId: pull.node_id }
    report.uncertainWrites.splice(report.uncertainWrites.indexOf(pendingPull), 1)
    await save(report)
    localNumber = (
      await compare(
        "pulls/create",
        "create-owned-pr",
        "POST",
        `${root}/pulls`,
        prBody,
        created,
        prView,
      )
    ).number
    const duplicate = await request("duplicate-pr", "POST", `${root}/pulls`, prBody)
    if (duplicate.status >= 200 && duplicate.status < 300) {
      report.uncertainWrites.push({
        label: "unexpected-duplicate-creation",
        method: "POST",
        path: `${root}/pulls`,
        number: Number.isSafeInteger(duplicate.body?.number) ? duplicate.body.number : null,
      })
      await save(report)
    }
    requireStatus(duplicate, 422, "Duplicate rejection")
    await compare(
      "pulls/create",
      "duplicate-pr",
      "POST",
      `${root}/pulls`,
      prBody,
      duplicate,
      errorView,
    )
    const remotePath = `${root}/pulls/${pull.number}`,
      localPath = `${root}/pulls/${localNumber}`
    const get = await request("get-owned-pr", "GET", remotePath)
    requireStatus(get, 200, "PR read")
    await compare("pulls/get", "get-owned-pr", "GET", localPath, undefined, get, prView)
    const query = new URLSearchParams({
      head: `${repo.owner.login}:${plan.branches.head}`,
      base: plan.branches.base,
      state: "open",
      per_page: "1",
    })
    const list = await request("list-owned-pr", "GET", `${root}/pulls?${query}`)
    requireStatus(list, 200, "PR list")
    await compare(
      "pulls/list",
      "list-owned-pr",
      "GET",
      `${root}/pulls?${query}`,
      undefined,
      list,
      (values) => values.map(prView),
    )
    const edit = { title: `${plan.title} edited`, body: "" }
    const updated = await request("edit-owned-pr", "PATCH", remotePath, edit)
    requireStatus(updated, 200, "PR edit")
    await compare("pulls/update", "edit-owned-pr", "PATCH", localPath, edit, updated, prView)
  } catch {
    report.failures.push(
      `Oracle stopped after ${report.requests.at(-1)?.label ?? "initialization"}; inspect statuses and scoped receipts`,
    )
  }
  const cleanup = async () => {
    const pull = report.receipts.pull
    const uncertainPull = report.uncertainWrites.some(
      (entry) => entry.method === "POST" && entry.path === `${root}/pulls`,
    )
    let pullSafe = pull === null && !uncertainPull
    if (pull) {
      try {
        const path = `${root}/pulls/${pull.number}`
        const current = requireStatus(
          await request("cleanup-observe-pr", "GET", path),
          200,
          "PR cleanup observation",
        )
        if (
          current.node_id !== pull.nodeId ||
          current.head?.ref !== plan.branches.head ||
          current.base?.ref !== plan.branches.base ||
          current.head?.repo?.full_name?.toLowerCase() !== plan.repository.toLowerCase() ||
          current.base?.repo?.full_name?.toLowerCase() !== plan.repository.toLowerCase() ||
          current.merged === true
        )
          throw new Error("Ownership changed")
        if (current.state !== "closed")
          requireStatus(
            await request("cleanup-close-pr", "PATCH", path, { state: "closed" }),
            200,
            "PR cleanup close",
          )
        pullSafe = !uncertainPull
        report.cleanup.push({ resource: `pull/${pull.number}`, result: "closed" })
      } catch {
        report.cleanup.push({
          resource: `pull/${pull.number}`,
          result: "preserved: cleanup unconfirmed",
        })
      }
    }
    for (const ref of [...report.receipts.refs].reverse()) {
      try {
        if (
          !pullSafe ||
          report.uncertainWrites.some(
            (entry) =>
              entry.path === `${root}/git/refs/heads/${ref.name}` ||
              entry.ref === ownedRef(ref.name),
          )
        )
          throw new Error("Uncertain resource state")
        const current = requireStatus(
          await request("cleanup-observe-ref", "GET", refPath(ref.name)),
          200,
          "Ref cleanup observation",
        )
        if (current.ref !== ownedRef(ref.name) || current.object?.sha !== ref.sha)
          throw new Error("Ref moved")
        requireStatus(
          await request("cleanup-delete-ref", "DELETE", `${root}/git/refs/heads/${ref.name}`),
          204,
          "Ref cleanup deletion",
        )
        report.cleanup.push({ resource: ref.name, result: "deleted" })
      } catch {
        report.cleanup.push({
          resource: ref.name,
          result: "preserved: identity/tip or cleanup unconfirmed",
        })
      }
    }
    report.finishedAt = new Date().toISOString()
    report.complete =
      report.failures.length === 0 &&
      report.uncertainWrites.length === 0 &&
      report.comparisons.every((item) => item.matched) &&
      new Set(report.comparisons.map((item) => item.operation)).size ===
        plan.comparedOperations.length &&
      report.cleanup.every((item) => ["closed", "deleted"].includes(item.result))
    await save(report)
  }
  await cleanup()
  return report
}
