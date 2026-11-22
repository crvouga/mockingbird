import { Display, Moon, Sun } from "@gravity-ui/icons"
import { ToggleButton, ToggleButtonGroup, useIsHydrated } from "@heroui/react"
import { useCallback, useEffect, useState } from "react"
import { applyStoredTheme, THEME_STORAGE_KEY } from "../theme-preference.js"
import type { MockingbirdTheme } from "./provider.js"

const read = (): MockingbirdTheme => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === "light" || stored === "dark" ? stored : "system"
  } catch {
    return "system"
  }
}

/**
 * The visitor's light, dark or system choice, shared with the docs site (`mb:theme` in
 * localStorage, so one choice holds on every Mockingbird page of an origin) and applied to
 * `<html>` as `data-theme` and a class, which HeroUI and the Mockingbird tokens both read.
 */
export function useMockingbirdTheme(): [MockingbirdTheme, (theme: MockingbirdTheme) => void] {
  const [theme, setThemeState] = useState<MockingbirdTheme>("system")
  useEffect(() => setThemeState(read()), [])
  const setTheme = useCallback((next: MockingbirdTheme) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY)
      else localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Storage can be blocked (private windows, sandboxed frames); the choice then lasts this page.
    }
    applyStoredTheme(document.documentElement, next)
    setThemeState(next)
  }, [])
  return [theme, setTheme]
}

const OPTIONS = [
  { id: "light", label: "Light theme", Icon: Sun },
  { id: "dark", label: "Dark theme", Icon: Moon },
  { id: "system", label: "System theme", Icon: Display },
] as const

/** Light / dark / system, for the `actions` slot of `AppShell`. Renders nothing without JavaScript. */
export function ThemeSwitch() {
  const hydrated = useIsHydrated()
  const [theme, setTheme] = useMockingbirdTheme()
  if (!hydrated) return null
  return (
    <ToggleButtonGroup
      aria-label="Theme"
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[theme]}
      onSelectionChange={(keys) => {
        const [next] = [...keys]
        if (next === "light" || next === "dark" || next === "system") setTheme(next)
      }}
    >
      {OPTIONS.map(({ id, label, Icon }) => (
        <ToggleButton key={id} id={id} isIconOnly aria-label={label}>
          <Icon className="size-4" />
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}
