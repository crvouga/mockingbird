/**
 * Local development on loopback with in-memory storage and dev sign-in, no accounts needed:
 *   bun run dev
 * Set DATABASE_URL / S3_* / OIDC_* in `.env.local` to run against real infrastructure instead.
 */
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const build = Bun.spawnSync(["bun", "scripts/build.ts"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
})
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
const env = { ...process.env }
if (!env.OIDC_ISSUER) env.AUTH_DEV_LOGIN ??= "1"
env.PUBLIC_DIR = join(root, "dist/public")
const child = Bun.spawn(["bun", "--watch", "src/main.ts"], {
  cwd: root,
  env,
  stdio: ["inherit", "inherit", "inherit"],
})
process.on("SIGINT", () => child.kill("SIGINT"))
process.exit(await child.exited)
