// biome-ignore-all lint/suspicious/noArrayIndexKey: SQL result grids are positional
import type { JsValue, ResultSet } from "@crvouga/postgres-mem";

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

export function ResultTable({ result }: { result: ResultSet }) {
  const columns = result.columns;
  if (columns.length === 0) {
    return (
      <p className="empty-result">
        Statement completed — <code>{result.command}</code>, {result.rowCount} row
        {result.rowCount === 1 ? "" : "s"} affected.
      </p>
    );
  }

  const values = result.rows.map((row) => columns.map((column) => row[column]));

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column, i) => (
              <th key={`${column}-${i}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {values.length === 0 ? (
            <tr>
              <td className="empty-cell" colSpan={columns.length}>
                0 rows
              </td>
            </tr>
          ) : (
            values.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const formatted = formatValue(cell);
                  return (
                    <td key={ci} className={formatted.kind === "value" ? undefined : formatted.kind}>
                      {formatted.text}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
