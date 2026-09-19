/**
 * Project detection helpers for the mockingbird CLI.
 *
 * Detects package manager, test framework, and project type from a target directory.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type PackageManager = "npm" | "bun" | "pnpm" | "yarn"
export type TestFramework = "vitest" | "jest" | "bun-test" | "mocha" | "node-test" | null
export type ProjectType = "app" | "lib"

export type ProjectInfo = {
  /** Absolute path to the project root */
  dir: string
  /** Whether the project is ESM */
  esm: boolean
  /** Whether the project uses TypeScript */
  typescript: boolean
  /** Detected or explicit package manager */
  packageManager: PackageManager
  /** Detected test framework */
  testFramework: TestFramework
  /** Project type */
  type: ProjectType
  /** Parsed package.json, or null */
  pkg: Record<string, unknown> | null
}

export const KNOWN_PROVIDERS: Record<string, string> = {
  stripe: "@crvouga/mockingbird-service-stripe",
  junction: "@crvouga/mockingbird-service-junction",
  genebygene: "@crvouga/mockingbird-service-genebygene",
  medplum: "@crvouga/mockingbird-service-medplum",
}

export function detectPackageManager(dir: string): PackageManager {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun"
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(dir, "yarn.lock"))) return "yarn"
  if (existsSync(join(dir, "package-lock.json"))) return "npm"
  // Default to bun if available
  return "bun"
}

export function detectTestFramework(pkg: Record<string, unknown> | null): TestFramework {
  if (!pkg) return null
  const deps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  }
  if (deps.vitest) return "vitest"
  if (deps.jest) return "jest"
  if (deps.mocha) return "mocha"
  if (pkg.engines && (pkg.engines as Record<string, string>).bun) return "bun-test"
  return null
}

export function detectProjectType(pkg: Record<string, unknown> | null): ProjectType {
  if (!pkg) return "app"
  const bin = pkg.bin
  if (bin && typeof bin === "object" && Object.keys(bin).length > 0) return "lib"
  if (bin && typeof bin === "string") return "lib"
  return "app"
}

export async function readProjectInfo(dir: string): Promise<ProjectInfo> {
  const pkgPath = join(dir, "package.json")
  let pkg: Record<string, unknown> | null = null
  if (existsSync(pkgPath)) {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  }

  const typescript = existsSync(join(dir, "tsconfig.json"))
  const esm = pkg?.type === "module" || false

  return {
    dir,
    esm,
    typescript,
    packageManager: detectPackageManager(dir),
    testFramework: detectTestFramework(pkg),
    type: detectProjectType(pkg),
    pkg,
  }
}
export function installCommand(pm: PackageManager, deps: string[], dev: boolean): string {
  const flag = dev ? "--dev" : ""
  switch (pm) {
    case "bun":
      return `bun add ${deps.join(" ")} ${flag}`.trim()
    case "pnpm":
      return `pnpm add ${deps.join(" ")} ${dev ? "--save-dev" : ""}`.trim()
    case "yarn":
      return `yarn add ${deps.join(" ")} ${dev ? "--dev" : ""}`.trim()
    case "npm":
      return `npm install ${deps.join(" ")} ${dev ? "--save-dev" : ""}`.trim()
  }
}
