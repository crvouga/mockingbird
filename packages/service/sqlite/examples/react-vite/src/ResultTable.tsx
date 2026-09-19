// biome-ignore-all lint/suspicious/noArrayIndexKey: SQL result grids are positional
import type { QueryValue, ResultSet } from "@crvouga/sqlite-mem";

function formatValue(value: QueryValue | undefined): { text: string; kind: "null" | "blob" | "value" } {
  if (value === null || value === undefined) return { text: "NULL", kind: "null" };
  if (typeof value === "bigint") return { text: value.toString(), kind: "value" };
  if (value instanceof Uint8Array) {
    const hex = [...value.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const text = value.length > 16 ? `BLOB(${value.length}) ${hex}…` : `BLOB(${value.length}) ${hex}`;
    return { text, kind: "blob" };
  }
  return { text: String(value), kind: "value" };
}

export function ResultTable({ result }: { result: ResultSet }) {
  const columns = result.columns;
  if (columns.length === 0) {
    return (
      <p className="empty-result">
        Statement completed — {result.changes} change{result.changes === 1 ? "" : "s"}, lastInsertRowid{" "}
        {String(result.lastInsertRowid)}.
      </p>
    );
  }

  const values =
    result.values ?? result.rows.map((row) => columns.map((column) => row[column] as QueryValue | undefined));

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
