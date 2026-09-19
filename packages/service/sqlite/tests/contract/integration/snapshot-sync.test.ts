import { expect, test } from "bun:test";
import { Database } from "../../../src/index.ts";

test("SQLM synchronizes a supported schema and data corpus between databases", () => {
  const options = { seed: 0x5a17, now: new Date("2024-02-03T04:05:06.000Z") };
  const source = new Database(options);
  let replica: Database | undefined;
  try {
    source.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        balance REAL NOT NULL,
        avatar BLOB,
        note TEXT
      );
      CREATE TABLE events (
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (account_id, seq)
      ) WITHOUT ROWID;
      CREATE INDEX accounts_balance ON accounts(balance);
      CREATE VIEW positive_accounts AS
        SELECT id, email, balance FROM accounts WHERE balance > 0;
      INSERT INTO accounts(id, email, balance, avatar, note) VALUES
        (1, 'ada@example.test', 12.5, X'00FF', NULL),
        (2, 'grace@example.test', 0.0, X'', 'inactive');
      INSERT INTO events VALUES (1, 1, '{"kind":"created"}'), (1, 2, '{"kind":"credited"}');
    `);
    source.query("SELECT random() AS consumed");

    replica = source.snapshot().open();

    const checks = [
      "SELECT id, email, balance, hex(avatar) AS avatar, note FROM accounts ORDER BY id",
      "SELECT account_id, seq, payload FROM events ORDER BY account_id, seq",
      "SELECT * FROM positive_accounts ORDER BY id",
      "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      "SELECT name, type, \"notnull\", pk FROM pragma_table_info('accounts') ORDER BY cid",
      "SELECT name, \"unique\", origin, partial FROM pragma_index_list('accounts') ORDER BY name",
    ];
    for (const sql of checks) {
      expect(replica.query(sql)).toEqual(source.query(sql));
    }

    expect(replica.query("SELECT datetime('now') AS now")).toEqual(source.query("SELECT datetime('now') AS now"));
    expect(replica.query("SELECT random() AS value")).toEqual(source.query("SELECT random() AS value"));
    expect(replica.snapshot().encode()).toEqual(source.snapshot().encode());
  } finally {
    source.close();
    replica?.close();
  }
});

const snapshotCorpus = [
  { label: "null", literal: "NULL" },
  { label: "integer", literal: "9223372036854775807" },
  { label: "real", literal: "3.125" },
  { label: "text", literal: "'quote '' and unicode π'" },
  { label: "blob", literal: "X'0001FEFF'" },
] as const;

test.each(snapshotCorpus)("SQLM round-trips $label table data and indexes", ({ literal }) => {
  const source = new Database();
  try {
    source.exec(`
      CREATE TABLE corpus(id INTEGER PRIMARY KEY, value);
      CREATE INDEX corpus_value ON corpus(value);
      INSERT INTO corpus(value) VALUES (${literal});
    `);
    const restored = source.snapshot().open();
    expect(restored.query("SELECT id, typeof(value) AS storage, value FROM corpus")).toEqual(
      source.query("SELECT id, typeof(value) AS storage, value FROM corpus"),
    );
    expect(restored.query("SELECT name, origin FROM pragma_index_list('corpus') ORDER BY name")).toEqual(
      source.query("SELECT name, origin FROM pragma_index_list('corpus') ORDER BY name"),
    );
    restored.close();
  } finally {
    source.close();
  }
});
