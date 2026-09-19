#!/usr/bin/env node
/**
 * Mockingbird CLI — `mockingbird init` for agent-friendly project setup.
 *
 * Usage:
 *   mockingbird --help
 *   mockingbird --version
 *   mockingbird init [--providers stripe,junction] [--dir .] [--package-manager bun] [--dry-run] [--json]
 */
import { readFileSync } from "node:fs"
import { type InitOptions, initProject, printInitResult } from "./init.js"
import type { PackageManager } from "./project.js"

const VERSION = "0.0.0-development"

function readVersion(): string {
  try {
    // dist/cli/index.js → package root; the release job stamps the real version there.
    const pkgPath = new URL("../../package.json", import.meta.url).pathname
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
    return pkg.version ?? VERSION
  } catch {
    return VERSION
  }
}

function showHelp(): void {
  console.log(`mockingbird ${readVersion()}
    
Usage: mockingbird <command> [options]

Commands:
  init              Scaffold Mockingbird into a consuming project
  --help, -h        Show this help
  --version, -v     Print version

Options for init:
  --providers       Comma-separated provider list (stripe,junction,genebygene,medplum)
  --dir             Target project directory (default: current directory)
  --package-manager Package manager to use (bun, npm, pnpm, yarn; default: auto-detect)
  --dry-run         Preview changes without applying
  --json            Output structured JSON for programmatic consumption
  --help            Show init help

Examples:
  mockingbird init --providers stripe --dir ./my-app
  mockingbird init --providers stripe,junction --dry-run --json
  mockingbird init --help`)
}

function showInitHelp(): void {
  console.log(`mockingbird init — scaffold Mockingbird into a consuming project

This command installs @crvouga/mockingbird and optionally provider-specific
service packages, then creates a boilerplate test setup file.

Designed for agent-friendly use: all options are flag-driven, and --json
output is machine-parseable.

Options:
  --providers <list>      Comma-separated provider names: stripe, junction, genebygene, medplum
  --dir <path>            Target project directory (default: .)
  --package-manager <pm>  Force a package manager: bun, npm, pnpm, yarn
  --dry-run               Print planned actions without making changes
  --json                  Output structured JSON
  --help                  Show this help

Examples:
  mockingbird init --providers stripe --dir ./my-app
  mockingbird init --providers stripe,junction --dry-run --json
  mockingbird init --help`)
}

function parseArgs(): { command: string; options: Record<string, string | boolean | string[]> } {
  const args = process.argv.slice(2)
  const command = args[0] ?? ""
  const options: Record<string, string | boolean | string[]> = {}

  if (command === "init") {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue
      switch (arg) {
        case "--dir":
        case "-d":
          options.dir = args[++i] ?? "."
          break
        case "--package-manager":
        case "-p":
          options.packageManager = args[++i] ?? ""
          break
        case "--providers":
        case "-P": {
          const list = args[++i] ?? ""
          options.providers = list.split(",").filter(Boolean)
          break
        }
        case "--dry-run":
          options.dryRun = true
          break
        case "--json":
          options.json = true
          break
        case "--help":
        case "-h":
          options.help = true
          break
        default:
          if (arg.startsWith("--")) {
            console.error(`mockingbird: unknown option ${arg}`)
            process.exit(1)
          }
      }
    }
  }

  if (command === "--help" || command === "-h") {
    options.help = true
  }

  if (command === "--version" || command === "-v") {
    console.log(readVersion())
    process.exit(0)
  }

  return { command, options }
}

// ── Main ───────────────────────────────────────────────────────────

const { command, options } = parseArgs()

if (options.help) {
  if (command === "init") {
    showInitHelp()
  } else {
    showHelp()
  }
  process.exit(0)
}

switch (command) {
  case "init": {
    const packageManager = options.packageManager
    const opts: InitOptions = {
      providers: (options.providers as string[]) ?? [],
      dir: (options.dir as string) ?? process.cwd(),
      dryRun: Boolean(options.dryRun),
      json: Boolean(options.json),
    }
    if (typeof packageManager === "string") {
      if (!["npm", "bun", "pnpm", "yarn"].includes(packageManager)) {
        console.error(`mockingbird init: unknown package manager "${packageManager}"`)
        console.error("  Valid: npm, bun, pnpm, yarn")
        process.exit(1)
      }
      opts.packageManager = packageManager as PackageManager
    }

    const result = await initProject(opts)
    printInitResult(result, Boolean(options.json), Boolean(options.dryRun))
    break
  }

  case "":
    console.log("mockingbird: missing command. Use --help for usage.")
    process.exit(1)
    break

  default:
    console.error(`mockingbird: unknown command "${command}". Use --help for usage.`)
    process.exit(1)
}
