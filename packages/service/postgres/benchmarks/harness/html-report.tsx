/**
 * The benchmark report (`bun run benchmarks/report-html.ts`, and beside every `benchmarks/run.ts`
 * JSON): one static page in the Mockingbird design system, rendered with React and HeroUI into
 * `renderDocument` with the stylesheet inlined, so it opens from disk with no JavaScript.
 */
import { renderDocument } from "@crvouga/mockingbird-ui/document";
import {
  AppShell,
  EmptyState,
  KeyValueList,
  MockingbirdProvider,
  PageHeader,
  StatusChip,
} from "@crvouga/mockingbird-ui/react";
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles";
import { buttonVariants, Card, Table } from "@heroui/react";
// Not `renderPage`: the report is never hydrated, so static markup is all it needs.
import { renderToStaticMarkup } from "react-dom/server";
import { formatBytes, formatMs } from "./report.ts";
import type { BenchReport, BenchResult } from "./types.ts";

const ENGINE = "postgres-mem";

interface Section {
  id: string;
  title: string;
  results: BenchResult[];
}

const SECTION_ORDER: { id: string; title: string; match: (name: string) => boolean }[] = [
  { id: "startup", title: "Startup", match: (n) => n.startsWith("startup/") },
  { id: "micro", title: "Microbenchmarks", match: (n) => n.startsWith("micro/") },
  { id: "workload-a", title: "Workload A — Local-first CRUD", match: (n) => n.startsWith("workload-a/") },
  { id: "workload-b", title: "Workload B — Sync engine", match: (n) => n.startsWith("workload-b/") },
  { id: "workload-c", title: "Workload C — Indexed app DB", match: (n) => n.startsWith("workload-c/") },
  { id: "large", title: "Large dataset", match: (n) => n.startsWith("large/") },
  { id: "json", title: "JSONB", match: (n) => n.startsWith("json/") },
  { id: "tsearch", title: "Text search", match: (n) => n.startsWith("tsearch/") },
  { id: "engine", title: "Engine ops", match: (n) => n.startsWith("engine/") },
  { id: "tx", title: "Transactions", match: (n) => n.startsWith("tx/") },
  { id: "index", title: "Indexes", match: (n) => n.startsWith("index/") },
  { id: "join", title: "Joins", match: (n) => n.startsWith("join/") },
  { id: "snapshot", title: "Snapshots", match: (n) => n.startsWith("snapshot/") },
  { id: "memory", title: "Memory footprint", match: (n) => n.startsWith("memory/") },
];

function heapDelta(result: BenchResult): number | undefined {
  const before = result.memoryBefore?.heapUsed;
  const after = result.memoryAfter?.heapUsed;
  if (before === undefined || after === undefined) return undefined;
  return after - before;
}

function formatOps(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString("en-US");
}

function formatDataset(size: number | string | null): string {
  if (size === null || size === undefined || size === "") return "—";
  if (typeof size === "number") return size.toLocaleString("en-US");
  return String(size);
}

function groupResults(results: readonly BenchResult[]): Section[] {
  const used = new Set<BenchResult>();
  const sections: Section[] = [];
  for (const def of SECTION_ORDER) {
    const matched = results.filter((r) => def.match(r.name));
    if (matched.length === 0) continue;
    for (const r of matched) used.add(r);
    sections.push({ id: def.id, title: def.title, results: matched });
  }
  const other = results.filter((r) => !used.has(r));
  if (other.length > 0) sections.push({ id: "other", title: "Other", results: other });
  return sections;
}

/** Latency heat, ranked within a section: 0 fastest … 4 slowest. */
type Heat = 0 | 1 | 2 | 3 | 4;

/** Theme tokens only, so the heat follows light and dark like every other surface. */
const HEAT_CLASS: Record<Heat, string> = {
  0: "bg-success-soft text-success-soft-foreground",
  1: "bg-success-soft/50",
  2: "",
  3: "bg-warning-soft/60",
  4: "bg-danger-soft text-danger-soft-foreground font-semibold",
};

