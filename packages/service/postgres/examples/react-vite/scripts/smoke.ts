// Headless check: seeds the example database and runs every sample query,
// failing loudly if any of them errors. Run with `bun scripts/smoke.ts`.

// db.ts reads localStorage at module load; shim it for non-browser runtimes.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const shim = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as Record<string, unknown>).localStorage = shim;
}

const { saveSnapshot, restoreSnapshot } = await import("../src/db.ts");
const { SAMPLES, runSql } = await import("../src/sql.ts");

let failures = 0;

for (const sample of SAMPLES) {
  const outcome = runSql(sample.sql, { useTransaction: sample.label === "transaction()" });
  if (outcome.ok) {
    const { columns, rows, command } = outcome.result;
    console.log(`ok   ${sample.label} — ${command}, ${rows.length} row(s), columns [${columns.join(", ")}]`);
  } else {
    failures++;
    const { message, category, sqlState } = outcome.error;
    console.error(`FAIL ${sample.label} — [${category ?? "?"}/${sqlState ?? "?"}] ${message}`);
  }
}

const bytes = saveSnapshot();
if (!restoreSnapshot()) {
  failures++;
  console.error("FAIL snapshot round-trip — restoreSnapshot() returned false");
} else {
  console.log(`ok   snapshot round-trip — ${bytes.toLocaleString()} bytes`);
}

if (failures > 0) {
  throw new Error(`${failures} sample(s) failed`);
}
console.log(`All ${SAMPLES.length} samples passed.`);
