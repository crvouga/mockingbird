import { type KeyboardEvent, useCallback, useState } from "react";
import {
  engineVersion,
  getDb,
  hasSavedSnapshot,
  resetDatabase,
  restoreSnapshot,
  savedSnapshotBytes,
  saveSnapshot,
} from "./db.ts";
import { ResultTable } from "./ResultTable.tsx";
import { DEFAULT_SQL, runSql, SAMPLES, type SqlOutcome } from "./sql.ts";

export function App() {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [outcome, setOutcome] = useState<SqlOutcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(hasSavedSnapshot);
  const [snapshotBytes, setSnapshotBytes] = useState(savedSnapshotBytes);
  const [, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
    setSaved(hasSavedSnapshot());
    setSnapshotBytes(savedSnapshotBytes());
  }, []);

  const run = useCallback(() => {
    setNotice(null);
    const sample = SAMPLES.find((s) => s.sql === sql);
    const useTransaction = sample?.label === "transaction()";
    setOutcome(runSql(sql, { useTransaction }));
    if (useTransaction) {
      setNotice("Ran inside Database.transaction() (BEGIN/COMMIT or ROLLBACK).");
    }
    refresh();
  }, [refresh, sql]);

  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      run();
    }
  };

  const onSave = () => {
    const bytes = saveSnapshot();
    setNotice(`Saved PGMM snapshot (${bytes.toLocaleString()} bytes) to localStorage. Not a PostgreSQL data dir.`);
    setOutcome(null);
    refresh();
  };

  const onRestore = () => {
    try {
      if (!restoreSnapshot()) {
        setNotice("No snapshot in localStorage. Save one first.");
        return;
      }
      setNotice("Restored PGMM snapshot from localStorage.");
      setOutcome(null);
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const onReset = () => {
    resetDatabase();
    setNotice("Reset to the seed schema. localStorage snapshot cleared.");
    setOutcome(null);
    refresh();
  };

  const db = getDb();

  return (
    <div className="page">
      <header className="hero">
        <p className="eyebrow">@crvouga/postgres-mem</p>
        <h1>SQL playground</h1>
        <p className="lede">
          Pure TypeScript PostgreSQL in the browser. Synchronous API, no WASM, no workers, no filesystem. The whole
          database lives in JS memory.
        </p>
      </header>

      <section className="toolbar" aria-label="Database snapshot">
        <div className="meta">
          <span>
            changes <strong>{db.changes}</strong>
          </span>
          <span>
            engine <strong>{engineVersion()}</strong>
          </span>
          <span>
            saved snapshot{" "}
            <strong>{saved && snapshotBytes !== null ? `${snapshotBytes.toLocaleString()} B` : "none"}</strong>
          </span>
        </div>
        <div className="actions">
          <button type="button" onClick={onSave}>
            Save snapshot
          </button>
          <button type="button" onClick={onRestore} disabled={!saved}>
            Restore
          </button>
          <button type="button" className="danger" onClick={onReset}>
            Reset
          </button>
        </div>
      </section>

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      <section className="editor-panel">
        <nav className="samples" aria-label="Sample queries">
          {SAMPLES.map((sample) => (
            <button
              key={sample.label}
              type="button"
              className={sql === sample.sql ? "chip active" : "chip"}
              onClick={() => {
                setSql(sample.sql);
                setNotice(null);
              }}
            >
              {sample.label}
            </button>
          ))}
        </nav>

        <label className="sql-label" htmlFor="sql">
          SQL
        </label>
        <textarea
          id="sql"
          spellCheck={false}
          value={sql}
          onChange={(event) => setSql(event.target.value)}
          onKeyDown={onEditorKeyDown}
        />
        <div className="run-row">
          <button type="button" className="primary" onClick={run}>
            Run
          </button>
          <span className="hint">⌘ / Ctrl + Enter</span>
        </div>
      </section>

      <section className="results" aria-live="polite">
        {outcome === null ? (
          <p className="placeholder">Run a statement to see rows, or an error with its PostgresError category.</p>
        ) : outcome.ok ? (
          <ResultTable result={outcome.result} />
        ) : (
          <div className="error" role="alert">
            <p className="error-title">PostgresError</p>
            <p>{outcome.error.message}</p>
            <p className="error-meta">
              {outcome.error.category ? <code>{outcome.error.category}</code> : null}
              {outcome.error.sqlState ? <code>{outcome.error.sqlState}</code> : null}
            </p>
          </div>
        )}
      </section>

      <footer>
        This demo passes <code>{`now: "system"`}</code> so <code>now()</code> is wall-clock. The library default is a
        fixed <code>2000-01-01</code> clock. Snapshots use the custom PGMM codec — they are not on-disk PostgreSQL
        files.
      </footer>
    </div>
  );
}
