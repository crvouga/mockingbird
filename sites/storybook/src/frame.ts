/**
 * A browser tab inside a story: an iframe that shows one HTML document the way a browser opens
 * it (its own styles, its own scripts, nothing from the Storybook page around it), grows to the
 * height of what it draws, and, when an emulator runtime backs it, sends that page's form posts,
 * link clicks and `fetch` calls to the runtime instead of the network. So a hosted page can be
 * used end to end in a story: submit the Checkout form, follow a 3-D Secure challenge, decline.
 */

/** Anything with the emulator contract's `fetch` (every service's `createRuntime()`). */
export type Emulator = { fetch(request: Request): Promise<Response> }

export type FrameOptions = {
  /** The address the document believes it was loaded from; relative links resolve against it. */
  url?: string
  /** Answers requests to `url`'s origin: form posts, links, and the page's own `fetch` calls. */
  emulator?: Emulator
  /** Height the tab starts at, before it grows to its content. Default: the canvas height. */
  minHeight?: number
}

type Shim = (init: {
  url: string
  method: string
  headers: [string, string][]
  body: string | null
}) => Promise<Response>

let frames = 0

/** The routes each iframe's fetch shim reaches, keyed by frame. */
const shims = new Map<string, Shim>()
Object.assign(globalThis, { __mockingbirdFetch: shims })

/**
 * Prepended to every document: routes the page's `fetch` to the emulator when it targets the
 * emulator's origin. It runs before the page's own scripts, as the first thing in the document.
 */
const shimScript = (id: string, origin: string) => `<script>(function(){
var ORIGIN=${JSON.stringify(origin)},ID=${JSON.stringify(id)},real=window.fetch.bind(window);
window.fetch=function(input,init){
  var request=new Request(input,init);
  if(request.url.indexOf(ORIGIN)!==0)return real(input,init);
  return request.text().then(function(body){
    var headers=[];request.headers.forEach(function(v,k){headers.push([k,v])});
    return window.parent.__mockingbirdFetch.get(ID)({url:request.url,method:request.method,headers:headers,body:request.method==="GET"||request.method==="HEAD"?null:body});
  });
};})();</script>`

const withShim = (html: string, id: string, origin: string) => {
  const script = shimScript(id, origin)
  const head = html.match(/<head[^>]*>/i)
  if (head?.index !== undefined) {
    const at = head.index + head[0].length
    return html.slice(0, at) + script + html.slice(at)
  }
  return script + html
}

/** A page for a navigation that leaves the emulator: the story stops where the browser would. */
const departure = (url: string, status?: number) => `<!doctype html><meta charset="utf-8">
<style>body{font:15px/1.5 system-ui,sans-serif;color:#30313d;display:grid;place-items:center;padding:64px 16px;margin:0;background:#f6f8fa}
main{max-width:520px;padding:32px;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08)}
code{word-break:break-all;color:#635bff}</style>
<main data-testid="storybook-departure"><strong>The page sent the browser on${status ? ` (${status})` : ""} to</strong><p><code>${url.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</code></p>
<p>That address is outside this emulator, so the story stops here.</p></main>`

/**
 * An iframe showing `html`. With an emulator, everything the page does goes through it: a
 * submitted form is posted to the runtime and the iframe shows the answer (following redirects
 * that stay on the emulator), and so does a followed link.
 */
export function frame(html: string, options: FrameOptions = {}): HTMLIFrameElement {
  frames += 1
  const id = `frame-${frames}`
  const iframe = document.createElement("iframe")
  iframe.title = "Rendered page"
  iframe.dataset.storybookFrame = id
  // The tab starts as tall as the canvas, like a browser window, and grows to fit longer pages.
  const start = options.minHeight ?? Math.max(window.innerHeight, 320)
  iframe.style.cssText = `display:block;width:100%;border:0;height:${start}px;background:transparent`
  let current = options.url ?? "about:srcdoc"
  const origin = options.url ? new URL(options.url).origin : undefined
  const emulator = options.emulator

  const show = (document: string, url: string) => {
    current = url
    iframe.srcdoc = emulator && origin ? withShim(document, id, origin) : document
  }

  const navigate = async (url: string, init: RequestInit = {}): Promise<void> => {
    if (!emulator || !origin || new URL(url).origin !== origin) return show(departure(url), url)
    const response = await emulator.fetch(new Request(url, { ...init, redirect: "manual" }))
    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location)
      return navigate(new URL(location, url).href)
    const type = response.headers.get("content-type") ?? ""
    const text = await response.text()
    show(
      type.includes("html")
        ? text
        : `<pre style="white-space:pre-wrap;padding:16px">${text.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"))}</pre>`,
      url,
    )
  }

  if (emulator && origin) {
    shims.set(id, async ({ url, method, headers, body }) =>
      emulator.fetch(new Request(url, { method, headers, ...(body === null ? {} : { body }) })),
    )
  }

  iframe.addEventListener("load", () => {
    const doc = iframe.contentDocument
    if (!doc) return
    // Measured from where the content ends, not the document's scroll height: a page styled
    // `min-height: 100vh` plus a margin is always taller than its frame, and would grow forever.
    const grow = () => {
      const view = doc.defaultView
      let bottom = 0
      for (const child of Array.from(doc.body?.children ?? []))
        bottom = Math.max(bottom, child.getBoundingClientRect().bottom + (view?.scrollY ?? 0))
      const style = doc.body && view ? view.getComputedStyle(doc.body) : undefined
      const end =
        bottom +
        Number.parseFloat(style?.paddingBottom ?? "0") +
        Number.parseFloat(style?.marginBottom ?? "0")
      iframe.style.height = `${Math.ceil(Math.max(start, end))}px`
    }
    grow()
    if (doc.body) new ResizeObserver(grow).observe(doc.body)
    if (!emulator) return
    // Bubble phase on the document: the page's own handlers (validation, "processing") run first,
    // and a submit they cancelled stays cancelled.
    doc.addEventListener("submit", (event) => {
      if (event.defaultPrevented) return
      event.preventDefault()
      const form = event.target as HTMLFormElement
      const submitter = (event as SubmitEvent).submitter
      const data = new FormData(form, submitter)
      const method = (
        submitter?.getAttribute("formmethod") ??
        form.getAttribute("method") ??
        "get"
      ).toUpperCase()
      const action = new URL(
        submitter?.getAttribute("formaction") ?? form.getAttribute("action") ?? current,
        current,
      )
      const body = new URLSearchParams([...data].map(([key, value]) => [key, String(value)]))
      if (method === "GET") {
        action.search = body.toString()
        void navigate(action.href)
      } else {
        void navigate(action.href, {
          method,
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        })
      }
    })
    doc.addEventListener("click", (event) => {
      if (event.defaultPrevented) return
      const link = (event.target as Element).closest?.("a[href]")
      if (!link) return
      const href = link.getAttribute("href") ?? ""
      if (href.startsWith("#") || href.startsWith("javascript:")) return
      event.preventDefault()
      void navigate(new URL(href, current).href)
    })
  })

  show(html, current)
  return iframe
}

/** The document an iframe drawn by `frame` currently shows, once it has loaded. */
export async function frameDocument(canvas: HTMLElement): Promise<Document> {
  const iframe = canvas.querySelector<HTMLIFrameElement>("iframe[data-storybook-frame]")
  if (!iframe) throw new Error("The story drew no frame")
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const doc = iframe.contentDocument
    if (doc && doc.readyState === "complete" && doc.body?.childElementCount) return doc
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error("The frame never finished loading")
}
