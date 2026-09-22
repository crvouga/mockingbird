import { formatBytes, formatMs } from "./report.ts";
import type { BenchReport, BenchResult } from "./types.ts";

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

function heatClass(p95: number, sectionP95s: readonly number[]): string {
  if (!Number.isFinite(p95) || sectionP95s.length === 0) return "heat-mid";
  if (sectionP95s.length === 1) return "heat-cool-1";

  const sorted = [...sectionP95s].filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return "heat-mid";
  if (sorted.length === 1) return "heat-cool-1";

  // Rank percentile: 0 = fastest (cool), 1 = slowest (warm).
  let rank = 0;
  for (let i = 0; i < sorted.length; i++) {
    if ((sorted[i] ?? 0) <= p95) rank = i;
  }
  const t = rank / (sorted.length - 1);
  if (t <= 0.2) return "heat-cool-2";
  if (t <= 0.4) return "heat-cool-1";
  if (t <= 0.6) return "heat-mid";
  if (t <= 0.8) return "heat-warm-1";
  return "heat-warm-2";
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

function css(): string {
  return `
:root {
  --bg: #f7f6f3;
  --surface: #ffffff;
  --ink: #1c1b19;
  --muted: #6b6760;
  --line: #e4e1da;
  --accent: #2f4d5d;
  --accent-soft: #e8edf0;
  --heat-cool-2: #cfe3ec;
  --heat-cool-1: #dde9ee;
  --heat-mid: #f3efe6;
  --heat-warm-1: #f3d9c4;
  --heat-warm-2: #efc0a8;
  --heat-cool-ink: #1f3f4f;
  --heat-warm-ink: #7a3a1c;
  --mono: "SF Mono", "Menlo", "Consolas", ui-monospace, monospace;
  --sans: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif;
  --ui: "Avenir Next", "Segoe UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131314;
    --surface: #1d1d1e;
    --ink: #f2efe8;
    --muted: #a39e94;
    --line: #313134;
    --accent: #7ea4b8;
    --accent-soft: #243035;
    --heat-cool-2: #1c333d;
    --heat-cool-1: #24363f;
    --heat-mid: #353029;
    --heat-warm-1: #4a3224;
    --heat-warm-2: #5a2e20;
    --heat-cool-ink: #b7d8e4;
    --heat-warm-ink: #f0b896;
  }
}
* { box-sizing: border-box; }
html { font-size: 15px; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--ui);
  line-height: 1.45;
}
.wrap {
  max-width: 1180px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
}
header.hero {
  margin-bottom: 2rem;
  border-bottom: 1px solid var(--line);
  padding-bottom: 1.5rem;
}
header.hero h1 {
  font-family: var(--sans);
  font-weight: 600;
  font-size: 2rem;
  letter-spacing: -0.02em;
  margin: 0 0 0.5rem;
}
.meta {
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  font-size: 0.92rem;
}
.badge {
  display: inline-block;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 999px;
  padding: 0.15rem 0.65rem;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1rem;
  margin-bottom: 2.5rem;
}
.summary-card {
  background: var(--surface);
  border: 1px solid var(--line);
  padding: 1rem 1.1rem;
}
.summary-card h2 {
  margin: 0 0 0.65rem;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 600;
}
.stat-line {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.28rem 0;
  border-bottom: 1px solid var(--line);
  font-size: 0.9rem;
}
.stat-line:last-child { border-bottom: none; }
.stat-line .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.stat-line .value {
  font-family: var(--mono);
  font-size: 0.82rem;
  color: var(--muted);
  flex-shrink: 0;
}
.toc {
  margin: 0 0 2rem;
  padding: 0;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.toc a {
  color: var(--accent);
  text-decoration: none;
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 0.25rem 0.6rem;
  font-size: 0.82rem;
}
.toc a:hover { border-color: var(--accent); }
section.group {
  margin-bottom: 2.25rem;
}
section.group h2 {
  font-family: var(--sans);
  font-size: 1.25rem;
  margin: 0 0 0.75rem;
  font-weight: 600;
}
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  background: var(--surface);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
thead th {
  position: sticky;
  top: 0;
  background: var(--surface);
  z-index: 1;
  text-align: left;
  font-weight: 600;
  color: var(--muted);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 0.65rem 0.75rem;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
tbody td {
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: color-mix(in srgb, var(--accent-soft) 55%, transparent); }
.name { font-weight: 500; }
.op { color: var(--muted); font-size: 0.84rem; }
.num {
  font-family: var(--mono);
  font-size: 0.8rem;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.heat-cool-2 td.lat { background: var(--heat-cool-2); color: var(--heat-cool-ink); }
.heat-cool-1 td.lat { background: var(--heat-cool-1); color: var(--heat-cool-ink); }
.heat-mid td.lat { background: var(--heat-mid); }
.heat-warm-1 td.lat { background: var(--heat-warm-1); color: var(--heat-warm-ink); }
.heat-warm-2 td.lat { background: var(--heat-warm-2); color: var(--heat-warm-ink); font-weight: 600; }
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0 0 1.25rem;
  font-size: 0.78rem;
  color: var(--muted);
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.45rem;
  border: 1px solid var(--line);
  background: var(--surface);
}
.legend i {
  width: 0.75rem;
  height: 0.75rem;
  display: inline-block;
  border-radius: 2px;
}
.engine {
  font-size: 0.78rem;
  color: var(--muted);
  white-space: nowrap;
}
footer.note {
  margin-top: 2rem;
  color: var(--muted);
  font-size: 0.85rem;
  border-top: 1px solid var(--line);
  padding-top: 1rem;
}
@media (max-width: 720px) {
  .wrap { padding: 1.5rem 1rem 3rem; }
  header.hero h1 { font-size: 1.55rem; }
}
`.trim();
}

function renderRow(result: BenchResult, sectionP95s: readonly number[], showSnap: boolean): string {
  const delta = heapDelta(result);
  const snap =
    showSnap && typeof result.extra?.snapshotBytes === "number"
      ? formatBytes(result.extra.snapshotBytes as number)
      : showSnap
        ? "—"
        : "";
  const p50 = result.reliablePercentiles ? formatMs(result.p50) : `${formatMs(result.mean)}~`;
  const p95 = result.reliablePercentiles ? formatMs(result.p95) : "n/a";
  const heat = result.reliablePercentiles ? heatClass(result.p95, sectionP95s) : "heat-mid";
  return `<tr class="${heat}">
  <td>
    <div class="name">${escapeHtml(result.name)}</div>
    <div class="op">${escapeHtml(result.operation)}${result.layer ? ` · ${escapeHtml(result.layer)}` : ""}</div>
  </td>
  <td class="num">${escapeHtml(formatDataset(result.datasetSize))}</td>
  <td class="engine">${escapeHtml(result.engine)}</td>
  <td class="num lat">${escapeHtml(p50)}</td>
  <td class="num lat">${escapeHtml(p95)}</td>
  <td class="num lat">${escapeHtml(formatMs(result.perOpMs))}</td>
  <td class="num">${escapeHtml(formatOps(result.opsPerSec))}</td>
  <td class="num">${escapeHtml(formatBytes(delta))}</td>
  ${showSnap ? `<td class="num">${escapeHtml(snap)}</td>` : ""}
</tr>`;
}

function renderSection(section: Section): string {
  const sectionP95s = section.results.map((r) => r.p95);
  const showSnap = section.results.some((r) => typeof r.extra?.snapshotBytes === "number");
  const rows = section.results.map((r) => renderRow(r, sectionP95s, showSnap)).join("\n");
  return `<section class="group" id="${escapeHtml(section.id)}">
  <h2>${escapeHtml(section.title)} <span class="badge">${section.results.length}</span></h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Benchmark</th>
          <th class="num">n</th>
          <th>Engine</th>
          <th class="num">p50</th>
          <th class="num">p95</th>
          <th class="num">perOp</th>
          <th class="num">ops/s</th>
          <th class="num">heap Δ</th>
          ${showSnap ? `<th class="num">snapshot</th>` : ""}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</section>`;
}

export function renderHtmlReport(report: BenchReport): string {
  const sections = groupResults(report.results);
  const engines = [...new Set(report.results.map((r) => r.engine))].sort();
  const bySlow = [...report.results].sort((a, b) => b.p95 - a.p95).slice(0, 5);
  const byFast = [...report.results].sort((a, b) => b.opsPerSec - a.opsPerSec).slice(0, 5);

  const envBits = [`${report.environment.runtime} ${report.environment.runtimeVersion}`, report.environment.platform];

  const toc = sections.map((s) => `<li><a href="#${escapeHtml(s.id)}">${escapeHtml(s.title)}</a></li>`).join("");

  const slowList = bySlow
    .map(
      (r) =>
        `<div class="stat-line"><span class="label" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span><span class="value">${escapeHtml(formatMs(r.p95))}</span></div>`,
    )
    .join("");
  const fastList = byFast
    .map(
      (r) =>
        `<div class="stat-line"><span class="label" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span><span class="value">${escapeHtml(formatOps(r.opsPerSec))}/s</span></div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>postgres-mem benchmarks — ${escapeHtml(report.tier)}</title>
  <style>${css()}</style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <h1>postgres-mem Benchmarks</h1>
      <div class="meta">
        <span class="badge">${escapeHtml(report.tier)}</span>
        <span>${escapeHtml(formatWhen(report.generatedAt))}</span>
        <span>${escapeHtml(envBits.join(" · "))}</span>
        <span>${report.results.length} results · ${escapeHtml(engines.join(", "))}</span>
      </div>
    </header>

    <div class="summary">
      <div class="summary-card">
        <h2>Slowest by p95</h2>
        ${slowList}
      </div>
      <div class="summary-card">
        <h2>Highest throughput</h2>
        ${fastList}
      </div>
      <div class="summary-card">
        <h2>Suite</h2>
        <div class="stat-line"><span class="label">Results</span><span class="value">${report.results.length}</span></div>
        <div class="stat-line"><span class="label">Sections</span><span class="value">${sections.length}</span></div>
        <div class="stat-line"><span class="label">Engines</span><span class="value">${escapeHtml(engines.join(", "))}</span></div>
        <div class="stat-line"><span class="label">Tier</span><span class="value">${escapeHtml(report.tier)}</span></div>
      </div>
    </div>

    <ul class="toc">${toc}</ul>

    <div class="legend" aria-label="Latency heat legend">
      <span><i style="background:var(--heat-cool-2)"></i> fastest</span>
      <span><i style="background:var(--heat-cool-1)"></i> fast</span>
      <span><i style="background:var(--heat-mid)"></i> mid</span>
      <span><i style="background:var(--heat-warm-1)"></i> slow</span>
      <span><i style="background:var(--heat-warm-2)"></i> slowest</span>
      <span>p50 / p95 / p99 ranked within each section</span>
    </div>

    ${sections.map(renderSection).join("\n")}

    <footer class="note">
      Latencies are wall-clock per sample. Cooler cells are faster within that section; warmer cells are slower.
      Heap Δ uses runtime heap samples when available (may be noisy under GC).
      When iterations &lt; 5, p95 is shown as n/a and p50 shows mean~ (unreliable percentiles).
      perOp is mean sample time divided by opsPerSample.
    </footer>
  </div>
</body>
</html>
`;
}
