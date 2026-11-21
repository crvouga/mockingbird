import {
  AppShell,
  EmptyState,
  ErrorState,
  KeyValueList,
  PageHeader,
  StatusChip,
  ThemeSwitch,
} from "@crvouga/mockingbird-ui/react";
import { ArrowRotateLeft, DatabaseMagnifier, FloppyDisk, Play, TrashBin } from "@gravity-ui/icons";
import { Alert, Button, Card, Kbd, Label, Tag, TagGroup, TextArea, TextField } from "@heroui/react";
import { type KeyboardEvent, useCallback, useState } from "react";
import { getDb, hasSavedSnapshot, resetDatabase, restoreSnapshot, savedSnapshotBytes, saveSnapshot } from "./db.ts";
import { ResultTable } from "./ResultTable.tsx";
import { DEFAULT_SQL, runSql, SAMPLES, type SqlOutcome } from "./sql.ts";

type Notice = { text: string; status: "accent" | "danger" };

export function App() {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [outcome, setOutcome] = useState<SqlOutcome | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
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
      setNotice({ text: "Ran inside Database.transaction() (BEGIN/COMMIT or ROLLBACK).", status: "accent" });
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
    setNotice({
      text: `Saved SQLM snapshot (${bytes.toLocaleString()} bytes) to localStorage. Not a .sqlite file.`,
      status: "accent",
    });
    setOutcome(null);
    refresh();
  };

  const onRestore = () => {
    try {
      if (!restoreSnapshot()) {
        setNotice({ text: "No snapshot in localStorage. Save one first.", status: "accent" });
        return;
      }
      setNotice({ text: "Restored SQLM snapshot from localStorage.", status: "accent" });
      setOutcome(null);
      refresh();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), status: "danger" });
    }
  };

  const onReset = () => {
    resetDatabase();
    setNotice({ text: "Reset to the seed schema. localStorage snapshot cleared.", status: "accent" });
    setOutcome(null);
    refresh();
  };

  const db = getDb();
  const currentSample = SAMPLES.find((sample) => sample.sql === sql)?.label;

  return (
    <AppShell
      product="sqlite-mem playground"
      actions={<ThemeSwitch />}
      footer={
        <>
          This demo passes <code className="font-mono">{`now: () => new Date()`}</code> so{" "}
          <code className="font-mono">date('now')</code> is wall-clock. The library default is a fixed{" "}
          <code className="font-mono">2000-01-01</code> clock. Snapshots use the custom SQLM codec — they are not
          portable <code className="font-mono">.sqlite</code> files.
        </>
      }
    >
      <PageHeader
        eyebrow={<code className="font-mono">@crvouga/mockingbird-service-sqlite</code>}
        title="SQL playground"
        description="Pure TypeScript SQLite in the browser. Synchronous API, no WASM, no workers, no filesystem. The whole database lives in JS memory."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {notice ? (
            <Alert status={notice.status} role="status">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{notice.text}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          <Card>
            <Card.Header>
              <Card.Title>Query</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-col gap-4">
              <TagGroup
                aria-label="Sample queries"
                selectionMode="single"
                selectedKeys={currentSample ? [currentSample] : []}
                onSelectionChange={(keys) => {
                  const [key] = [...keys];
                  const sample = SAMPLES.find((s) => s.label === key);
                  if (!sample) return;
                  setSql(sample.sql);
                  setNotice(null);
                }}
              >
                <TagGroup.List className="flex-wrap">
                  {SAMPLES.map((sample) => (
                    <Tag key={sample.label} id={sample.label}>
                      {sample.label}
                    </Tag>
                  ))}
                </TagGroup.List>
              </TagGroup>

              <TextField value={sql} onChange={setSql} className="flex flex-col gap-1.5">
                <Label>SQL</Label>
                <TextArea
                  rows={9}
                  spellCheck={false}
                  onKeyDown={onEditorKeyDown}
                  className="min-h-48 resize-y font-mono text-[13px] leading-relaxed"
                />
              </TextField>

              <div className="flex flex-wrap items-center gap-3">
                <Button onPress={run}>
                  <Play className="size-4" />
                  Run
                </Button>
                <Kbd>⌘ / Ctrl + Enter</Kbd>
              </div>
            </Card.Content>
          </Card>

          <section aria-live="polite" aria-label="Result" className="flex min-w-0 flex-col gap-3">
            {outcome === null ? (
              <Card>
                <EmptyState
                  icon={<DatabaseMagnifier />}
                  title="No result yet"
                  description="Run a statement to see rows, or an error with its SqliteError category."
                />
              </Card>
            ) : outcome.ok ? (
              <ResultTable result={outcome.result} />
            ) : (
              <ErrorState
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    SqliteError
                    {outcome.error.category ? (
                      <StatusChip status="error">
                        <span className="font-mono">{outcome.error.category}</span>
                      </StatusChip>
                    ) : null}
                    {outcome.error.sqliteCode ? (
                      <StatusChip status="neutral">
                        <span className="font-mono">{outcome.error.sqliteCode}</span>
                      </StatusChip>
                    ) : null}
                  </span>
                }
                error={outcome.error.message}
              />
            )}
          </section>
        </div>

        <Card className="h-fit" aria-label="Database snapshot">
          <Card.Header>
            <Card.Title>Database</Card.Title>
            <Card.Description>Save the whole database to localStorage, then restore or reset it.</Card.Description>
          </Card.Header>
          <Card.Content>
            <KeyValueList
              items={[
                { label: "changes", value: db.changes, mono: true },
                { label: "lastInsertRowid", value: String(db.lastInsertRowid), mono: true },
                {
                  label: "saved snapshot",
                  value: saved && snapshotBytes !== null ? `${snapshotBytes.toLocaleString()} B` : "none",
                  mono: true,
                },
              ]}
            />
          </Card.Content>
          <Card.Footer className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onPress={onSave}>
              <FloppyDisk className="size-4" />
              Save snapshot
            </Button>
            <Button variant="secondary" size="sm" onPress={onRestore} isDisabled={!saved}>
              <ArrowRotateLeft className="size-4" />
              Restore
            </Button>
            <Button variant="danger-soft" size="sm" onPress={onReset}>
              <TrashBin className="size-4" />
              Reset
            </Button>
          </Card.Footer>
        </Card>
      </div>
    </AppShell>
  );
}
