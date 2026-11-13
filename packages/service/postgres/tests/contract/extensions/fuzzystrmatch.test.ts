import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";
import { errorParity, parity, parityTyped, sequenceParity } from "../helpers.ts";

// fuzzystrmatch (issue #721): levenshtein, soundex / difference and metaphone, differential
// against the oracle. dmetaphone, dmetaphone_alt and daitch_mokotoff are not implemented and
// fail loud with 0A000 once the extension is installed.

const INSTALL = ["CREATE EXTENSION fuzzystrmatch"];

/**
 * English words, names and letter clusters that exercise every metaphone and soundex rule:
 * initial AE / GN / KN / PN / WR / WH / X, vowels, CIA / CH / SCH / SCHW, DGE, GH, GN / GNED,
 * soft C and G, PH, SIA / SIO / TIA / TIO, TH, doubled letters, MB, non-letters and empty input.
 */
const WORDS = [
  "Aaron",
  "Abbott",
  "Aberdeen",
  "Acre",
  "Adam",
  "Aegis",
  "Aeon",
  "Agnes",
  "Aitken",
  "Alexander",
  "Allison",
  "Ancient",
  "Andrew",
  "Ann",
  "Anne",
  "Ashcraft",
  "Ashworth",
  "Aubrey",
  "Bach",
  "Bacchus",
  "Baker",
  "Bomb",
  "Bough",
  "Bright",
  "Broughton",
  "Caesar",
  "Campbell",
  "Ceiling",
  "Character",
  "Charles",
  "Chemistry",
  "Chianti",
  "Chris",
  "Christopher",
  "Cia",
  "Cicero",
  "Circus",
  "Cough",
  "Cyber",
  "Czerny",
  "Daughter",
  "Dodge",
  "Dodgy",
  "Dougal",
  "Dumb",
  "Edge",
  "Edgar",
  "Eighty",
  "Ellis",
  "Enough",
  "Exact",
  "Exhaust",
  "Fischer",
  "Flight",
  "Gaelic",
  "Gemma",
  "Geoff",
  "George",
  "Ghent",
  "Ghost",
  "Gibbon",
  "Giggle",
  "Gnat",
  "Gnome",
  "Gough",
  "Gutierrez",
  "Hamilton",
  "Hello World",
  "Heughan",
  "Hugh",
  "Hughes",
  "Ignore",
  "Island",
  "Jackson",
  "Jose",
  "Judge",
  "Kathleen",
  "Knight",
  "Knuth",
  "Lamb",
  "Laugh",
  "Lloyd",
  "Lough",
  "Margaret",
  "Mc Donald",
  "MacGregor",
  "Mitchell",
  "Mueller",
  "Nation",
  "Neighbour",
  "Night",
  "OHara",
  "O'Hara",
  "Ought",
  "Pfister",
  "Philip",
  "Phillip",
  "Phoenix",
  "Pneumonia",
  "Psychology",
  "Quick",
  "Quixote",
  "Ralph",
  "Rhythm",
  "Robert",
  "Rupert",
  "Sachs",
  "Scherer",
  "Schlesinger",
  "Schmidt",
  "School",
  "Schwarz",
  "Schwarzenegger",
  "Science",
  "Sciatic",
  "Scott",
  "Session",
  "Shaw",
  "Siobhan",
  "Smith",
  "Smythe",
  "Sugar",
  "Tension",
  "Thomas",
  "Thompson",
  "Thumb",
  "Tichner",
  "Tough",
  "Tymczak",
  "Vivid",
  "Wagner",
  "Walsh",
  "Washington",
  "Weight",
  "Which",
  "Whistle",
  "White",
  "Wright",
  "Wrong",
  "Xavier",
  "Xerxes",
  "Yes",
  "Young",
  "Zach",
  "Zimmermann",
  "ZZ Top",
  "aardvark",
  "abc",
  "accept",
  "acceptance",
  "aesthetic",
  "beautiful",
  "cc",
  "ccc",
  "chhh",
  "dg",
  "dge",
  "gh",
  "gn",
  "gned",
  "gnu",
  "kn",
  "pn",
  "sch",
  "schw",
  "sh",
  "sia",
  "sio",
  "tch",
  "th",
  "tia",
  "tio",
  "wh",
  "wr",
  "x",
  "xa",
  "xx",
  "ax",
  "a1b",
  "1234",
  "a-b",
  "  leading space",
  "trailing!",
  "",
  "Ägypten",
  "ÄBC",
  "naïve",
  "café",
  "Ünal",
  "Øster",
] as const;

