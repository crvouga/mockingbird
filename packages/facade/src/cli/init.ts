/**
 * `mockingbird init` — scaffold Mockingbird into a consuming project.
 *
 *   mockingbird init [--providers stripe,junction] [--dir .]
 *                    [--package-manager bun] [--dry-run] [--json] [--help]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { generateSetupContent } from "./templates/init.js"
import {
  type PackageManager,
  KNOWN_PROVIDERS,
  detectPackageManager,
  installCommand,
  readProjectInfo,
} from "./project.js"

export type InitOptions = {
  providers: string[]
  dir: string
  packageManager?: PackageManager
  dryRun: boolean
  json: boolean
}

export type InitAction = {
  type: "install" | "create_file" | "add_readme_section" | "info"
  description: string
  details?: string
}

export type InitResult = {
  actions: InitAction[]
  files: string[]
  installCommands: string[]
  skipReason?: string
}

export async function initProject(opts: InitOptions): Promise<InitResult> {
  const project = await readProjectInfo(opts.dir)
  const actions: InitAction[] = []
  const files: string[] = []
  const installCmds: string[] = []

  // Validate providers
  const validProviders: string[] = []
  const invalidProviders: string[] = []
  for (const p of opts.providers) {
    const key = p.toLowerCase()
    if (KNOWN_PROVIDERS[key]) {
      validProviders.push(key)
    } else {
      invalidProviders.push(p)
    }
  }

  if (invalidProviders.length > 0) {
    return {
      actions: [{
        type: "info",
        description: `Unknown providers: ${invalidProviders.join(", ")}. Known: ${Object.keys(KNOWN_PROVIDERS).join(", ")}`,
      }],
      files: [],
      installCommands: [],
      skipReason: `Unknown providers: ${invalidProviders.join(", ")}`,
    }
  }

  // Check project has a package.json
  if (!project.pkg) {
    return {
      actions: [{
        type: "info",
        description: `No package.json found at ${opts.dir}. Run mockingbird init in a Node/Bun project directory.`,
      }],
      files: [],
      installCommands: [],
      skipReason: "No package.json found",
    }
  }

  const pm = opts.packageManager ?? detectPackageManager(opts.dir)

  // 1. Install @crvouga/mockingbird (and service packages if providers specified)
  const deps: string[] = ["@crvouga/mockingbird"]
  for (const p of validProviders) {
    const dependency = KNOWN_PROVIDERS[p]
    if (dependency) deps.push(dependency)
  }

  const cmd = installCommand(pm, deps, true)
  installCmds.push(cmd)
  actions.push({
    type: "install",
    description: `Install ${deps.join(", ")} as devDependencies`,
    details: cmd,
  })

  // 2. Create test setup file
  const mocksDir = join(opts.dir, "tests", "mocks")
  const setupPath = join(mocksDir, "mockingbird.ts")
  const relPath = relative(opts.dir, setupPath)

  const content = generateSetupContent(validProviders, project.typescript)
  files.push(setupPath)
  actions.push({
    type: "create_file",
    description: `Create ${relPath} with boilerplate mock setup`,
    details: `${content.substring(0, 200)}...`
  })

  if (!opts.dryRun) {
    mkdirSync(mocksDir, { recursive: true })
    writeFileSync(setupPath, content, "utf8")
  }

  // 3. Add README section (optional, only if README.md exists)
  const readmePath = join(opts.dir, "README.md")
  if (existsSync(readmePath)) {
    actions.push({
      type: "info",
      description: "README.md found — add a Mockingbird section manually or re-run with --readme",
    })
  }

  return {
    actions,
    files,
    installCommands: installCmds,
  }
}

export function printInitResult(result: InitResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.skipReason) {
    console.log(`mockingbird init: ${result.skipReason}`)
    process.exit(1)
  }

  console.log("mockingbird init — planned actions:\n")
  for (const action of result.actions) {
    switch (action.type) {
      case "install":
        console.log(`  📦 ${action.description}`)
        if (action.details) console.log(`     ${action.details}`)
        break
      case "create_file":
        console.log(`  📝 ${action.description}`)
        break
      case "add_readme_section":
        console.log(`  📖 ${action.description}`)
        break
      case "info":
        console.log(`  ℹ️  ${action.description}`)
        break
    }
  }

  if (result.files.length > 0) {
    console.log("\nFiles to create:")
    for (const f of result.files) {
      console.log(`  - ${f}`)
    }
  }

  if (result.installCommands.length > 0) {
    console.log("\nInstall commands:")
    for (const cmd of result.installCommands) {
      console.log(`  ${cmd}`)
    }
  }

  console.log("\nRun without --dry-run to apply.")
}