const HEAT_LEGEND: { heat: Heat; label: string }[] = [
  { heat: 0, label: "fastest" },
  { heat: 1, label: "fast" },
  { heat: 2, label: "mid" },
  { heat: 3, label: "slow" },
  { heat: 4, label: "slowest" },
];

function heatOf(p95: number, sectionP95s: readonly number[]): Heat {
  if (!Number.isFinite(p95) || sectionP95s.length === 0) return 2;
  const sorted = [...sectionP95s].filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length <= 1) return 1;
  // Rank percentile: 0 = fastest (cool), 1 = slowest (warm).
  let rank = 0;
  for (let i = 0; i < sorted.length; i++) {
    if ((sorted[i] ?? 0) <= p95) rank = i;
  }
  const t = rank / (sorted.length - 1);
  if (t <= 0.2) return 0;
  if (t <= 0.4) return 1;
  if (t <= 0.6) return 2;
  if (t <= 0.8) return 3;
  return 4;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" });
  } catch {
    return iso;
  }
}

const NUM = "text-end font-mono text-[13px] whitespace-nowrap tabular-nums";

function ResultsTable({ section }: { section: Section }) {
  const sectionP95s = section.results.map((r) => r.p95);
  const showSnap = section.results.some((r) => typeof r.extra?.snapshotBytes === "number");
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label={section.title}>
          <Table.Header>
            <Table.Column isRowHeader>Benchmark</Table.Column>
            <Table.Column className="text-end">n</Table.Column>
            <Table.Column>Engine</Table.Column>
            <Table.Column className="text-end">p50</Table.Column>
            <Table.Column className="text-end">p95</Table.Column>
            <Table.Column className="text-end">perOp</Table.Column>
            <Table.Column className="text-end">ops/s</Table.Column>
            <Table.Column className="text-end">heap Δ</Table.Column>
            {showSnap ? <Table.Column className="text-end">snapshot</Table.Column> : null}
          </Table.Header>
          <Table.Body>
            {section.results.map((result, index) => {
              const heat = HEAT_CLASS[result.reliablePercentiles ? heatOf(result.p95, sectionP95s) : 2];
              const snap = typeof result.extra?.snapshotBytes === "number" ? formatBytes(result.extra.snapshotBytes) : "—";
              return (
                <Table.Row key={`${result.name}:${result.engine}:${index}`} id={`${result.name}:${result.engine}:${index}`}>
                  <Table.Cell>
                    <div className="font-medium">{result.name}</div>
                    <div className="text-xs text-muted">
                      {result.operation}
                      {result.layer ? ` · ${result.layer}` : ""}
                    </div>
                  </Table.Cell>
                  <Table.Cell className={NUM}>{formatDataset(result.datasetSize)}</Table.Cell>
                  <Table.Cell className="whitespace-nowrap text-xs text-muted">{result.engine}</Table.Cell>
                  <Table.Cell className={`${NUM} ${heat}`}>
                    {result.reliablePercentiles ? formatMs(result.p50) : `${formatMs(result.mean)}~`}
                  </Table.Cell>
                  <Table.Cell className={`${NUM} ${heat}`}>
                    {result.reliablePercentiles ? formatMs(result.p95) : "n/a"}
                  </Table.Cell>
                  <Table.Cell className={`${NUM} ${heat}`}>{formatMs(result.perOpMs)}</Table.Cell>
                  <Table.Cell className={NUM}>{formatOps(result.opsPerSec)}</Table.Cell>
                  <Table.Cell className={NUM}>{formatBytes(heapDelta(result))}</Table.Cell>
                  {showSnap ? <Table.Cell className={NUM}>{snap}</Table.Cell> : null}
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

function SummaryCard({ title, items }: { title: string; items: { label: string; value: string }[] }) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
      </Card.Header>
      <Card.Content>
        <KeyValueList
          items={items.map((item, index) => ({
            id: `${item.label}:${index}`,
            label: (
              <span className="block truncate" title={item.label}>
                {item.label}
              </span>
            ),
            value: item.value,
            mono: true,
          }))}
        />
      </Card.Content>
    </Card>
  );
}

export function BenchmarkReport({ report }: { report: BenchReport }) {
  const sections = groupResults(report.results);
  const engines = [...new Set(report.results.map((r) => r.engine))].sort();
  const bySlow = [...report.results].sort((a, b) => b.p95 - a.p95).slice(0, 5);
  const byFast = [...report.results].sort((a, b) => b.opsPerSec - a.opsPerSec).slice(0, 5);
  const env = [`${report.environment.runtime} ${report.environment.runtimeVersion}`, report.environment.platform];
  return (
    <AppShell
      product="Benchmarks"
      footer={
        <p className="max-w-prose">
          Latencies are wall-clock per sample. Green cells are faster within that section; amber and red cells are
          slower. Heap Δ uses runtime heap samples when available (may be noisy under GC). When iterations &lt; 5, p95
          is shown as n/a and p50 shows mean~ (unreliable percentiles). perOp is mean sample time divided by
          opsPerSample.
        </p>
      }
    >
      <PageHeader
        eyebrow={<StatusChip status="info">{report.tier}</StatusChip>}
        title={`${ENGINE} benchmarks`}
        description={
          <>
            {formatWhen(report.generatedAt)} · {env.join(" · ")} · {report.results.length} results
            {engines.length ? ` · ${engines.join(", ")}` : ""}
          </>
        }
      />
      {report.results.length === 0 ? (
        <Card>
          <EmptyState title="No results" description="This run measured nothing: no benchmark matched the tier." />
        </Card>
      ) : (
        <div className="flex flex-col gap-8">
          <div className="grid gap-4 md:grid-cols-3">
            <SummaryCard
              title="Slowest by p95"
              items={bySlow.map((r) => ({ label: r.name, value: formatMs(r.p95) }))}
            />
            <SummaryCard
              title="Highest throughput"
              items={byFast.map((r) => ({ label: r.name, value: `${formatOps(r.opsPerSec)}/s` }))}
            />
            <SummaryCard
              title="Suite"
              items={[
                { label: "Results", value: String(report.results.length) },
                { label: "Sections", value: String(sections.length) },
                { label: "Engines", value: engines.join(", ") },
                { label: "Tier", value: report.tier },
              ]}
            />
          </div>
          <nav aria-label="Sections" className="flex flex-wrap gap-2">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} className={buttonVariants({ variant: "tertiary", size: "sm" })}>
                {s.title}
              </a>
            ))}
          </nav>
          <div aria-label="Latency heat legend" className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {HEAT_LEGEND.map(({ heat, label }) => (
              <span
                key={label}
                className={`rounded-md border border-border px-2 py-0.5 ${HEAT_CLASS[heat] || "bg-surface"}`}
              >
                {label}
              </span>
            ))}
            <span>p50 / p95 / perOp ranked by p95 within each section</span>
          </div>
          {sections.map((section) => (
            <section key={section.id} id={section.id} className="scroll-mt-20">
              <PageHeader
                level={2}
                title={
                  <span className="inline-flex items-center gap-2">
                    {section.title}
                    <StatusChip status="neutral">{section.results.length}</StatusChip>
                  </span>
                }
              />
              <ResultsTable section={section} />
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}

export function renderHtmlReport(report: BenchReport): string {
  return renderDocument({
    title: `${ENGINE} benchmarks — ${report.tier}`,
    body: renderToStaticMarkup(
      <MockingbirdProvider>
        <BenchmarkReport report={report} />
      </MockingbirdProvider>,
    ),
    css: MOCKINGBIRD_CSS,
    rememberTheme: true,
  });
}
