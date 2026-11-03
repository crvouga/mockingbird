import { expect, test } from "bun:test"
import { mount } from "./src/index.js"

const page = async (html: string, contentType = "text/html") => {
  const handler = mount(
    { fetch: async () => new Response(html, { headers: { "content-type": contentType } }) },
    "/mock/google",
  )
  return (await handler.GET(new Request("https://app.example.test/mock/google"))).text()
}

// RFC 9110 §8.3.1: media types are case-insensitive.
test.each(["Text/HTML", "TEXT/HTML; charset=UTF-8", "text/html ; charset=utf-8"])(
  "mount rewrites links in %s",
  async (contentType) => {
    expect(await page('<a href="/next">next</a>', contentType)).toBe(
      '<a href="/mock/google/next">next</a>',
    )
  },
)

test("mount rewrites formaction", async () => {
  expect(await page('<button formaction="/approve">ok</button>')).toBe(
    '<button formaction="/mock/google/approve">ok</button>',
  )
})

test("mount rewrites every local srcset candidate and leaves external ones", async () => {
  expect(
    await page(
      '<img srcset="/a.png 1x, /b.png 2x,https://cdn.example.test/c.png 3x" src="/a.png">',
    ),
  ).toBe(
    '<img srcset="/mock/google/a.png 1x, /mock/google/b.png 2x,https://cdn.example.test/c.png 3x" src="/mock/google/a.png">',
  )
})

test("mount rewrites a meta refresh target", async () => {
  expect(await page('<meta http-equiv="refresh" content="0;url=/signed-in">')).toBe(
    '<meta http-equiv="refresh" content="0;url=/mock/google/signed-in">',
  )
  expect(await page("<META CONTENT='5; URL=/later' HTTP-EQUIV='Refresh'>")).toBe(
    "<META CONTENT='5; URL=/mock/google/later' HTTP-EQUIV='Refresh'>",
  )
  expect(await page('<meta http-equiv="refresh" content="0; url=\'/quoted\'">')).toBe(
    '<meta http-equiv="refresh" content="0; url=\'/mock/google/quoted\'">',
  )
  // Not a refresh: content is left alone.
  expect(await page('<meta name="x" content="0;url=/other">')).toBe(
    '<meta name="x" content="0;url=/other">',
  )
})
