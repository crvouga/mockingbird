import { useEffect, useRef } from "preact/hooks"

/**
 * Closes a modal on Escape and claims the key with `preventDefault()`, so a
 * surrounding modal (the docs site's example window, or anything else that
 * embeds this app) treats the close request as handled and stays open.
 */
export const useEscapeKey = (onEscape: () => void): void => {
  const latest = useRef(onEscape)
  latest.current = onEscape
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      latest.current()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])
}
