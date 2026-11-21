/**
 * Landing figure: the notifications harness's own UI, live. `client/notificationsIsland.ts` loads
 * `client/notificationsDemo/mount.ts` when this nears the viewport; that boots the Twilio, Resend,
 * FCM and Slack emulators in the tab and mounts the UI into `[data-demo-host]`. Until then, and
 * without JavaScript, the stage shows a still outline of the four devices at the height the UI
 * will take (`client/notificationsDemo/layout.ts` has the same numbers), so nothing moves.
 *
 * Server-rendered only: the scripts drive it through its `data-*` hooks, and its buttons are
 * native buttons with HeroUI's Button classes (which honor `:disabled`).
 */
import { buttonVariants, Card, Link } from "@heroui/react"
import type { ReactNode } from "react"
import { Icon, type IconName } from "../icon.tsx"

const ACTIONS: { action: string; icon: IconName; label: string }[] = [
  { action: "code", icon: "message", label: "Send sign-in code" },
  { action: "email", icon: "mail", label: "Email a receipt" },
  { action: "push", icon: "bell", label: "Send a push" },
  { action: "chat", icon: "activity", label: "Post a Slack alert" },
  { action: "whatsapp", icon: "message", label: "WhatsApp update" },
]

const button = (variant: "primary" | "secondary" | "ghost") =>
  `${buttonVariants({ variant, size: "sm" })} @max-[519px]:flex-auto`

/** A line of the stage's status that shows only in one state of the demo. */
function When({ state, children }: { state: string; children: ReactNode }) {
  const show = {
    idle: "group-data-[state=idle]/demo:inline",
    manual: "group-data-[state=manual]/demo:inline",
    loading: "group-data-[state=loading]/demo:inline",
    error: "group-data-[state=error]/demo:inline",
  }[state]
  return (
    <span className={`hidden ${show}`} data-when={state}>
      {children}
    </span>
  )
}

/*
 * The stage is dark in both themes, because it imitates the harness page, which is: the outline
 * stands in for its devices until they mount, so it takes the harness's own colors.
 */
const STAGE = "bg-[#0e1015] text-[#9aa1b1]"
const DEVICE =
  "border border-[#2a2f3a] bg-[#161920] group-data-[state=loading]/demo:motion-safe:animate-pulse"

export function NotificationsDemo() {
  return (
    <div
      className="group/demo @container mb-4"
      data-notifications-demo
      data-state="idle"
      data-autoplay="off"
    >
      <Card className="gap-0 overflow-hidden p-0">
        <fieldset
          className="flex flex-wrap items-center gap-2 border-b border-separator bg-surface-secondary px-3.5 py-3"
          aria-label="Send a notification through an emulator"
        >
          {ACTIONS.map((item) => (
            <button
              key={item.action}
              type="button"
              className={button("secondary")}
              data-demo-action={item.action}
              disabled
            >
              <Icon name={item.icon} className="size-4 text-accent" /> {item.label}
            </button>
          ))}
          <span className="ml-auto flex flex-wrap items-center gap-2 @max-[1039px]:ml-0 @max-[519px]:basis-full">
            <button
              type="button"
              className={button("primary")}
              data-demo-action="checkout"
              disabled
            >
              <Icon name="play" /> Run a checkout
            </button>
            {/* Nothing plays by itself with reduced motion, so there is nothing to pause. */}
            <button
              type="button"
              className={`${button("ghost")} group/auto motion-reduce:hidden`}
              data-demo-autoplay
              aria-pressed="true"
              disabled
            >
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-success group-aria-[pressed=false]/auto:bg-muted group-data-[autoplay=paused]/demo:opacity-60 group-data-[autoplay=playing]/demo:motion-safe:animate-pulse"
              />
              <span data-demo-autoplay-label>Pause autoplay</span>
            </button>
            <button type="button" className={button("ghost")} data-demo-action="reset" disabled>
              <Icon name="reset" /> Reset
            </button>
          </span>
        </fieldset>
        <div
          className="flex min-h-11 items-center gap-2.5 overflow-hidden border-b border-separator px-3.5 py-2 text-xs"
          data-demo-call
          role="status"
          aria-live="polite"
        >
          <span className="text-muted">
            Each button makes one call to an emulator's vendor API. The request shows here.
          </span>
        </div>
        <div
          className={`relative h-[calc(44px+53.75cqw)] overflow-hidden @max-[1039px]:h-[750px] @max-[519px]:h-[680px] ${STAGE}`}
          data-demo-stage
        >
          <div className="h-full" data-demo-host>
            <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
              <div
                aria-hidden="true"
                className="flex h-[62%] max-h-[520px] w-full items-stretch justify-center gap-[1.7cqw] @max-[1039px]:h-[70%] @max-[1039px]:max-h-none @max-[1039px]:max-w-[290px]"
              >
                <span
                  className={`flex-[0_0_21.6cqw] rounded-[2.8cqw] @max-[1039px]:flex-auto @max-[1039px]:rounded-[38px] ${DEVICE}`}
                />
                <span
                  className={`flex-[0_0_21.6cqw] rounded-[2.8cqw] @max-[1039px]:hidden ${DEVICE}`}
                />
                <span className={`flex-[3_1_0] rounded-[10px] @max-[1039px]:hidden ${DEVICE}`} />
                <span className={`flex-[2_1_0] rounded-[10px] @max-[1039px]:hidden ${DEVICE}`} />
              </div>
              <p className="max-w-[60ch] text-center text-[13px] [&_a]:text-[#6cb6ff] [&_a]:underline">
                <When state="idle">The live devices start when this section is on screen.</When>
                <When state="manual">
                  The live devices download about 2 MB of emulators.{" "}
                  <button type="button" className={`${button("secondary")} ml-2`} data-demo-start>
                    Start the live demo
                  </button>
                </When>
                <When state="loading">
                  Starting the Twilio, Resend, FCM and Slack emulators in this tab…
                </When>
                <When state="error">
                  The live demo could not start in this browser.{" "}
                  <a href="/examples/medical-testing">Open the example</a> or read the{" "}
                  <a href="/docs/notifications">notifications guide</a>.
                </When>
              </p>
              <noscript>
                <p className="max-w-[60ch] text-center text-[13px] [&_a]:text-[#6cb6ff] [&_a]:underline">
                  The live devices need JavaScript: the emulators run in your browser. The{" "}
                  <a href="/docs/notifications">notifications guide</a> has screenshots.
                </p>
              </noscript>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-separator px-3.5 py-3 text-xs text-muted">
          <p className="flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" /> The
            harness's own UI, reading four emulators that run in this tab. Nothing leaves the page.
          </p>
          <p className="flex flex-wrap items-center gap-2">
            With a fleet it is one flag:{" "}
            <code className="font-mono text-[11.5px] text-foreground">
              mockingbird-fleet serve --config mockingbird.json --dashboard
            </code>
            <Link href="/docs/notifications" className="gap-1.5 text-xs whitespace-nowrap">
              Notifications guide <Icon name="arrow-right" className="size-3.5" />
            </Link>
          </p>
        </div>
      </Card>
    </div>
  )
}
