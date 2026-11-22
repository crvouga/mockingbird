import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { scopeCss } from "./src/scope-css.ts"

const S = ":where(.msh-ui)"

test("style rules match only inside the scope, with the same specificity", () => {
  expect(scopeCss(".button{color:red}", ".msh-ui")).toBe(`${S} .button{color:red}`)
  expect(scopeCss("a,b:is(c,d) > e{x:1}", ".msh-ui")).toBe(`${S} a,${S} b:is(c,d) > e{x:1}`)
  expect(scopeCss("*,:after,::backdrop{box-sizing:border-box}", ".msh-ui")).toBe(
    `${S} *,${S} :after,${S} ::backdrop{box-sizing:border-box}`,
  )
})

test("the document's root selectors become the scope itself", () => {
  expect(scopeCss(":root,.dark,[data-theme=dark]{--a:1}", ".msh-ui")).toBe(
    `${S},${S} .dark,${S} [data-theme=dark]{--a:1}`,
  )
  expect(scopeCss("html,:host{line-height:1.5}body{margin:0}", ".msh-ui")).toBe(
    `${S},${S}{line-height:1.5}${S}{margin:0}`,
  )
  expect(scopeCss(":root:has(.open){overflow:hidden}", ".msh-ui")).toBe(
    `${S}:has(.open){overflow:hidden}`,
  )
  // Only the whole word: an element or class that starts with "body" is left alone.
  expect(scopeCss("bodyx{a:b}", ".msh-ui")).toBe(`${S} bodyx{a:b}`)
})

test("conditional at-rules are scoped inside; others pass through", () => {
  expect(
    scopeCss(
      "@layer theme,base;@layer base{@media (hover:hover){.a:hover{b:c}}}@supports (x:y){.d{e:f}}",
      ".msh-ui",
    ),
  ).toBe(
    `@layer theme,base;@layer base{@media (hover:hover){${S} .a:hover{b:c}}}@supports (x:y){${S} .d{e:f}}`,
  )
  const passthrough =
    '@keyframes spin{to{transform:rotate(360deg)}}@property --tw-x{syntax:"*";inherits:false}'
  expect(scopeCss(passthrough, ".msh-ui")).toBe(passthrough)
})

test("nested rules, escapes, strings and comments survive", () => {
  expect(scopeCss(".a{color:red;&:hover{color:blue}@media (x){&{y:z}}}", ".msh-ui")).toBe(
    `${S} .a{color:red;&:hover{color:blue}@media (x){&{y:z}}}`,
  )
  expect(scopeCss(".\\[\\&_svg\\]\\:size-4 svg{width:1rem}", ".msh-ui")).toBe(
    `${S} .\\[\\&_svg\\]\\:size-4 svg{width:1rem}`,
  )
  expect(scopeCss('/*! notice { } */.q:after{content:"{,}"}', ".msh-ui")).toBe(
    `/*! notice { } */${S} .q:after{content:"{,}"}`,
  )
})

test("the compiled stylesheet scopes without losing a rule", () => {
  const file = join(import.meta.dir, "dist/styles.css")
  if (!existsSync(file)) return
  const css = readFileSync(file, "utf8")
  const scoped = scopeCss(css, ".msh-ui")
  const count = (text: string, char: string) => text.split(char).length - 1
  expect(count(scoped, "{")).toBe(count(css, "{"))
  expect(count(scoped, "}")).toBe(count(css, "}"))
  // Nothing left that matches outside the scope.
  expect(scoped).not.toMatch(/(^|[{}])\s*(:root|html|body)[\s,{:]/)
})
