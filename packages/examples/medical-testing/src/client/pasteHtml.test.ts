import { describe, expect, test } from "bun:test"
import { scopeEmbeddedCss } from "./pasteHtml.js"

describe("scopeEmbeddedCss", () => {
  test("rewrites document selectors onto .page and keeps at-rules intact", () => {
    const css = scopeEmbeddedCss(`
*{box-sizing:border-box}body{margin:0;min-height:100svh}h1{font-size:24px}
@media(prefers-color-scheme:dark){:root{--bg:#111}}
@keyframes arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1}}
/* Fill the viewport, then grow with the content so the background covers the scroll. */
html { height: 100%; }
html, body { height: 100%; }
:root[data-theme="dark"]{color:red}
.app{min-height:100vh}
.card{min-height:100dvh}.tall{min-height:100lvh}
.pane{height:100%}
.body{color:blue}
`)
    expect(css).toContain(
      '[data-mockingbird-paste="test"]{display:block;box-sizing:border-box;width:100%;max-width:100%;min-width:0}',
    )
    expect(css).toContain(
      '[data-mockingbird-paste="test"]>.page{box-sizing:border-box;width:100%;max-width:100%;min-width:0;min-height:100%;container-type:inline-size}',
    )
    expect(css).toContain('[data-mockingbird-paste="test"]>.page{margin:0;min-height:100%}')
    expect(css).toContain('[data-mockingbird-paste="test"]>.page h1{font-size:24px}')
    expect(css).toContain(
      '@media(prefers-color-scheme:dark){[data-mockingbird-paste="test"]>.page{--bg:#111}}',
    )
    expect(css).toContain(
      "@keyframes arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1}}",
    )
    expect(css).toContain('[data-mockingbird-paste="test"]>.page {min-height: 100%; }')
    expect(css).toContain(
      '[data-mockingbird-paste="test"]>.page, [data-mockingbird-paste="test"]>.page {min-height: 100%; }',
    )
    expect(css).toContain('[data-mockingbird-paste="test"]>.page[data-theme="dark"]{color:red}')
    expect(css).toContain('[data-mockingbird-paste="test"]>.page .app{min-height:100%}')
    expect(css).toContain('[data-mockingbird-paste="test"]>.page .pane{height:100%}')
    expect(css.match(/(?<![\w-])height:\s*100%/g)).toEqual(["height:100%"])
    expect(css).toContain('[data-mockingbird-paste="test"]>.page .body{color:blue}')
    expect(css).not.toContain(":root")
    expect(css).not.toContain("100vh")
    expect(css).not.toContain("100svh")
    expect(css).not.toContain("100dvh")
    expect(css).not.toContain("100lvh")
    expect(css).toContain('[data-mockingbird-paste="test"]>.page .card{min-height:100%}')
  })

  test("width breakpoints follow the pasted box, not the browser window", () => {
    const css = scopeEmbeddedCss(`
@media (min-width:992px){.app{flex-direction:row}}
@media (max-width: 640px){.nav{flex-wrap:wrap}}
@media screen and (max-width:800px){.layout{display:block}}
@media (min-width:600px) and (max-width:900px){.split{display:block}}
@media (prefers-color-scheme:dark){:root{--bg:#111}}
@media (min-width:700px) and (prefers-reduced-motion:reduce){.card{animation:none}}
`)
    expect(css).toContain(
      '@container (min-width:992px){[data-mockingbird-paste="test"]>.page .app{flex-direction:row}}',
    )
    expect(css).toContain(
      '@container (max-width: 640px){[data-mockingbird-paste="test"]>.page .nav{flex-wrap:wrap}}',
    )
    expect(css).toContain(
      '@container (max-width:800px){[data-mockingbird-paste="test"]>.page .layout{display:block}}',
    )
    expect(css).toContain(
      '@container (min-width:600px) and (max-width:900px){[data-mockingbird-paste="test"]>.page .split{display:block}}',
    )
    expect(css).toContain(
      '@media (prefers-color-scheme:dark){[data-mockingbird-paste="test"]>.page{--bg:#111}}',
    )
    expect(css).toContain("@media (min-width:700px) and (prefers-reduced-motion:reduce)")
    expect(css).not.toContain("@media (min-width:992px)")
    expect(css).not.toContain("@media (max-width: 640px)")
  })

  test("keeps functional selector lists intact while scoping them", () => {
    const css = scopeEmbeddedCss(
      ':is(a,button,input,[tabindex="0"]):focus-visible{outline:2px solid} .card, main{padding:1rem}',
    )
    expect(css).toContain(
      '[data-mockingbird-paste="test"]>.page :is(a,button,input,[tabindex="0"]):focus-visible{outline:2px solid}',
    )
    expect(css).toContain(
      '[data-mockingbird-paste="test"]>.page .card, [data-mockingbird-paste="test"]>.page main{padding:1rem}',
    )
  })
})
