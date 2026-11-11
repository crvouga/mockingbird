import { expect, test } from "bun:test"
import { emoji, mrkdwn, renderAttachments, renderBlocks, safeUrl } from "./chat.js"

test("mrkdwn draws emphasis, code, links, mentions and emoji", () => {
  expect(mrkdwn("*bold* _it_ ~gone~ `x*y*`")).toContain("<b>bold</b>")
  expect(mrkdwn("*bold* _it_ ~gone~ `x*y*`")).toContain('<code class="chat-code">x*y*</code>')
  expect(mrkdwn("<https://shop.example/o/1|Order 1>")).toContain(
    '<a href="https://shop.example/o/1"',
  )
  expect(mrkdwn("hi <@U1> in <#C1>", { name: (id) => ({ U1: "lin", C1: "alerts" })[id] })).toBe(
    'hi <span class="chat-mention">@lin</span> in <span class="chat-mention">#alerts</span>',
  )
  expect(mrkdwn(":tada:")).toBe(emoji("tada"))
  expect(emoji("no_such_emoji")).toBe(":no_such_emoji:")
})

test("mrkdwn never lets message text become markup", () => {
  const html = mrkdwn('<script>alert(1)</script> <javascript:alert(1)|click> "q"')
  expect(html).not.toContain("<script")
  expect(html).not.toContain('href="javascript')
  expect(safeUrl("javascript:alert(1)")).toBeNull()
  expect(safeUrl("https://shop.example/a")).toBe("https://shop.example/a")
})

test("Block Kit blocks render by type, and unknown ones are named instead of dropped", () => {
  const html = renderBlocks([
    { type: "header", text: { type: "plain_text", text: "Order <1042>" } },
    { type: "section", text: { type: "mrkdwn", text: "*Shipped*" } },
    { type: "divider" },
    {
      type: "actions",
      elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "View" } }],
    },
    { type: "hologram" },
  ])
  expect(html).toContain("Order &#60;1042&#62;")
  expect(html).toContain("<b>Shipped</b>")
  expect(html).toContain('class="chat-btn primary"')
  expect(html).toContain('data-block="divider"')
  expect(html).toContain("hologram")
})

test("attachments keep their color bar, title and fields", () => {
  const html = renderAttachments([
    {
      color: "danger",
      title: "checkout-api",
      text: "Error rate is *high*",
      fields: [{ title: "Region", value: "us-east-1", short: true }],
      footer: "Example Monitoring",
    },
  ])
  expect(html).toContain('style="border-left-color:#e01e5a"')
  expect(html).toContain("checkout-api")
  expect(html).toContain("<b>high</b>")
  expect(html).toContain("Region")
  expect(html).toContain("Example Monitoring")
})

test("block type classes are prefixed, so a host page's own .section or .header cannot restyle them", () => {
  const html = renderBlocks([
    { type: "section", text: { type: "mrkdwn", text: "hello" } },
    { type: "header", text: { type: "plain_text", text: "Title" } },
  ])
  expect(html).toContain('class="chat-block chat-block-section "')
  expect(html).toContain('class="chat-block chat-block-header "')
  expect(html).not.toMatch(/class="[^"]*\s(section|header)[\s"]/)
})
