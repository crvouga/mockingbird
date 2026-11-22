import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  FRAME_PATHS_KEY,
  type FrameMountOptions,
  mountFrame,
  readFramePath,
  writeFramePath,
} from "./src/system-frame.js"

const memory = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

/** A same-origin frame document: its location, and the Navigation API when `navigation`. */
class FakeWindow extends EventTarget {
  location: { href: string; protocol: string; pathname: string; search: string; hash: string }
  navigation?: EventTarget
  constructor(href: string, navigation: boolean) {
    super()
    this.location = FakeWindow.at(href)
    if (navigation) this.navigation = new EventTarget()
  }
  static at(href: string) {
    const url = new URL(href)
    return {
      href,
      protocol: url.protocol,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    }
  }
  /** `pushState` or a hash change inside the frame. */
  go(href: string, event: "currententrychange" | "popstate" | "hashchange") {
    this.location = FakeWindow.at(href)
    const target = event === "currententrychange" ? this.navigation : this
    target?.dispatchEvent(new Event(event))
  }
}

/** The bits of an `<iframe>` the harness uses. */
class FakeFrame extends EventTarget {
  src = ""
  name = ""
  title = ""
  allow?: string
  dataset: Record<string, string> = {}
  style = { cssText: "" }
  contentWindow: FakeWindow | undefined
  removed = false
  constructor(private navigation: boolean) {
    super()
    this.contentWindow = new FakeWindow("about:blank", navigation)
  }
  setAttribute(name: string, value: string) {
    if (name === "allow") this.allow = value
  }
  remove() {
    this.removed = true
  }
  /** The browser loads `src` (or another page): a new document, then `load`. */
  load(href = new URL(this.src, "https://shell.test/").href) {
    this.contentWindow = new FakeWindow(href, this.navigation)
    this.dispatchEvent(new Event("load"))
  }
}

const setup = (navigation = true) => {
  let frame: FakeFrame | undefined
  const appended: unknown[] = []
  const content = {
    ownerDocument: {
      createElement: () => {
        frame = new FakeFrame(navigation)
        return frame
      },
    },
    append: (node: unknown) => void appended.push(node),
  } as unknown as HTMLElement
  return {
    content,
    appended,
    frame: () => {
      if (!frame) throw new Error("no frame yet")
      return frame
    },
  }
}

const options = (
  overrides: Partial<FrameMountOptions> & { store?: ReturnType<typeof memory> } = {},
): FrameMountOptions & { seen: Location[]; attached: unknown[] } => {
  const { store = memory(), ...rest } = overrides
  const seen: Location[] = []
  const attached: unknown[] = []
  return {
    id: "orders",
    label: "Orders",
    frame: { src: "/frames/orders/" },
    storage: () => store,
    timeoutMs: 1_000,
    ...rest,
    seen,
    attached,
    navigated: (location) => void seen.push(location),
    attach: (element) => void attached.push(element),
  }
}

let intervals = 0
const realSetInterval = globalThis.setInterval
beforeEach(() => {
  intervals = 0
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    intervals++
    return realSetInterval(...args)
  }) as typeof setInterval
})
afterEach(() => {
  globalThis.setInterval = realSetInterval
})

describe("frame paths", () => {
  test("are kept per surface in the harness's storage, and junk reads as none", () => {
    const store = memory()
    expect(readFramePath(store, "a")).toBeUndefined()
    writeFramePath(store, "a", "/a/orders/7")
    writeFramePath(store, "b", "/b/#/cart")
    expect(readFramePath(store, "a")).toBe("/a/orders/7")
    expect(readFramePath(store, "b")).toBe("/b/#/cart")
    expect(JSON.parse(store.values.get(FRAME_PATHS_KEY) ?? "")).toEqual({
      a: "/a/orders/7",
      b: "/b/#/cart",
    })
    expect(readFramePath(memory({ [FRAME_PATHS_KEY]: "not json" }), "a")).toBeUndefined()
    expect(readFramePath(memory({ [FRAME_PATHS_KEY]: '["a"]' }), "0")).toBeUndefined()
    expect(readFramePath(memory({ [FRAME_PATHS_KEY]: '{"a":7}' }), "a")).toBeUndefined()
    // A store that refuses is ignored.
    writeFramePath(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota")
        },
      },
      "a",
      "/x",
    )
  })
})

