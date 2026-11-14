import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { BuildOptions, Plugin } from "esbuild"
import { fs } from "memfs"
import stdlib from "node-stdlib-browser"

const here = dirname(fileURLToPath(import.meta.url))
const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js"
const unsupported = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "http2",
  "module",
  "net",
  "readline",
  "repl",
  "tls",
  "tty",
  "worker_threads",
  "async_hooks",
  "inspector",
  "v8",
  "trace_events",
])
const aliases: Record<string, string> = stdlib

/** esbuild configuration shared by hosts; no environment values are copied from the build machine. */
export function browserRuntimeBuildOptions(): Pick<
  BuildOptions,
  "plugins" | "inject" | "platform"
> {
  const plugin: Plugin = {
    name: "mockingbird-browser-runtime",
    setup(build) {
      build.onResolve({ filter: /\.node$/ }, (args) => ({
        errors: [{ text: `Native addon ${args.path} cannot run in the browser` }],
      }))
      build.onResolve({ filter: /^[a-z_]/ }, (args) => {
        const name = args.path.replace(/^node:/, "")
        if (unsupported.has(name) || args.path.startsWith("bun:")) {
          return {
            errors: [
              {
                text: `Unsupported browser runtime module: ${args.path}. Use a browser-compatible dependency or explicit system adapter.`,
              },
            ],
          }
        }
        if (
          name === "fs" ||
          name === "fs/promises" ||
          name === "stream/web" ||
          name === "bun" ||
          name === "http" ||
          name === "crypto" ||
          name === "assert/strict" ||
          name === "path/posix" ||
          name === "stream/promises"
        )
          return { path: name, namespace: "browser-runtime" }
        const target = aliases[args.path]
        if (target) return build.resolve(target, { resolveDir: here, kind: args.kind })
        if (args.path.startsWith("node:"))
          return { errors: [{ text: `Unknown browser Node polyfill: ${args.path}` }] }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: "browser-runtime" }, (args) => {
        if (args.path === "bun")
          return {
            contents: `import { browserRuntime } from ${JSON.stringify(join(here, `runtime${extension}`))}; export const { serve, file, write, env, sleep } = browserRuntime.bun; export default browserRuntime.bun;`,
            resolveDir: here,
          }
        if (args.path === "crypto") {
          const names = [
            "createHash",
            "createHmac",
            "randomBytes",
            "randomFill",
            "randomFillSync",
            "pbkdf2",
            "pbkdf2Sync",
            "createSign",
            "createVerify",
            "createCipheriv",
            "createDecipheriv",
            "createDiffieHellman",
            "getDiffieHellman",
            "getHashes",
            "getCiphers",
          ]
          return {
            contents: `import legacy from ${JSON.stringify(stdlib.crypto)}; export const { ${names.join(",")} } = legacy; export const webcrypto = globalThis.crypto; export const subtle = webcrypto.subtle; export const randomUUID = () => webcrypto.randomUUID(); export const getRandomValues = value => webcrypto.getRandomValues(value); export default { ...legacy, webcrypto, subtle, randomUUID, getRandomValues };`,
            resolveDir: here,
          }
        }
        if (args.path === "assert/strict")
          return {
            contents: `import assert from ${JSON.stringify(stdlib.assert)}; export default assert.strict;`,
            resolveDir: here,
          }
        if (args.path === "path/posix")
          return {
            contents: `import path from ${JSON.stringify(stdlib.path)}; export const { resolve, normalize, isAbsolute, join, relative, dirname, basename, extname, format, parse, sep, delimiter } = path; export default path;`,
            resolveDir: here,
          }
        if (args.path === "stream/promises")
          return {
            contents:
              'import { pipeline as callbackPipeline, finished as callbackFinished } from "stream"; export const pipeline = (...args) => new Promise((resolve, reject) => callbackPipeline(...args, error => error ? reject(error) : resolve())); export const finished = stream => new Promise((resolve, reject) => { const cleanup = callbackFinished(stream, error => { cleanup(); error ? reject(error) : resolve(); }); });',
            resolveDir: here,
          }
        if (args.path === "http") {
          return {
            contents: `import client from ${JSON.stringify(stdlib.http)}; import { createServer, Server, IncomingMessage, ServerResponse } from ${JSON.stringify(join(here, `http${extension}`))}; export const { request, get, Agent, STATUS_CODES, METHODS, globalAgent } = client; export { createServer, Server, IncomingMessage, ServerResponse }; export default { ...client, createServer, Server, IncomingMessage, ServerResponse };`,
            resolveDir: here,
          }
        }
        if (args.path === "stream/web")
          return {
            contents:
              "export const { ReadableStream, WritableStream, TransformStream, ByteLengthQueuingStrategy, CountQueuingStrategy } = globalThis;",
          }
        const source = args.path === "fs" ? fs : fs.promises
        const member = args.path === "fs" ? "fs" : "fs.promises"
        const names = Object.keys(source)
          .filter((name) => name !== "fs")
          .filter((name) => /^[a-zA-Z_$][\w$]*$/.test(name) && name !== "default")
        return {
          contents: `import { browserRuntime } from ${JSON.stringify(join(here, `runtime${extension}`))}; const fs = browserRuntime.${member}; export default fs;\n${names.map((name) => `export const ${name} = fs[${JSON.stringify(name)}];`).join("\n")}`,
          resolveDir: here,
        }
      })
    },
  }
  return { platform: "browser", plugins: [plugin], inject: [join(here, `globals${extension}`)] }
}
