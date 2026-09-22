/** A stable identifier for a point in a {@link Timeline}. */
export type CheckpointId = string

/** An immutable node in a timeline's checkpoint DAG. */
export type Checkpoint<T> = Readonly<{
  id: CheckpointId
  branch: string
  parent: CheckpointId | null
  /** Logical time supplied by the timeline's injected clock. */
  at: number
  value: T
}>

export type TimelineOptions = {
  /** Logical clock used to stamp checkpoints. Defaults to a deterministic counter. */
  now?: () => number
  /** Maximum retained checkpoints. Branch heads are never collected. Default 1,000. */
  maxCheckpoints?: number
  /** Customize deterministic checkpoint IDs. */
  id?: (sequence: number) => CheckpointId
}

export type CommitOptions = {
  branch?: string
  /** Parent checkpoint. Defaults to the selected branch's current head. */
  parent?: CheckpointId | null
}

export type ForkOptions = {
  /** Checkpoint to fork from. Defaults to the main branch's head. */
  from?: CheckpointId
}

const BRANCH_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * Small, storage-agnostic checkpoint DAG shared by service runtimes. Its values may be immutable
 * records, namespace images, or copy-on-write SQL engine snapshots.
 *
 * Values are retained by reference. Engines can therefore use persistent/COW snapshots while
 * simpler services can use immutable values. IDs and GC order are deterministic, and all IO
 * (the logical clock) is injected.
 */
export class Timeline<T> {
  readonly maxCheckpoints: number
  private readonly now: () => number
  private readonly makeId: (sequence: number) => CheckpointId
  private readonly nodes = new Map<CheckpointId, Checkpoint<T>>()
  private readonly heads = new Map<string, CheckpointId>()
  /** Unreferenced nodes in the exact order they became collectible. */
  private readonly evictable = new Set<CheckpointId>()
  /** Branch heads plus explicit retainers. Absent means zero. */
  private readonly references = new Map<CheckpointId, number>()
  private readonly explicitPins = new Map<CheckpointId, number>()
  private sequence = 0

  constructor(options: TimelineOptions = {}) {
    const max = options.maxCheckpoints ?? 1_000
    if (!Number.isSafeInteger(max) || max < 1)
      throw new RangeError("maxCheckpoints must be a positive integer")
    this.maxCheckpoints = max
    this.now = options.now ?? (() => this.sequence)
    this.makeId = options.id ?? ((sequence) => `cp_${sequence.toString(36).padStart(8, "0")}`)
  }

  /** Capture a new immutable value and move `branch` to it. */
  commit(value: T, options: CommitOptions = {}): Checkpoint<T> {
    const branch = options.branch ?? "main"
    this.assertBranch(branch)
    const parent = options.parent === undefined ? (this.heads.get(branch) ?? null) : options.parent
    if (parent !== null && !this.nodes.has(parent)) throw new RangeError(`no checkpoint ${parent}`)
    const id = this.makeId(++this.sequence)
    if (this.nodes.has(id)) throw new RangeError(`duplicate checkpoint id ${id}`)
    const checkpoint = Object.freeze({ id, branch, parent, at: this.now(), value })
    this.nodes.set(id, checkpoint)
    this.moveHead(branch, id)
    this.collect(this.maxCheckpoints)
    return checkpoint
  }

  /** Create a branch pointer without copying its checkpoint value. */
  fork(branch: string, options: ForkOptions = {}): Checkpoint<T> | undefined {
    this.assertBranch(branch)
    if (this.heads.has(branch)) throw new RangeError(`branch already exists: ${branch}`)
    const from = options.from ?? this.heads.get("main")
    if (from === undefined) return undefined
    const checkpoint = this.get(from)
    this.moveHead(branch, checkpoint.id)
    return checkpoint
  }

  /** Move a branch pointer to an existing checkpoint. */
  checkout(branch: string, id: CheckpointId): Checkpoint<T> {
    this.assertBranch(branch)
    const checkpoint = this.get(id)
    this.moveHead(branch, checkpoint.id)
    return checkpoint
  }

  get(id: CheckpointId): Checkpoint<T> {
    const checkpoint = this.nodes.get(id)
    if (!checkpoint) throw new RangeError(`no checkpoint ${id}`)
    return checkpoint
  }

  head(branch = "main"): Checkpoint<T> | undefined {
    const id = this.heads.get(branch)
    return id === undefined ? undefined : this.get(id)
  }

  hasBranch(branch: string): boolean {
    return this.heads.has(branch)
  }

  branches(): Readonly<Record<string, CheckpointId>> {
    return Object.freeze(
      Object.fromEntries([...this.heads].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    )
  }

  checkpoints(): readonly Checkpoint<T>[] {
    return [...this.nodes.values()]
  }

  /** Number of retained checkpoints without allocating an array. */
  get size(): number {
    return this.nodes.size
  }

  /** Pin a checkpoint independently of branch heads (used by compatibility snapshot handles). */
  retain(id: CheckpointId): Checkpoint<T> {
    const checkpoint = this.get(id)
    this.explicitPins.set(id, (this.explicitPins.get(id) ?? 0) + 1)
    this.addReference(id)
    return checkpoint
  }

  /** Release one explicit pin. Branch heads remain pinned until moved or deleted. */
  release(id: CheckpointId): boolean {
    if (!this.nodes.has(id)) return false
    const pins = this.explicitPins.get(id) ?? 0
    if (pins === 0) return false
    if (pins === 1) this.explicitPins.delete(id)
    else this.explicitPins.set(id, pins - 1)
    this.removeReference(id)
    this.collect(this.maxCheckpoints)
    return true
  }

  deleteBranch(branch: string): boolean {
    if (branch === "main") throw new RangeError("cannot delete main branch")
    const previous = this.heads.get(branch)
    const deleted = this.heads.delete(branch)
    if (previous !== undefined) this.removeReference(previous)
    this.collect(this.maxCheckpoints)
    return deleted
  }

  /**
   * Deterministically discard oldest unpinned checkpoints. Collection is O(number removed):
   * commits never scan pinned nodes or the retained history. Parents are metadata rather than a
   * storage dependency, so a retained node remains usable after pruning.
   */
  gc(max = this.maxCheckpoints): CheckpointId[] {
    if (!Number.isSafeInteger(max) || max < 1)
      throw new RangeError("max must be a positive integer")
    const removed: CheckpointId[] = []
    this.collect(max, removed)
    return removed
  }

  private collect(max: number, removed?: CheckpointId[]): void {
    while (this.nodes.size > max && this.evictable.size > 0) {
      const id = this.evictable.values().next().value as CheckpointId
      this.evictable.delete(id)
      this.nodes.delete(id)
      removed?.push(id)
    }
  }

  private moveHead(branch: string, id: CheckpointId): void {
    const previous = this.heads.get(branch)
    if (previous === id) return
    if (previous !== undefined) this.removeReference(previous)
    this.heads.set(branch, id)
    this.addReference(id)
  }

  private addReference(id: CheckpointId): void {
    this.references.set(id, (this.references.get(id) ?? 0) + 1)
    this.evictable.delete(id)
  }

  private removeReference(id: CheckpointId): void {
    const next = (this.references.get(id) ?? 0) - 1
    if (next > 0) this.references.set(id, next)
    else {
      this.references.delete(id)
      if (this.nodes.has(id)) this.evictable.add(id)
    }
  }

  private assertBranch(branch: string): void {
    if (!BRANCH_PATTERN.test(branch)) throw new RangeError(`branch must match ${BRANCH_PATTERN}`)
  }
}
