/**
 * Landing figure: one test suite, run twice. Before, each test calls a vendor's live sandbox,
 * so the suite crawls through them one at a time and some of them fail. After, the same tests
 * call emulators in the same process and all of them pass at once.
 *
 * Both cards are the same markup over different data. The page renders each run finished;
 * `before-after.client.ts` replays them side by side from the same data when the figure is on
 * screen, by setting the `data-state` every style below reads.
 */
import { StatusChip } from "@crvouga/mockingbird-ui/react"
import { Card } from "@heroui/react"
import {
  type Attempt,
  formatDuration,
  noteOf,
  type Outcome,
  outcomeOf,
  summarize,
} from "../../lib/test-run.ts"
import { Icon } from "../icon.tsx"
import { VendorLogo } from "./vendor-logo.tsx"

/**
 * Each test, the service it calls, what the call costs against the live sandbox, and the
 * milliseconds it takes against an emulator. Illustrative, not measured.
 */
const TESTS: { service: string; name: string; live: Attempt[]; local: number }[] = [
  {
    service: "stripe",
    name: "charges the card",
    live: [{ shown: 480, play: 900, end: "passed" }],
    local: 2,
  },
  {
    service: "twilio",
    name: "texts the receipt",
    live: [{ shown: 1200, play: 1200, end: "passed" }],
    local: 1,
  },
  {
    service: "openai",
    name: "summarizes the order",
    live: [{ shown: 6400, play: 2200, end: "passed" }],
    local: 3,
  },
  {
    service: "slack",
    name: "posts to #orders",
    live: [
      { shown: 900, play: 900, end: "failed", note: "429" },
      { shown: 2000, play: 1300, end: "passed" },
    ],
    local: 1,
  },
  {
    service: "resend",
    name: "emails the invoice",
    live: [{ shown: 730, play: 900, end: "passed" }],
    local: 2,
  },
  {
    service: "s3",
    name: "stores the PDF",
    live: [{ shown: 30_000, play: 3000, end: "failed", note: "timeout" }],
    local: 3,
  },
]

export type FigureService = { name: string; vendor: string; logo: string }

type Kind = "before" | "after"

function buildCards(services: FigureService[]) {
  const tests = TESTS.map((test) => {
    const service = services.find((s) => s.name === test.service)
    if (!service) throw new Error(`the landing figure names ${test.service}, not in the catalog`)
    return { ...test, service }
  })
  const card = (
    kind: Kind,
    title: string,
    link: string,
    attemptsOf: (t: (typeof tests)[number]) => Attempt[],
  ) => {
    const rows = tests.map((test) => {
      const attempts = attemptsOf(test)
      return {
        ...test,
        attempts,
        outcome: outcomeOf(attempts),
        note: noteOf(attempts),
        total: attempts.reduce((sum, attempt) => sum + attempt.shown, 0),
      }
    })
    const counts: Record<Outcome, number> = { passed: 0, flaky: 0, failed: 0 }
    for (const row of rows) counts[row.outcome]++
    return {
      kind,
      title,
      link,
      rows,
      summary: summarize(counts),
      total: rows.reduce((sum, row) => sum + row.total, 0),
      state: counts.failed > 0 ? "failed" : "passed",
    }
  }
  return {
    tests,
    cards: [
      card("before", "Tests call live sandboxes", "network", (test) => test.live),
      // Quick enough to read as instant, slow enough that the eye sees the rows land in order.
      card("after", "Tests call emulators, in process", "in process", (test) => [
        { shown: test.local, play: 120, end: "passed" },
      ]),
    ],
  }
}

