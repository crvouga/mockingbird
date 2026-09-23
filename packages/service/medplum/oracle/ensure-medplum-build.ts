import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { joinPath, resolveMedplumPaths } from "./paths.js"

export type EnsureBuildOptions = {
  version?: string | undefined
  cacheDir?: string | undefined
  onLog?: ((message: string) => void) | undefined
}

const BUILD_TIMEOUT_MILLISECONDS = 60 * 60 * 1000
const CLONE_TIMEOUT_MILLISECONDS = 10 * 60 * 1000
const INSTALL_TIMEOUT_MILLISECONDS = 30 * 60 * 1000

const log = (onLog: ((message: string) => void) | undefined, message: string): void => {
  onLog?.(message)
}

type RunResult = {
  code: number
  tail: string[]
}

const runCommand = async (
  command: string,
  args: string[],
  options: { cwd?: string | undefined; timeoutMs: number; logPath?: string | undefined },
): Promise<RunResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const tail: string[] = []
    const capture = (chunk: Buffer) => {
      const text = chunk.toString()
      tail.push(text)
      if (tail.length > 40) tail.shift()
      if (options.logPath) {
        void appendFile(options.logPath, text).catch(() => {})
      }
    }
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, tail })
    })
  })
}

const runStep = async (
  name: string,
  command: string,
  args: string[],
  options: { cwd?: string | undefined; timeoutMs: number; logPath: string },
): Promise<void> => {
  const result = await runCommand(command, args, options)
  if (result.code !== 0) {
    throw new Error(
      `medplum build step "${name}" failed with exit code ${result.code}. Last output:\n${result.tail.join("")}`,
    )
  }
}

/**
 * Ensure a pinned Medplum monorepo clone is installed and built under the
 * shared cache, following the official install-from-scratch flow
 * (git clone -> npm ci -> npm run build:fast). Idempotent: a marker file
 * short-circuits the expensive steps.
 */
export const ensureMedplumBuild = async (options: EnsureBuildOptions = {}) => {
  const paths = resolveMedplumPaths({ version: options.version, cacheDir: options.cacheDir })
  const onLog = options.onLog

  if (existsSync(paths.buildMarker) && existsSync(paths.serverEntry)) {
    return paths
  }

  if (!process.env.HOME && !paths.cacheRoot.startsWith("/")) {
    throw new Error("Cannot resolve the medplum clone cache: HOME is not set")
  }

  const needsClone = !existsSync(joinPath(paths.cloneDir, "package.json"))
  await mkdir(paths.cloneDir, { recursive: true })
  const logPath = join(paths.cacheRoot, `${paths.version}.log`)

  if (needsClone) {
    log(
      onLog,
      `[medplum-mock] cloning medplum ${paths.version} (one-time, cached at ${paths.cloneDir})`,
    )
    await runStep(
      "git clone",
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        paths.version,
        "https://github.com/medplum/medplum.git",
        paths.cloneDir,
      ],
      {
        timeoutMs: CLONE_TIMEOUT_MILLISECONDS,
        logPath,
      },
    )
  }

  const nodeModulesReady = existsSync(
    joinPath(paths.cloneDir, "node_modules", ".package-lock.json"),
  )
  if (!nodeModulesReady) {
    log(onLog, `[medplum-mock] npm ci in ${paths.cloneDir} (one-time, several minutes)`)
    await runStep("npm ci", "npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: paths.cloneDir,
      timeoutMs: INSTALL_TIMEOUT_MILLISECONDS,
      logPath,
    })
  }

  const buildReady = existsSync(paths.serverEntry)
  if (!buildReady) {
    log(onLog, `[medplum-mock] building medplum server (one-time, several minutes)`)
    await runStep("npm run build:fast", "npm", ["run", "build:fast"], {
      cwd: paths.cloneDir,
      timeoutMs: BUILD_TIMEOUT_MILLISECONDS,
      logPath,
    })
  }

  if (!existsSync(paths.serverEntry)) {
    throw new Error(`medplum build finished but the server entry is missing: ${paths.serverEntry}`)
  }

  await writeFile(paths.buildMarker, new Date().toISOString())
  log(onLog, `[medplum-mock] medplum ${paths.version} ready at ${paths.cloneDir}`)
  return paths
}
