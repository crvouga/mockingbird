import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { createServer } from "../dist/server.js"
import { normalizeObservation } from "./comparison.mjs"

if (!process.argv.includes("--run") || process.env.MOCKINGBIRD_HERMES_ORACLE_APPROVED !== "1") {
  throw new Error(
    "Opt-in oracle requires --run and explicit approved disposable-process/database execution",
  )
}
const root = resolve(import.meta.dirname, "../../../..")
const python = process.env.HERMES_ORACLE_PYTHON
if (!python)
  throw new Error("Set HERMES_ORACLE_PYTHON to the approved local virtualenv interpreter")
const source = resolve(root, ".mockingbird/hermes-evidence/v2026.8.31")
const scratch = resolve(root, ".mockingbird/hermes-oracle", crypto.randomUUID())
await mkdir(scratch, { recursive: true })
const lock = JSON.parse(await readFile(new URL("source-lock.json", import.meta.url), "utf8"))
const mock = await createServer()
let currentTime = 1700000000
let upstream
const epochs = []
const comparisons = []
const ids = { real: new Map(), mock: new Map() }

const launch = () =>
  new Promise((resolveLaunch, reject) => {
    const child = spawn(
      python,
      [
        resolve(import.meta.dirname, "server.py"),
        "--sources",
        source,
        "--state",
        resolve(scratch, "runs.db"),
        "--time",
        String(currentTime),
        "--allow-disposable-state",
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", HERMES_HOME: scratch },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const lines = createInterface({ input: child.stdout })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`Oracle startup deadline: ${stderr}`))
    }, 10000)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`Oracle exited before ready (${code}): ${stderr}`))
    })
    lines.once("line", (line) => {
      clearTimeout(timer)
      try {
        const ready = JSON.parse(line)
        epochs.push({ ...ready, url: undefined })
        resolveLaunch({ child, url: ready.url, stderr: () => stderr })
      } catch (error) {
        child.kill("SIGTERM")
        reject(error)
      }
    })
  })