describe("mountFrame", () => {
  test("creates the iframe, resolves on its first real load, and removes it on dispose", async () => {
    const dom = setup()
    const opts = options({ frame: { src: "/frames/orders/", name: "orders", allow: "camera" } })
    const mounting = mountFrame(dom.content, new AbortController().signal, opts)
    const frame = dom.frame()
    expect(dom.appended).toEqual([frame])
    expect(opts.attached).toEqual([frame])
    expect(frame.src).toBe("/frames/orders/")
    expect(frame.name).toBe("orders")
    expect(frame.allow).toBe("camera")
    expect(frame.title).toBe("Orders")
    expect(frame.dataset.surface).toBe("orders")
    // The initial about:blank document is not the page.
    frame.dispatchEvent(new Event("load"))
    let settled = false
    void mounting.then(() => {
      settled = true
    })
    await Bun.sleep(1)
    expect(settled).toBe(false)
    frame.load()
    const dispose = await mounting
    expect(frame.removed).toBe(false)
    dispose()
    expect(frame.removed).toBe(true)
    expect(opts.attached).toEqual([frame, undefined])
  })

  test("reopens the last kept path, and keeps each navigation's path without polling", async () => {
    const store = memory({
      [FRAME_PATHS_KEY]: JSON.stringify({ orders: "/frames/orders/7?tab=items" }),
    })
    const dom = setup(true)
    const seen: (string | undefined)[] = []
    const opts = options({
      store,
      frame: {
        src: (last) => {
          seen.push(last)
          return last ?? "/frames/orders/"
        },
      },
    })
    const mounting = mountFrame(dom.content, new AbortController().signal, opts)
    const frame = dom.frame()
    expect(seen).toEqual(["/frames/orders/7?tab=items"])
    expect(frame.src).toBe("/frames/orders/7?tab=items")
    frame.load()
    await mounting
    expect(opts.seen.map((location) => location.pathname)).toEqual(["/frames/orders/7"])

    // pushState inside the page: the Navigation API says so, not a timer.
    frame.contentWindow?.go("https://shell.test/frames/orders/8#notes", "currententrychange")
    expect(readFramePath(store, "orders")).toBe("/frames/orders/8#notes")
    expect(opts.seen).toHaveLength(2)
    // With the Navigation API there, popstate is not listened to as well (no double reports).
    frame.contentWindow?.dispatchEvent(new Event("popstate"))
    expect(opts.seen).toHaveLength(2)

    // A full navigation is a new document: followed from its load.
    frame.load("https://shell.test/frames/orders/9")
    expect(readFramePath(store, "orders")).toBe("/frames/orders/9")
    frame.contentWindow?.go("https://shell.test/frames/orders/10", "currententrychange")
    expect(readFramePath(store, "orders")).toBe("/frames/orders/10")
    expect(intervals).toBe(0)
  })

  test("without the Navigation API, follows popstate and hashchange", async () => {
    const store = memory()
    const dom = setup(false)
    const opts = options({ store })
    const mounting = mountFrame(dom.content, new AbortController().signal, opts)
    dom.frame().load("https://shell.test/frames/orders/")
    const dispose = await mounting
    const inner = dom.frame().contentWindow as FakeWindow
    inner.go("https://shell.test/frames/orders/#/7", "hashchange")
    expect(readFramePath(store, "orders")).toBe("/frames/orders/#/7")
    inner.go("https://shell.test/frames/orders/", "popstate")
    expect(readFramePath(store, "orders")).toBe("/frames/orders/")
    expect(opts.seen).toHaveLength(3)
    // Disposed: the page's later navigations no longer reach the shell.
    dispose()
    inner.go("https://shell.test/frames/orders/#/8", "hashchange")
    expect(opts.seen).toHaveLength(3)
    expect(intervals).toBe(0)
  })

  test("a cross-origin page counts as loaded, and is not followed", async () => {
    const dom = setup()
    const opts = options()
    const mounting = mountFrame(dom.content, new AbortController().signal, opts)
    const frame = dom.frame()
    Object.defineProperty(frame, "contentWindow", {
      get: () => ({
        get location(): never {
          throw new Error("SecurityError")
        },
      }),
    })
    frame.dispatchEvent(new Event("load"))
    await mounting
    expect(opts.seen).toHaveLength(0)
  })

  test("waits for `ready`, and a rejection removes the frame and rejects", async () => {
    const dom = setup()
    let resolve!: () => void
    const signals: AbortSignal[] = []
    const opts = options({
      frame: {
        src: "/frames/orders/",
        ready: (_frame, signal) => {
          signals.push(signal)
          return new Promise((done) => {
            resolve = done
          })
        },
      },
    })
    const mounting = mountFrame(dom.content, new AbortController().signal, opts)
    dom.frame().load()
    let settled = false
    void mounting.then(() => {
      settled = true
    })
    await Bun.sleep(1)
    expect(settled).toBe(false)
    resolve()
    await mounting
    expect(signals[0]?.aborted).toBe(false)

    const failing = setup()
    const rejected = options({
      frame: { src: "/x", ready: () => Promise.reject(new Error("the app crashed")) },
    })
    await expect(
      mountFrame(failing.content, new AbortController().signal, rejected),
    ).rejects.toThrow("the app crashed")
    expect(failing.frame().removed).toBe(true)
    expect(rejected.attached).toEqual([failing.frame(), undefined])
  })

  test("a page that never becomes ready fails after the timeout, and its ready signal aborts", async () => {
    const dom = setup()
    let readySignal: AbortSignal | undefined
    const opts = options({
      timeoutMs: 20,
      frame: {
        src: "/frames/orders/",
        ready: (_frame, signal) => {
          readySignal = signal
          return new Promise(() => {})
        },
      },
    })
    await expect(mountFrame(dom.content, new AbortController().signal, opts)).rejects.toThrow(
      "Orders did not become ready within 20 ms",
    )
    expect(readySignal?.aborted).toBe(true)
    expect(dom.frame().removed).toBe(true)
  })

  test("an abort while loading removes the frame and rejects", async () => {
    const dom = setup()
    const abort = new AbortController()
    const opts = options()
    const mounting = mountFrame(dom.content, abort.signal, opts)
    abort.abort(new Error("removed"))
    await expect(mounting).rejects.toThrow("removed")
    expect(dom.frame().removed).toBe(true)
    // Already aborted: no frame is made.
    const late = setup()
    await expect(mountFrame(late.content, abort.signal, options())).rejects.toThrow("removed")
    expect(late.appended).toEqual([])
  })
})