const LITERALS = WORDS.map((w, i) => `(${i + 1}, '${w.replace(/'/g, "''")}')`).join(", ");

parity(
  "metaphone and soundex over a broad word list",
  [
    ...INSTALL,
    "CREATE TABLE words (id int, w text)",
    `INSERT INTO words VALUES ${LITERALS}, (${WORDS.length + 1}, NULL)`,
  ],
  `SELECT id, w, metaphone(w, 4) AS m4, metaphone(w, 10) AS m10, metaphone(w, 1) AS m1, soundex(w) AS s,
          text_soundex(w) AS ts, difference(w, 'Robert') AS d
   FROM words ORDER BY id`,
);

parity(
  "difference compares every pair of a word list",
  [
    ...INSTALL,
    "CREATE TABLE names (n text)",
    "INSERT INTO names VALUES ('Anne'), ('Ann'), ('Andrew'), ('Margaret'), (''), ('Robert'), ('Rupert'), ('a')",
  ],
  "SELECT a.n, b.n, difference(a.n, b.n) FROM names a CROSS JOIN names b ORDER BY 1, 2",
);

errorParity(
  "levenshtein does not exist before fuzzystrmatch is installed",
  [],
  "SELECT levenshtein('jon', 'john')",
  "undefined_function",
);
errorParity(
  "soundex does not exist before fuzzystrmatch is installed",
  [],
  "SELECT soundex('a')",
  "undefined_function",
);

sequenceParity(
  "CREATE EXTENSION IF NOT EXISTS fuzzystrmatch installs the functions and DROP removes them",
  [],
  [
    { sql: "CREATE EXTENSION IF NOT EXISTS fuzzystrmatch" },
    { sql: "CREATE EXTENSION IF NOT EXISTS fuzzystrmatch" },
    { sql: "SELECT levenshtein('jon', 'john') AS l, soundex('Robert') AS s", query: true },
    {
      sql: `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prorettype::regtype AS ret, p.proisstrict
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' ORDER BY 1, 2`,
      query: true,
    },
    { sql: "SELECT extname, extversion FROM pg_extension WHERE extname = 'fuzzystrmatch'", query: true },
    { sql: "DROP EXTENSION fuzzystrmatch" },
    { sql: "SELECT count(*) FROM pg_proc WHERE proname = 'levenshtein'", query: true },
  ],
);

parityTyped(
  "levenshtein with unit and custom costs",
  INSTALL,
  `SELECT levenshtein('jon', 'john') AS a, levenshtein('kitten', 'sitting') AS b, levenshtein('', '') AS c,
          levenshtein('abc', '') AS d, levenshtein('GUMBO', 'GAMBOL', 2, 1, 1) AS e, levenshtein('GUMBO', 'GAMBOL', 1, 1, 2) AS f,
          levenshtein('añb', 'anb') AS g, levenshtein(NULL, 'a') AS h, levenshtein('a', 'b', -1, -1, -1) AS i,
          levenshtein('ab', '', 2, 3, 4) AS j, levenshtein('', 'ab', 2, 3, 4) AS k`,
);

parity(
  "levenshtein costs wrap around like 32-bit integers",
  INSTALL,
  `SELECT levenshtein('abc', 'xyzw', 2147483647, 2147483647, 2147483647) AS a,
          levenshtein('abc', '', 2147483647, 2147483647, 2147483647) AS b,
          levenshtein('abcdef', 'x', 2000000000, 2000000000, 1) AS c`,
);

parityTyped(
  "levenshtein_less_equal is exact up to the bound and may exceed it beyond",
  INSTALL,
  `SELECT levenshtein_less_equal('jon', 'john', 2) AS a, levenshtein_less_equal('extensive', 'exhaustive', 2) AS b,
          levenshtein_less_equal('extensive', 'exhaustive', 4) AS c, levenshtein_less_equal('abc', 'xyz', 0) AS d,
          levenshtein_less_equal('GUMBO', 'GAMBOL', 2, 1, 1, 1) AS e, levenshtein_less_equal('abc', 'abd', -1) AS f,
          levenshtein_less_equal('abc', 'xyz', -5) AS g, levenshtein_less_equal('abc', 'xyzw', 1, 1, 1, -1) AS h,
          levenshtein_less_equal('abcdef', 'ab', 1, 1, 1, 1) AS i, levenshtein_less_equal('abcdef', 'ab', 0, 0, 0, 0) AS j,
          levenshtein_less_equal('kitten', 'sitting', 1, 1, 1, 2) AS k, levenshtein_less_equal('kitten', 'sitting', 1) AS l,
          levenshtein_less_equal('héllo', 'hallo', 0) AS m, levenshtein_less_equal('', repeat('a', 300), 1) AS n,
          levenshtein_less_equal('abc', 'xyzw', 2147483647, 2147483647, 2147483647, 5) AS o,
          levenshtein_less_equal('abc', 'abcd', 1, 1, 1, 2147483647) AS p, levenshtein_less_equal('abcdefgh', 'b', 1, 1, 1, 2147483647) AS q`,
);

