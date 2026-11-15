import { UnsupportedRuntimeError } from "./runtime.js"

const unsupported = (): never => {
  throw new UnsupportedRuntimeError("child_process")
}
export const exec = unsupported
export const execFile = unsupported
export const execSync = unsupported
export const execFileSync = unsupported
export const spawn = unsupported
export const spawnSync = unsupported
export const fork = unsupported
export default { exec, execFile, execSync, execFileSync, spawn, spawnSync, fork }
