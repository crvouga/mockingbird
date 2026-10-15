/** Compatibility entry point. Infrastructure health has one implementation and one report format. */
import { join } from "node:path"
import { root } from "./lib.ts"

const proc = Bun.spawn(
  [
    process.execPath,
    join(root, "scripts/health/cli.ts"),
    "npm",
    "trusted-publisher",
    "secrets",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
)
process.exitCode = await proc.exited