/** Row styles per state; the row is `group/test`, its card `group/card`. */
const ROW_TEXT = {
  name: "truncate group-data-[state=queued]/test:text-muted group-data-[state=failed]/test:text-danger",
  note: "text-right text-[11px] whitespace-nowrap group-data-[state=retrying]/test:text-warning group-data-[state=flaky]/test:text-warning group-data-[state=failed]/test:text-danger",
  time: "text-right tabular-nums whitespace-nowrap text-muted group-data-[state=flaky]/test:text-warning group-data-[state=failed]/test:text-danger group-data-[kind=before]/card:group-data-[state=passed]/test:text-warning group-data-[kind=after]/card:group-data-[state=passed]/test:text-success",
}

export function BeforeAfter({ services }: { services: FigureService[] }) {
  const { tests, cards } = buildCards(services)
  const [before, after] = cards
  const vendors = tests.map((test) => test.service.vendor).join(", ")
  return (
    <figure
      className="m-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
      data-before-after
      aria-label={`The same ${tests.length} tests, which call ${vendors}, run twice. Before, against live sandboxes: ${before?.summary} in ${formatDuration(before?.total ?? 0)}. After, against emulators in the same process: ${after?.summary} in ${formatDuration(after?.total ?? 0)}.`}
    >
      {cards.map((each, index) => (
        <div key={each.kind} className="contents">
          {index > 0 ? (
            <div aria-hidden="true" className="grid h-14 place-items-center lg:h-auto lg:w-16">
              <span className="grid size-9 place-items-center rounded-full border border-border bg-surface font-mono text-[11px] font-semibold tracking-wider text-muted uppercase">
                vs
              </span>
            </div>
          ) : null}
          <Card className="group/card @container min-w-0 gap-4" data-kind={each.kind} data-run>
            <Card.Header className="flex-row items-center gap-2.5">
              <StatusChip status={each.kind === "before" ? "warning" : "ok"}>
                {each.kind === "before" ? "Before" : "After"}
              </StatusChip>
              <Card.Title className="min-w-0 truncate text-[15px] font-semibold @max-[440px]:text-sm">
                {each.title}
              </Card.Title>
            </Card.Header>

            {/* Before, the frame is dashed: a boundary the calls run straight through. After it
                is solid: one line around everything a test touches. */}
            <div
              aria-hidden="true"
              className="grid grid-cols-[auto_minmax(48px,1fr)_auto] items-center rounded-md border border-dashed border-border bg-background p-4 group-data-[kind=after]/card:border-solid @max-[440px]:grid-cols-[auto_minmax(36px,1fr)_auto] @max-[440px]:p-2.5"
            >
              <span className="flex h-13 items-center rounded-md border border-foreground bg-surface px-4.5 text-[15px] font-semibold whitespace-nowrap @max-[440px]:h-10.5 @max-[440px]:px-2 @max-[440px]:text-[13px]">
                Your app
              </span>
              <span className="relative">
                <em className="absolute bottom-2 left-1/2 -translate-x-1/2 font-mono text-[11px] font-semibold tracking-wider whitespace-nowrap text-success not-italic uppercase group-data-[kind=before]/card:text-warning @max-[440px]:text-[9px]">
                  {each.link}
                </em>
                {/* A call out over the network is dashed; one in process is a solid line. */}
                <i className="block h-0.5 bg-success group-data-[kind=before]/card:h-0 group-data-[kind=before]/card:border-t-2 group-data-[kind=before]/card:border-dashed group-data-[kind=before]/card:border-warning group-data-[kind=before]/card:bg-transparent" />
              </span>
              <span className="flex h-13 items-center gap-1.5 rounded-md border border-foreground bg-surface px-3 group-data-[kind=before]/card:border-dashed group-data-[kind=before]/card:border-border @max-[440px]:h-10.5 @max-[440px]:gap-0.5 @max-[440px]:px-1.5">
                {each.rows.map((row) => (
                  <VendorLogo
                    key={row.service.name}
                    logo={row.service.logo}
                    size={28}
                    className="@max-[440px]:size-5!"
                  />
                ))}
              </span>
            </div>

            <div className="flex flex-1 flex-col rounded-md border border-border bg-background font-mono text-[12.5px] @max-[440px]:text-xs">
              <div className="border-b border-separator px-3.5 py-2.5 whitespace-nowrap text-muted @max-[440px]:px-2.5">
                <span className="mr-1 opacity-60">$</span> bun test checkout.test.ts
              </div>
              <ol className="m-0 flex-1 list-none px-0 py-1">
                {each.rows.map((row) => (
                  <li
                    key={row.service.name}
                    className="group/test grid h-9 grid-cols-[16px_minmax(0,1fr)_104px_52px_60px] items-center gap-2.5 px-3.5 @max-[440px]:grid-cols-[16px_20px_minmax(0,1fr)_auto_52px] @max-[440px]:gap-2 @max-[440px]:px-2.5 @max-[440px]:[&>*]:row-start-1"
                    data-test
                    data-state={row.outcome}
                    data-attempts={JSON.stringify(row.attempts)}
                  >
                    <span
                      aria-hidden="true"
                      className="grid size-4 place-items-center @max-[440px]:col-start-1 [&>*]:[grid-area:1/1]"
                    >
                      <span className="hidden size-1.5 rounded-full bg-muted group-data-[state=queued]/test:block" />
                      <Icon
                        name="check"
                        className="hidden size-3.5 text-success group-data-[state=flaky]/test:block group-data-[state=flaky]/test:text-warning group-data-[state=passed]/test:block"
                      />
                      <Icon
                        name="x"
                        className="hidden size-3.5 text-danger group-data-[state=failed]/test:block"
                      />
                      <i className="hidden size-3 rounded-full border-2 border-border border-t-muted group-data-[state=retrying]/test:block group-data-[state=retrying]/test:border-t-warning group-data-[state=running]/test:block motion-safe:animate-spin" />
                    </span>
                    <span className={`${ROW_TEXT.name} @max-[440px]:col-start-3`}>{row.name}</span>
                    <span className="flex items-center gap-1.5 font-sans text-xs whitespace-nowrap text-muted group-data-[state=queued]/test:opacity-45 @max-[440px]:col-start-2">
                      <VendorLogo logo={row.service.logo} size={20} />
                      <span className="@max-[440px]:hidden">{row.service.vendor}</span>
                    </span>
                    <span className={`${ROW_TEXT.note} @max-[440px]:col-start-4`} data-note>
                      {row.note}
                    </span>
                    <span className={`${ROW_TEXT.time} @max-[440px]:col-start-5`} data-time>
                      {formatDuration(row.total)}
                    </span>
                  </li>
                ))}
              </ol>
              <footer
                className="group/result grid grid-cols-[auto_minmax(24px,1fr)_auto] items-center gap-3 border-t border-separator px-3.5 py-3 whitespace-nowrap text-muted data-[state=failed]:text-danger data-[state=failing]:text-danger data-[state=passed]:text-success @max-[440px]:grid-cols-[minmax(0,1fr)_auto] @max-[440px]:gap-x-3 @max-[440px]:gap-y-2.5 @max-[440px]:px-2.5"
                data-result
                data-state={each.state}
              >
                <span className="font-semibold" data-summary>
                  {each.summary}
                </span>
                <span
                  aria-hidden="true"
                  className="h-1 overflow-hidden rounded-sm bg-default @max-[440px]:col-span-full @max-[440px]:row-start-1"
                >
                  <i
                    className="block h-full origin-left scale-x-[var(--done,1)] rounded-[inherit] bg-current transition-transform duration-200"
                    data-fill
                  />
                </span>
                <span className="min-w-15 text-right font-semibold tabular-nums" data-total>
                  {formatDuration(each.total)}
                </span>
              </footer>
            </div>
          </Card>
        </div>
      ))}
      <figcaption className="col-span-full mt-3.5 text-center text-xs text-muted">
        The same tests in both runs. Timings are illustrative.
      </figcaption>
    </figure>
  )
}
