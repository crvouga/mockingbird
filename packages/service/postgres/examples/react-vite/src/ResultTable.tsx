// biome-ignore-all lint/suspicious/noArrayIndexKey: SQL result grids are positional
import type { JsValue, ResultSet } from "@crvouga/mockingbird-service-postgres";
import { StatusChip } from "@crvouga/mockingbird-ui/react";
import { Card, Table } from "@heroui/react";

function formatValue(value: JsValue | undefined): { text: string; kind: "null" | "bytea" | "value" } {
  if (value === null || value === undefined) return { text: "NULL", kind: "null" };
  if (typeof value === "bigint") return { text: value.toString(), kind: "value" };
  if (value instanceof Uint8Array) {
    const hex = [...value.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const text = value.length > 16 ? `BYTEA(${value.length}) ${hex}…` : `BYTEA(${value.length}) ${hex}`;
    return { text, kind: "bytea" };
  }
  return { text: String(value), kind: "value" };
}

const CELL_CLASS = { null: "italic text-muted", bytea: "text-muted", value: "" } as const;

export function ResultTable({ result }: { result: ResultSet }) {
  const columns = result.columns;
  if (columns.length === 0) {
    return (
      <Card>
        <Card.Content className="flex flex-wrap items-center gap-2 text-sm">
          <StatusChip status="ok">Statement completed</StatusChip>
          <span className="text-muted">
            <code className="font-mono text-foreground">{result.command}</code>, {result.rowCount} row
            {result.rowCount === 1 ? "" : "s"} affected
          </span>
        </Card.Content>
      </Card>
    );
  }

  const values = result.rows.map((row) => columns.map((column) => row[column]));

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-muted">
        <code className="font-mono">{result.command}</code> · {values.length} row{values.length === 1 ? "" : "s"}
      </p>
      <Table>
        <Table.ScrollContainer className="max-h-[32rem] overflow-auto">
          <Table.Content aria-label="Result rows" className="min-w-full">
            <Table.Header>
              {columns.map((column, i) => (
                <Table.Column key={i} id={`c${i}`} isRowHeader={i === 0} className="whitespace-nowrap font-mono">
                  {column}
                </Table.Column>
              ))}
            </Table.Header>
            <Table.Body renderEmptyState={() => <p className="py-6 text-center text-sm text-muted">0 rows</p>}>
              {values.map((row, ri) => (
                <Table.Row key={ri} id={`r${ri}`}>
                  {row.map((cell, ci) => {
                    const formatted = formatValue(cell);
                    return (
                      <Table.Cell
                        key={ci}
                        className={`whitespace-pre font-mono text-[13px] ${CELL_CLASS[formatted.kind]}`}
                        data-kind={formatted.kind}
                      >
                        {formatted.text}
                      </Table.Cell>
                    );
                  })}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  );
}
