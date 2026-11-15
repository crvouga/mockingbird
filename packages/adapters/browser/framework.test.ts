import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "@playwright/test"
import { build } from "esbuild"
import ts from "typescript"
import { browserRuntimeBuildOptions } from "./src/build.js"
import { createModuleRegistry } from "./src/modules.js"

test("module registry caches declared modules and never resolves unknown paths", () => {
  const dependencyName = "dependency"
  const inheritedName = "constructor"
  let loads = 0
  const registry = createModuleRegistry({ dependency: () => ({ count: ++loads }) })
  expect(registry.require(dependencyName)).toEqual({ count: 1 })
  expect(registry.require(dependencyName)).toBe(registry.require(dependencyName))
  expect(() => registry.require("node:fs")).toThrow("not in the browser registry")
  expect(() => registry.require(inheritedName)).toThrow("not in the browser registry")
  registry.clear()
  expect(registry.require(dependencyName)).toEqual({ count: 2 })
})

test("build adapters must be explicit absolute paths", () => {
  expect(() => browserRuntimeBuildOptions({ adapters: { async_hooks: "./fake.js" } })).toThrow(
    "absolute",
  )
  expect(() => browserRuntimeBuildOptions({ modules: { helper: "./helper.js" } })).toThrow(
    "absolute",
  )
  expect(() => browserRuntimeBuildOptions({ sourceRoot: "./app" })).toThrow("absolute")
})

test("framework compiler, virtual source locations and declared dynamic modules compose", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-framework-"))
  try {
    const dependency = join(dir, "dependency.cjs")
    await writeFile(dependency, "module.exports = { value: 42 };")
    const entry = join(dir, "entry.ts")
    await writeFile(
      entry,
      `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      function classDecorator(target: Function) { return target; }
      @classDecorator
      class Example { constructor(readonly name: string) {} }
      globalThis.result = [require(${JSON.stringify("dependency")}).value, __filename, __dirname, import.meta.url, new Example("name").name];
    `,
    )
    const output = await build({
      ...browserRuntimeBuildOptions({
        modules: { dependency },
        sourceRoot: dir,
        transformSource: async (source, filename) =>
          filename === entry
            ? {
                contents: ts.transpileModule(source, {
                  compilerOptions: {
                    experimentalDecorators: true,
                    emitDecoratorMetadata: true,
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.ESNext,
                  },
                }).outputText,
                loader: "js",
              }
            : undefined,
      }),
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      minify: true,
      logLevel: "silent",
    })
    const source = output.outputFiles[0]?.text ?? ""
    expect(source).toContain("design:paramtypes")
    expect(source.includes(dir)).toBe(false)
    const result = new Function(`${source}; return globalThis.result;`)()
    expect(result).toEqual([42, "/entry.ts", "/", "file:///entry.ts", "name"])
    Reflect.deleteProperty(globalThis, "result")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("async hooks remain unsupported without an explicit verified adapter", async () => {
  await expect(
    build({
      ...browserRuntimeBuildOptions(),
      stdin: {
        contents:
          'import { AsyncLocalStorage } from "node:async_hooks"; globalThis.context = new AsyncLocalStorage();',
        resolveDir: import.meta.dir,
      },
      bundle: true,
      write: false,
      logLevel: "silent",
    }),
  ).rejects.toThrow("Unsupported browser runtime module")
})

test("public assets mount before bundled entrypoints without host environment inheritance", async () => {
  const output = await build({
    ...browserRuntimeBuildOptions({
      assets: { "/app/config.json": '{"mode":"preview"}', "/app/bytes": new Uint8Array([0, 255]) },
    }),
    stdin: {
      contents: `import { readFileSync } from "node:fs"; globalThis.result = [readFileSync("/app/config.json", "utf8"), [...readFileSync("/app/bytes")], Object.keys(process.env)];`,
      resolveDir: import.meta.dir,
    },
    bundle: true,
    write: false,
    format: "iife",
    minify: true,
    logLevel: "silent",
  })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.addScriptTag({ content: output.outputFiles[0]?.text ?? "" })
    expect(await page.evaluate<unknown>("globalThis.result")).toEqual([
      '{"mode":"preview"}',
      [0, 255],
      [],
    ])
  } finally {
    await browser.close()
  }
}, 30_000)

test("source locations preserve the caller's automatic JSX transform", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-jsx-"))
  try {
    const entry = join(dir, "entry.tsx")
    await writeFile(entry, 'globalThis.rendered = <div title="preview"/>;')
    const output = await build({
      ...browserRuntimeBuildOptions({ sourceRoot: dir }),
      entryPoints: [entry],
      jsx: "automatic",
      alias: { "react/jsx-runtime": Bun.resolveSync("react/jsx-runtime", import.meta.dir) },
      bundle: true,
      write: false,
      format: "iife",
      logLevel: "silent",
    })
    const element = new Function(`${output.outputFiles[0]?.text}; return globalThis.rendered;`)()
    expect(element.type).toBe("div")
    expect(element.props.title).toBe("preview")
  } finally {
    Reflect.deleteProperty(globalThis, "rendered")
    await rm(dir, { recursive: true, force: true })
  }
})

test("source locations honor inherited TypeScript class-field semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browser-tsconfig-"))
  try {
    const entry = join(dir, "entry.ts")
    await writeFile(
      join(dir, "base.json"),
      JSON.stringify({ compilerOptions: { useDefineForClassFields: false } }),
    )
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }))
    await writeFile(
      entry,
      `class Parent { set value(next) { globalThis.assigned = next; } }
      class Child extends Parent { value = 42; }
      new Child();`,
    )
    const output = await build({
      ...browserRuntimeBuildOptions({ sourceRoot: dir }),
      tsconfig: join(dir, "tsconfig.json"),
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      logLevel: "silent",
    })
    new Function(output.outputFiles[0]?.text ?? "")()
    expect(Reflect.get(globalThis, "assigned")).toBe(42)
  } finally {
    Reflect.deleteProperty(globalThis, "assigned")
    await rm(dir, { recursive: true, force: true })
  }
})
