import { execFile } from "node:child_process"
import { promisify } from "node:util"

/** User-selected gh authentication; credential stays in this process, never in files or logs. */
export async function ghCredential(run = promisify(execFile)) {
  try {
    const result = await run("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8",
      maxBuffer: 16384,
      env: { ...process.env, GH_DEBUG: "", DEBUG: "" },
    })
    const token = result.stdout.trim()
    if (!token || /\s/.test(token)) throw new Error("Invalid credential output")
    return token
  } catch {
    throw new Error("GitHub CLI authentication unavailable; authenticate gh for github.com")
  }
}
