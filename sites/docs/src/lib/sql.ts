/**
 * Split a SQL script into statements on top-level `;`, skipping quoted strings, quoted
 * identifiers, dollar-quoted bodies and comments. The engines take one statement per
 * `query()`, and the console shows each statement's result separately.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  const n = script.length
  while (i < n) {
    const c = script[i]
    const next = script[i + 1]
    if (c === "-" && next === "-") {
      const end = script.indexOf("\n", i)
      i = end === -1 ? n : end + 1
    } else if (c === "/" && next === "*") {
      const end = script.indexOf("*/", i + 2)
      i = end === -1 ? n : end + 2
    } else if (c === "'" || c === '"' || c === "`") {
      i++
      while (i < n) {
        if (script[i] === c) {
          if (script[i + 1] === c) i += 2
          else break
        } else i++
      }
      i++
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(script.slice(i))?.[0]
      if (tag) {
        const end = script.indexOf(tag, i + tag.length)
        i = end === -1 ? n : end + tag.length
      } else i++
    } else if (c === ";") {
      out.push(script.slice(start, i))
      start = ++i
    } else i++
  }
  out.push(script.slice(start))
  return out.map((s) => s.trim()).filter((s) => stripComments(s).trim() !== "")
}

const stripComments = (sql: string): string =>
  sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")

export interface Snippet {
  label: string
  sql: string
}

const shared: Snippet[] = [
  {
    label: "Create tables",
    sql: `CREATE TABLE authors (
  id integer PRIMARY KEY,
  name text NOT NULL UNIQUE
);
CREATE TABLE books (
  id integer PRIMARY KEY,
  author_id integer NOT NULL REFERENCES authors (id),
  title text NOT NULL,
  year integer NOT NULL
);`,
  },
  {
    label: "Insert rows",
    sql: `INSERT INTO authors (id, name) VALUES
  (1, 'Ursula K. Le Guin'),
  (2, 'Octavia E. Butler');
INSERT INTO books (id, author_id, title, year) VALUES
  (1, 1, 'A Wizard of Earthsea', 1968),
  (2, 1, 'The Dispossessed', 1974),
  (3, 2, 'Kindred', 1979),
  (4, 2, 'Parable of the Sower', 1993);`,
  },
  {
    label: "Join & aggregate",
    sql: `SELECT a.name, count(*) AS books, min(b.year) AS first, max(b.year) AS latest
FROM authors a
JOIN books b ON b.author_id = a.id
GROUP BY a.name
ORDER BY a.name;`,
  },
]

/** Starter scripts per engine, run in order against one database when the build validates them. */
export const SQL_SNIPPETS: Record<"postgres" | "sqlite", Snippet[]> = {
  postgres: [
    ...shared,
    {
      label: "Window function",
      sql: `SELECT title, year,
  rank() OVER (PARTITION BY author_id ORDER BY year) AS nth
FROM books
ORDER BY author_id, year;`,
    },
    {
      label: "JSONB",
      sql: `SELECT jsonb_build_object('title', title, 'year', year) AS doc
FROM books
WHERE year < 1975;`,
    },
    {
      label: "Constraint error",
      sql: `INSERT INTO authors (id, name) VALUES (3, 'Ursula K. Le Guin');`,
    },
  ],
  sqlite: [
    ...shared,
    {
      label: "Window function",
      sql: `SELECT title, year,
  rank() OVER (PARTITION BY author_id ORDER BY year) AS nth
FROM books
ORDER BY author_id, year;`,
    },
    {
      label: "JSON",
      sql: `SELECT json_object('title', title, 'year', year) AS doc
FROM books
WHERE year < 1975;`,
    },
    {
      label: "Constraint error",
      sql: `INSERT INTO authors (id, name) VALUES (3, 'Ursula K. Le Guin');`,
    },
  ],
}

/** Snippets whose last statement is expected to fail, to show the engine's error shape. */
export const EXPECTED_ERROR_SNIPPETS = new Set(["Constraint error"])