parity(
  "levenshtein_less_equal agrees across bounds for a word list",
  [
    ...INSTALL,
    "CREATE TABLE pairs (a text, b text)",
    `INSERT INTO pairs VALUES ('kitten', 'sitting'), ('flaw', 'lawn'), ('saturday', 'sunday'), ('', 'abc'),
      ('abc', ''), ('intention', 'execution'), ('extensive', 'exhaustive'), ('héllo wörld', 'hello world'),
      ('a', 'a'), ('abcdefghij', 'jihgfedcba'), ('GUMBO', 'GAMBOL')`,
    "CREATE TABLE bounds (k int)",
    "INSERT INTO bounds VALUES (-1), (0), (1), (2), (3), (5), (8)",
  ],
  `SELECT a, b, k, levenshtein(a, b) AS l, levenshtein_less_equal(a, b, k) AS le,
          levenshtein_less_equal(a, b, 2, 1, 3, k) AS lec, levenshtein(a, b, 2, 1, 3) AS lc
   FROM pairs CROSS JOIN bounds ORDER BY a, b, k`,
);

parity(
  "levenshtein counts characters, not bytes, toward the 255 limit",
  INSTALL,
  "SELECT levenshtein(repeat('é', 255), 'a') AS a, levenshtein(repeat('é', 256), '') AS b, levenshtein('', repeat('a', 300)) AS c",
);

for (const [label, sql] of [
  ["levenshtein over 255 characters", "SELECT levenshtein(repeat('a', 256), 'a')"],
  ["levenshtein over 255 multibyte characters", "SELECT levenshtein(repeat('é', 256), 'a')"],
  ["levenshtein_less_equal over 255 characters", "SELECT levenshtein_less_equal(repeat('a', 300), 'b', 1)"],
  ["metaphone input over 255 bytes", "SELECT metaphone(repeat('a', 256), 3)"],
  ["metaphone multibyte input over 255 bytes", "SELECT metaphone(repeat('é', 128), 5)"],
  ["metaphone output over 255 bytes", "SELECT metaphone('abc', 256)"],
] as const) {
  errorParity(`${label} is rejected`, INSTALL, sql, "invalid_parameter");
}

for (const n of [0, -1]) {
  errorParity(
    `metaphone with max length ${n} is an empty-output error`,
    INSTALL,
    `SELECT metaphone('abc', ${n})`,
    "data_exception",
  );
}

parity(
  "metaphone of an empty string skips the length checks",
  INSTALL,
  "SELECT metaphone('', 0) AS a, metaphone('', 300) AS b, metaphone(repeat('é', 127), 5) AS c",
);

parityTyped(
  "fuzzystrmatch result types and NULL handling",
  INSTALL,
  `SELECT metaphone('a', 1) AS a, soundex('a') AS b, levenshtein('a', 'b') AS c, difference('a', 'b') AS d,
          difference('', '') AS e, difference('a', '') AS f, soundex(NULL) AS g, difference(NULL, 'a') AS h,
          metaphone(NULL, 4) AS i, levenshtein_less_equal('a', NULL, 1) AS j`,
);

errorParity(
  "levenshtein has no integer overload",
  INSTALL,
  "SELECT levenshtein(2147483647::int, 1)",
  "undefined_function",
);

// Engine-only: the oracle implements these, the engine refuses them loudly instead of guessing.
test("dmetaphone, dmetaphone_alt and daitch_mokotoff fail with 0A000 once fuzzystrmatch is installed", () => {
  const db = new Database();
  try {
    db.exec("CREATE EXTENSION fuzzystrmatch");
    for (const fn of ["dmetaphone", "dmetaphone_alt", "daitch_mokotoff"]) {
      let sqlState: string | undefined;
      try {
        db.prepare(`SELECT ${fn}('Thompson')`).all();
      } catch (error) {
        sqlState = (error as { sqlState?: string }).sqlState;
      }
      expect(sqlState).toBe("0A000");
    }
  } finally {
    db.close();
  }
});
