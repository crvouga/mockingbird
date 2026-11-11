/**
 * Starts the landing page's notifications demo (`components/landing/NotificationsDemo.astro`) when
 * its section nears the viewport. Only this file is in the page's first load; the emulators, the
 * harness and its UI arrive with the dynamic import.
 */
const root = document.querySelector<HTMLElement>("[data-notifications-demo]")

if (root) {
  let dispose: (() => void) | undefined
  let started = false

  const start = async () => {
    if (started) return
    started = true
    root.dataset.state = "loading"
    try {
      const { mountNotificationsDemo } = await import("./notificationsDemo/mount.ts")
      dispose = await mountNotificationsDemo(root)
    } catch (error) {
      root.dataset.state = "error"
      console.error("notifications demo failed to start", error)
    }
  }

  // The emulators are a couple of megabytes. A visitor who asked their browser to save data gets
  // the still outline and a button instead of a download they did not ask for.
  const saveData =
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
  const startButton = root.querySelector<HTMLButtonElement>("[data-demo-start]")

  if (saveData && startButton) {
    root.dataset.state = "manual"
    startButton.addEventListener("click", () => void start(), { once: true })
  } else if (typeof IntersectionObserver !== "function") void start()
  else {
    const near = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        near.disconnect()
        void start()
      },
      { rootMargin: "800px 0px" },
    )
    near.observe(root)
  }

  // A page kept in the back/forward cache comes back as it was, so only a real unload tears down.
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) dispose?.()
  })
}
