import { lstat, mkdir, open, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import { randomUUID } from "node:crypto"
import { createClock, restoreClock, type Clock } from "@crvouga/mockingbird-service"
import type { FleetChild } from "./fleet.js"

type FilePoint = { format: "mockingbird.files/v1"; files: Record<string, string | null>; clock: { now: number; frozen: boolean } }
export type FileParticipant = FleetChild & { read(namespace: string, path: string): Promise<Uint8Array | undefined>; write(namespace: string, path: string, value: Uint8Array): Promise<void> }
/** Host-owned allowlist, scoped directories and bounded file contents. No archive chooses a host path. */
export async function fileParticipant(root: string, files: readonly string[], options: { maxBytes?: number; dependencies?: string[] } = {}): Promise<FileParticipant> {
  if (files.length > 1000 || new Set(files).size !== files.length || files.some((path) => !path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === ".."))) throw new Error("file participant requires a bounded relative-path allowlist")
  await mkdir(root, { recursive: true, mode: 0o700 }); const allowedRoot = await realpath(root), max = options.maxBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(max) || max < 0) throw new Error("invalid file participant byte limit")
  const states = new Map<string, { clock: Clock; origin?: FilePoint; active: number }>(), locked = new Set<string>()
  const nsPath = (namespace: string) => { if (!/^[A-Za-z0-9_.-]{1,64}$/.test(namespace) || namespace === "." || namespace === "..") throw new Error("invalid file namespace"); return join(allowedRoot, namespace) }
  const checkedPath = async (namespace: string, path: string) => {
    if (!files.includes(path)) throw new Error("path is outside file participant allowlist")
    const parent = nsPath(namespace), target = join(parent, path)
    if (relative(parent, target).startsWith(`..${sep}`)) throw new Error("file path escapes allowed root")
    let current = parent
    for (const component of ["", ...path.split("/")]) {
      if (component) current = join(current, component)
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error("file participant refuses symlink traversal") }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    return target
  }
  const get = (namespace: string) => { const state = states.get(namespace); if (!state) throw new Error("file namespace not configured"); return state }
  const read = async (namespace: string, path: string): Promise<Uint8Array | undefined> => {
    const target = await checkedPath(namespace, path)
    let file
    try { file = await open(target, "r") } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
    const chunks: Uint8Array[] = []; let total = 0
    try { for (;;) { const buffer = Buffer.alloc(Math.min(65536, max + 1)), result = await file.read(buffer); if (!result.bytesRead) break; total += result.bytesRead; if (total > max) throw new Error("file participant exceeds byte limit"); chunks.push(buffer.subarray(0, result.bytesRead)) }; return Buffer.concat(chunks) }
    finally { await file.close() }
  }
  const write = async (namespace: string, path: string, value: Uint8Array) => {
    if (value.length > max) throw new Error("file participant exceeds byte limit")
    const target = await checkedPath(namespace, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await checkedPath(namespace, path)
    const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
    try { await writeFile(temp, value, { mode: 0o600, flag: "wx" }); await rename(temp, target) } finally { await rm(temp, { force: true }) }
  }
  const capture = async (namespace: string): Promise<FilePoint> => {
    const state = get(namespace), contents: Record<string, string | null> = {}; let total = 0
    for (const path of files) { const value = await read(namespace, path); total += value?.length ?? 0; if (total > max) throw new Error("file participant exceeds total byte limit"); contents[path] = value ? Buffer.from(value).toString("base64") : null }
    return { format: "mockingbird.files/v1", files: contents, clock: state.clock.state() }
  }
  const validate = (input: unknown): FilePoint => {
    const point = input as FilePoint
    if (!point || point.format !== "mockingbird.files/v1" || !point.files || Array.isArray(point.files) || Object.keys(point.files).length !== files.length || !Number.isFinite(point.clock?.now) || typeof point.clock?.frozen !== "boolean") throw new Error("invalid file archive")
    let total = 0
    for (const [path, value] of Object.entries(point.files)) {
      if (!files.includes(path) || value !== null && (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))) throw new Error("file archive path or encoding is unsupported")
      total += value === null ? 0 : Buffer.from(value, "base64").length
    }
    if (total > max) throw new Error("file archive exceeds total byte limit")
    return structuredClone(point)
  }
  const restore = async (namespace: string, input: unknown) => {
    const point = validate(input)
    for (const path of files) await checkedPath(namespace, path)
    for (const [path, value] of Object.entries(point.files)) if (value === null) await rm(await checkedPath(namespace, path), { force: true }); else await write(namespace, path, Buffer.from(value, "base64"))
    restoreClock(get(namespace).clock, point.clock)
  }
  const create = async (namespace: string) => {
    if (states.has(namespace)) throw new Error("file namespace already exists")
    const directory = nsPath(namespace)
    try { if ((await lstat(directory)).isSymbolicLink()) throw new Error("file namespace refuses symlinks") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await mkdir(directory, { recursive: true, mode: 0o700 }); states.set(namespace, { clock: createClock(), active: 0 }); get(namespace).origin = await capture(namespace)
  }
  await create("default")
  return {
    protocol: "external", url: "file-participant://state/default", dependencies: options.dependencies ?? [],
    coverage: { included: ["allowlisted file bytes", "logical clocks"], excluded: ["filesystem metadata", "symlinks", "uncoordinated external writes"] },
    get namespaces() { return { mechanism: "host-adapter", endpoints: Object.fromEntries([...states.keys()].map((ns) => [ns, `file-participant://state/${ns}`])) } },
    ready: async () => true, close: async () => {},
    lock(namespace) { get(namespace); if (locked.has(namespace)) throw new Error("file namespace locked"); locked.add(namespace); return () => locked.delete(namespace) },
    diagnostics(namespace) { return { activeRequests: get(namespace).active, activeConnections: 0, blockedCommands: 0, pendingJobs: 0, pendingWebhooks: 0, unmatchedRequests: 0 } },
    checkpoint: capture, restore, reset: async (ns) => restore(ns, get(ns).origin), clock: (ns) => get(ns).clock,
    exportCheckpoint: async (_ns, point) => validate(point), importCheckpoint: async (_ns, point) => validate(point), createNamespace: create,
    async deleteNamespace(namespace) { const state = get(namespace); if (state.active) throw new Error("file namespace has active work"); for (const path of files) await rm(await checkedPath(namespace, path), { force: true }); for (const path of [...files].sort((a, b) => b.length - a.length)) {
      let directory = dirname(join(nsPath(namespace), path))
      while (directory !== nsPath(namespace)) { try { await rmdir(directory) } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error }; directory = dirname(directory) }
    }
    await rmdir(nsPath(namespace)); states.delete(namespace) },
    async inspect(namespace, { offset, limit }) { const point = await capture(namespace); return { files: Object.entries(point.files).slice(offset, offset + limit).map(([path, value]) => ({ path, exists: value !== null, bytes: value === null ? 0 : Buffer.from(value, "base64").length })) } },
    nextEvent: () => undefined,
    read,
    async write(namespace, path, value) { const state = get(namespace); if (locked.has(namespace)) throw new Error("file namespace is fenced"); state.active++; try { await write(namespace, path, value) } finally { state.active-- } },
  }
}
