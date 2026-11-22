import { Tabs } from "@heroui/react"
import { useEffect, useState } from "react"
import { KEYS, store } from "../client/storage.ts"
import { PACKAGE_MANAGERS } from "../lib/format.ts"
import { CopyButton } from "./code.tsx"
import { CODE_BODY_CLASS, CODE_FRAME_CLASS } from "./code-frame.ts"

type PackageManager = (typeof PACKAGE_MANAGERS)[number]

export type InstallCommand = { pm: PackageManager; command: string; html: string }

const CHANGE = "mb:pm-change"
const isPm = (value: unknown): value is PackageManager =>
  (PACKAGE_MANAGERS as readonly unknown[]).includes(value)

/**
 * The install command for each package manager, in HeroUI Tabs. One choice applies to every
 * install block on the page and is remembered (`mb:pm`). Hydrate it (`client:visible`); without
 * JavaScript it shows npm.
 */
export function Install({ commands }: { commands: InstallCommand[] }) {
  const [pm, setPm] = useState<PackageManager>("npm")
  useEffect(() => {
    const stored = store.get(KEYS.packageManager)
    if (isPm(stored)) setPm(stored)
    const follow = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail
      if (isPm(next)) setPm(next)
    }
    addEventListener(CHANGE, follow)
    return () => removeEventListener(CHANGE, follow)
  }, [])
  const choose = (next: PackageManager) => {
    setPm(next)
    store.set(KEYS.packageManager, next)
    dispatchEvent(new CustomEvent(CHANGE, { detail: next }))
  }
  return (
    <div className={`${CODE_FRAME_CLASS} my-0`} data-install>
      <Tabs
        variant="secondary"
        selectedKey={pm}
        onSelectionChange={(key) => {
          if (isPm(key)) choose(key)
        }}
      >
        <Tabs.ListContainer className="border-b border-separator bg-transparent">
          <Tabs.List aria-label="Package manager" className="min-w-0!">
            {commands.map(({ pm: id }) => (
              <Tabs.Tab key={id} id={id} className="font-mono text-xs" data-pm={id}>
                {id}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        {commands.map(({ pm: id, command, html }) => (
          <Tabs.Panel key={id} id={id} className="p-0" data-pm-panel={id}>
            <div className="flex items-center gap-1 pr-1" data-copy-scope>
              <span
                aria-hidden="true"
                className="pl-3 font-mono text-[13px] text-muted select-none"
              >
                $
              </span>
              <div
                className={`min-w-0 flex-1 [&_pre]:pl-2! ${CODE_BODY_CLASS}`}
                dangerouslySetInnerHTML={{ __html: html }}
              />
              <CopyButton copy={command} label="Copy command" />
            </div>
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  )
}
