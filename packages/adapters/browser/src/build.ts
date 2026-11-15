import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { BuildOptions, Loader, Plugin } from "esbuild"
import { build as rewriteLocations } from "esbuild"
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

export type BrowserBuildOptions = {
  /** Explicit replacements, including otherwise unsupported builtins. Values must be absolute. */
  adapters?: Readonly<Record<string, string>>
  /** Finite manifest for dynamic require/createRequire; nothing is read from the host at runtime. */
  modules?: Readonly<Record<string, string>>
  /** Explicit optional dependencies that throw when evaluated, never become empty modules. */
  optionalModules?: readonly string[]
  /** Explicit public files mounted before entrypoints evaluate. Never enumerate a host directory. */
  assets?: Readonly<Record<string, string | Uint8Array>>
  /** Optional source compiler for framework decorators or other syntax esbuild does not support. */
  transformSource?: (
    source: string,
    filename: string,
  ) => Promise<{ contents: string; loader?: Loader } | undefined>
  /** Replace source locations by virtual paths relative to this root. */
  sourceRoot?: string
  /** Enable virtual Node sockets; no OS networking is available. */
  virtualNetwork?: boolean
  /** Zone context requires every bundled async function to be lowered, including dependencies. */
  asyncContext?: "zone"
}

/** esbuild configuration shared by hosts; no environment values are copied from the build machine. */
export function browserRuntimeBuildOptions(
  options: BrowserBuildOptions = {},
): Pick<BuildOptions, "plugins" | "inject" | "platform" | "target" | "supported"> {
  const adapters = new Map(
    Object.entries(options.adapters ?? {}).map(([name, target]) => [
      name.replace(/^node:/, ""),
      target,
    ]),
  )
  if (options.asyncContext && adapters.has("async_hooks"))
    throw new TypeError("Choose Zone context or an explicit async_hooks adapter, not both")
  const modules = Object.entries(options.modules ?? {})
  for (const [name, target] of [...adapters, ...modules]) {
    if (!isAbsolute(target))
      throw new TypeError(`Browser module ${name} must have an absolute build-time path`)
  }
  if (options.sourceRoot && !isAbsolute(options.sourceRoot))
    throw new TypeError("sourceRoot must be absolute")
  const registry = "mockingbird:module-registry"
  const runtimePath = JSON.stringify(join(here, `runtime${extension}`))
  const plugin: Plugin = {
    name: "mockingbird-browser-runtime",
    setup(build) {
      if (options.asyncContext)
        build.onStart(() => {
          const supported = build.initialOptions.supported
          if (supported?.["async-await"] !== false || supported?.["async-generator"] !== false)
            return {
              errors: [
                {
                  text: "Zone async context requires async-await and async-generator lowering for the entire bundle",
                },
              ],
            }
          if (build.initialOptions.external?.length || build.initialOptions.packages === "external")
            return {
              errors: [
                {
                  text: "Zone async context cannot verify external modules; bundle every async function",
                },
              ],
            }
          return undefined
        })
      build.onResolve({ filter: /^mockingbird:module-registry$/ }, (args) => ({
        path: args.path,
        namespace: "browser-support",
      }))
      build.onLoad({ filter: /.*/, namespace: "browser-support" }, () => {
        return {
          contents: `import { createModuleRegistry } from ${JSON.stringify(join(here, `modules${extension}`))}; const registry = createModuleRegistry({${modules.map(([name, target]) => `${JSON.stringify(name)}: () => require(${JSON.stringify(target)})`).join(",")}}); const runtimeRequire = registry.require; export { runtimeRequire as require }; export const createRequire = () => runtimeRequire;`,
          resolveDir: here,
        }
      })
      build.onLoad({ filter: /[/\\]assets\.[jt]s$/ }, (args) => {
        if (args.path !== join(here, `assets${extension}`)) return undefined
        const files = Object.entries(options.assets ?? {}).map(([name, value]) => [
          name,
          typeof value === "string" ? [...new TextEncoder().encode(value)] : [...value],
        ])
        return {
          contents: `export const publicAssets = ${JSON.stringify(Object.fromEntries(files))};`,
          loader: "js",
        }
      })
      if (options.transformSource || options.sourceRoot)
        build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
          if (args.path.startsWith(here + sep)) return undefined
          const original = await readFile(args.path, "utf8")
          const changed = await options.transformSource?.(original, args.path)
          const loader =
            changed?.loader ??
            (args.path.endsWith("tsx")
              ? "tsx"
              : args.path.endsWith("ts")
                ? "ts"
                : args.path.endsWith("jsx")
                  ? "jsx"
                  : "js")
          let contents = changed?.contents ?? original
          if (options.sourceRoot) {
            const within = relative(options.sourceRoot, args.path)
            if (!within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within)) {
              const virtual = `/${within.split(sep).join("/")}`
              const transformed = await rewriteLocations({
                stdin: { contents, loader, sourcefile: args.path, resolveDir: dirname(args.path) },
                write: false,
                jsx: "preserve",
                ...(build.initialOptions.tsconfig !== undefined
                  ? { tsconfig: build.initialOptions.tsconfig }
                  : {}),
                ...(build.initialOptions.tsconfigRaw !== undefined
                  ? { tsconfigRaw: build.initialOptions.tsconfigRaw }
                  : {}),
                logLevel: "silent",
                define: {
                  __filename: JSON.stringify(virtual),
                  __dirname: JSON.stringify(virtual.slice(0, virtual.lastIndexOf("/")) || "/"),
                  "import.meta.url": JSON.stringify(pathToFileURL(virtual).href),
                  "import.meta.filename": JSON.stringify(virtual),
                  "import.meta.dirname": JSON.stringify(
                    virtual.slice(0, virtual.lastIndexOf("/")) || "/",
                  ),
                },
              })
              contents = transformed.outputFiles[0]?.text ?? ""
              return { contents, loader: "jsx", resolveDir: dirname(args.path) }
            }
          }
          return changed ? { contents, loader, resolveDir: dirname(args.path) } : undefined
        })
      build.onResolve({ filter: /\.node$/ }, (args) => ({
        errors: [{ text: `Native addon ${args.path} cannot run in the browser` }],
      }))
      build.onResolve({ filter: /^[a-z_@]/ }, (args) => {
        const name = args.path.replace(/^node:/, "")
        const adapter = adapters.get(name)
        if (adapter) return { path: adapter }
        if (options.optionalModules?.includes(args.path))
          return { path: args.path, namespace: "browser-optional" }
        if (name === "perf_hooks") return { path: join(here, `performance${extension}`) }
        if (options.virtualNetwork && ["dns", "tls", "diagnostics_channel"].includes(name))
          return {
            path: join(
              here,
              "network",
              `${name === "diagnostics_channel" ? "diagnostics-channel" : name}${extension}`,
            ),
          }
        if (name === "async_hooks" && options.asyncContext === "zone")
          return { path: join(here, `async-context${extension}`) }
        if (name === "module" && modules.length > 0)
          return { path: registry, namespace: "browser-support" }
        if (name === "net" && options.virtualNetwork)
          return { path: "net", namespace: "browser-runtime" }
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
        if (name === "util/types") return { path: join(stdlib.util, "support/types.js") }
        const target = aliases[args.path]
        if (target) return build.resolve(target, { resolveDir: here, kind: args.kind })
        if (args.path.startsWith("node:"))
          return { errors: [{ text: `Unknown browser Node polyfill: ${args.path}` }] }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: "browser-optional" }, (args) => ({
        contents: `throw Object.assign(new Error(${JSON.stringify(`Optional module ${args.path} is unavailable in this preview`)}), { code: "ERR_BROWSER_RUNTIME_UNSUPPORTED" });`,
        loader: "js",
      }))
      build.onLoad({ filter: /.*/, namespace: "browser-runtime" }, (args) => {
        if (args.path === "net")
          return {
            contents: `import { browserRuntime } from ${runtimePath}; export const { Socket, Server, createServer, connect, createConnection, isIP, isIPv4, isIPv6 } = browserRuntime.net; export default browserRuntime.net;`,
            resolveDir: here,
          }
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
  return {
    platform: "browser",
    plugins: [plugin],
    inject: [join(here, `globals${extension}`)],
    ...(options.asyncContext
      ? { supported: { "async-await": false, "async-generator": false } }
      : {}),
  }
}