const raw = async (url, method, path, body, key = "") => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  })
  return {
    status: response.status,
    replayed: response.headers.get("Idempotency-Replayed"),
    body: await response.json(),
  }
}
const checkedControl = async (url, path, body) => {
  const response = await raw(url, "POST", path, body)
  assert.equal(response.status, 200, `control ${path}: ${JSON.stringify(response.body)}`)
  return response
}
const control = (body) => checkedControl(upstream.url, "/__oracle/control", body)
const admin = (path, body) => checkedControl(mock.url, `/__admin/${path}`, body)
const equal = (label, real, mocked) => {
  const expected = normalizeObservation(real, ids.real)
  const actual = normalizeObservation(mocked, ids.mock)
  assert.deepEqual(actual, expected, label)
  comparisons.push({ label, status: real.status, observation: expected.body })
}
const poll = async (pair, label) => {
  equal(
    label,
    await raw(upstream.url, "GET", `/v1/runs/${pair.real}`),
    await raw(mock.url, "GET", `/v1/runs/${pair.mock}`),
  )
}
const waitRunning = async (id) => {
  const deadline = performance.now() + 3000
  while (true) {
    const response = await raw(upstream.url, "GET", `/v1/runs/${id}`)
    if (response.body.status === "running") return
    if (performance.now() > deadline || ["failed", "cancelled"].includes(response.body.status))
      throw new Error(`Upstream executor did not reach running: ${JSON.stringify(response)}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}
const submit = async (name, key = name) => {
  const body = { input: "synthetic oracle input" }
  const real = await raw(upstream.url, "POST", "/v1/runs", body, key)
  const mocked = await raw(mock.url, "POST", "/v1/runs", body, key)
  assert.equal(real.status, 202)
  assert.equal(mocked.status, 202)
  const pair = { real: real.body.run_id, mock: mocked.body.run_id, key, body }
  ids.real.set(pair.real, name)
  ids.mock.set(pair.mock, name)
  equal(`${name}:admission`, real, mocked)
  await waitRunning(pair.real)
  await admin(`hermes/runs/${pair.mock}/observe`, { status: "running" })
  await poll(pair, `${name}:running`)
  return pair
}
const replay = async (pair, label, body = pair.body) =>
  equal(
    label,
    await raw(upstream.url, "POST", "/v1/runs", body, pair.key),
    await raw(mock.url, "POST", "/v1/runs", body, pair.key),
  )
const stop = async (pair) =>
  equal(
    `${pair.key}:stop`,
    await raw(upstream.url, "POST", `/v1/runs/${pair.real}/stop`, {}),
    await raw(mock.url, "POST", `/v1/runs/${pair.mock}/stop`, {}),
  )
const settle = async (pair, status) => {
  const result =
    status === "cancelled"
      ? { interrupted: true }
      : status === "failed"
        ? { failed: true, error: "synthetic failure" }
        : { final_response: "synthetic output" }
  await control({ settle: pair.real, result })
  await admin(`hermes/runs/${pair.mock}/observe`, {
    status,
    last_event: `run.${status}`,
    ...(status === "completed"
      ? {
          output: "synthetic output",
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        }
      : {}),
    ...(status === "failed" ? { error: "synthetic failure" } : {}),
  })
  await poll(pair, `${pair.key}:${status}`)
}
const setTime = async (time) => {
  currentTime = time
  await control({ time })
  await admin("clock", { set: time * 1000, freeze: true })
}
const crash = async () => {
  const old = upstream
  upstream = undefined
  if (old.child.exitCode !== null || old.child.signalCode !== null)
    throw new Error(`Oracle exited unexpectedly: ${old.stderr()}`)
  let timer
  const exited = new Promise((resolveExit, reject) => {
    old.child.once("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolveExit()
      else reject(new Error(`Oracle process exited with ${code}`))
    })
    timer = setTimeout(() => {
      old.child.kill("SIGTERM")
      reject(new Error("Oracle crash endpoint did not exit the owned process"))
    }, 6000)
  })
  // Observe rejection immediately while awaiting the expected lost connection.
  const outcome = exited.then(
    () => null,
    (error) => error,
  )
  await fetch(`${old.url}/__oracle/crash`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
  const error = await outcome
  if (error) throw error
}
try {
  upstream = await launch()
  await admin("clock", { set: currentTime * 1000, freeze: true })
  const cancelled = await submit("cancelled")
  await replay(cancelled, "active replay")
  await replay(cancelled, "changed body conflicts", { input: "different synthetic input" })
  await stop(cancelled)
  await settle(cancelled, "cancelled")
  await replay(cancelled, "terminal replay")
  const completed = await submit("completion-race")
  await stop(completed)
  await settle(completed, "completed")
  const failed = await submit("failure")
  await settle(failed, "failed")
  const cached = await submit("cache-boundary", "")
  await settle(cached, "completed")
  await setTime(1700000000 + 3600)
  await control({ sweep: true })
  await admin("hermes/sweep", {})
  await poll(cached, "cache TTL equality retains keyless terminal observation")
  await setTime(1700000000 + 3600.001)
  await control({ sweep: true })
  await admin("hermes/sweep", {})
  await poll(cached, "cache TTL strictly greater expires keyless terminal observation")
  const unfinished = await submit("unfinished")
  const keyless = await submit("keyless", "")
  await crash()
  upstream = await launch()
  assert.notEqual(epochs[0].pid, epochs[1].pid, "restart must create a fresh process")
  await admin("hermes/restart", { owner: "stale" })
  await poll(completed, "terminal survives real process restart")
  await poll(unfinished, "unfinished run interrupted after real process restart")
  await poll(keyless, "keyless run lost after real process restart")
  await replay(unfinished, "interrupted reservation replay")
  await setTime(1700000000 + 86400)
  await replay(completed, "durable TTL equality retains reservation")
  await setTime(1700000000 + 86400.001)
  await poll(completed, "GET alone does not prune durable history")
  const renewed = await submit("renewed", completed.key)
  assert.notEqual(renewed.real, completed.real)
  assert.notEqual(renewed.mock, completed.mock)
  await control({ sweep: true })
  await admin("hermes/sweep", {})
  await poll(completed, "pruned and swept result returns ordinary404")
  await settle(renewed, "completed")
  const report = {
    release: lock.release,
    commit: lock.commit,
    sources: lock.sources,
    epochs,
    comparisons,
    limitations: [
      "scripted executor; no inference",
      "ordinary default test listener; no credential enforcement claim",
      "routing/session/approval/process-tool integrations substituted; no hosted rooms",
      "controlled clock and explicit sweep; no background timing claim",
    ],
  }
  await writeFile(resolve(scratch, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    JSON.stringify({ comparisons: comparisons.length, report: resolve(scratch, "report.json") }),
  )
} catch (error) {
  if (upstream) console.error(upstream.stderr())
  throw error
} finally {
  try {
    if (upstream) await crash()
  } finally {
    await mock.close()
  }
}
