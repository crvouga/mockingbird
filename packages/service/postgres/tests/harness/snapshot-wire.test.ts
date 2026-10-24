import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database, Snapshot } from "../../src/index.ts";

// Captured from the previous encoder before bulk numeric writes and UTF-8 reuse.
// Pin the wire bytes, not just a round trip through two potentially matching bugs.
test("optimized snapshot encoding preserves the existing binary format", () => {
  const db = new Database();
  db.exec(
    "CREATE TABLE wire_fixture(id INTEGER PRIMARY KEY, small INT, large BIGINT, real_value DOUBLE PRECISION, unique_text TEXT, repeated_text TEXT, payload BYTEA)",
  );
  const insert = db.prepare("INSERT INTO wire_fixture VALUES ($1, $2, $3, $4, $5, $6, $7)");
  db.transaction(() => {
    for (let i = 0; i < 129; i++)
      insert.run(
        i,
        i % 11 === 0 ? null : i - 70,
        i % 7 === 0 ? null : BigInt(i) * 4294967297n,
        i % 5 === 0 ? null : i / 8,
        i % 13 === 0 ? null : `row ${i}: café 🐦`,
        `group ${i % 4}`,
        i % 3 === 0 ? null : new Uint8Array([i & 255, 0, 255]),
      );
  });
  db.exec(`CREATE TABLE tagged(a numeric,b integer[],c jsonb,d boolean);
    INSERT INTO tagged VALUES (123456789012345678901234567890.12,ARRAY[1,2,3],'{"nested":"café 🐦"}',true),
    (NULL,ARRAY[]::integer[],'null',false)`);
  const bytes = db.snapshot().encode();
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "a3569be22fd2284c9aea3ba414c0708297d06fde804dfe2d15dc494c8f16d6ba",
  );
  const recovered = Snapshot.decode(bytes).open();
  expect(
    recovered.query(
      "SELECT id, small, large, real_value, unique_text, repeated_text, payload FROM wire_fixture ORDER BY id",
    ),
  ).toEqual(
    db.query("SELECT id, small, large, real_value, unique_text, repeated_text, payload FROM wire_fixture ORDER BY id"),
  );
  recovered.close();
  db.close();
});
