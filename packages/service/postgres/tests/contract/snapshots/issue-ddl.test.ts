import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";

test("matview indexes and constraint trigger definitions survive encoded snapshots (#431, #432)", () => {
  const source = new Database();
  source.exec("CREATE TABLE entries(id int); INSERT INTO entries VALUES (1)");
  source.exec("CREATE MATERIALIZED VIEW saved_rows AS SELECT id FROM entries WITH NO DATA");
  source.exec("CREATE UNIQUE INDEX saved_unique ON saved_rows(id)");
  source.exec(
    "CREATE FUNCTION check_entries() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM entries WHERE id < 0) THEN RAISE EXCEPTION 'invalid'; END IF; RETURN NEW; END $$",
  );
  source.exec(
    "CREATE CONSTRAINT TRIGGER validate_entry AFTER INSERT OR UPDATE OR DELETE ON entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entries()",
  );
  const restored = Snapshot.decode(source.snapshot().encode()).open();
  const isolated = new Database();
  expect(isolated.query("SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'saved_unique'")).toEqual([{ n: 0n }]);
  restored.exec("REFRESH MATERIALIZED VIEW saved_rows");
  expect(restored.query("SELECT * FROM saved_rows")).toEqual([{ id: 1 }]);
  expect(restored.query("SELECT indexname FROM pg_indexes WHERE tablename = 'saved_rows'")).toEqual([
    { indexname: "saved_unique" },
  ]);
  restored.exec("INSERT INTO entries VALUES (1)");
  expect(() => restored.exec("REFRESH MATERIALIZED VIEW saved_rows")).toThrow();
  restored.exec("BEGIN; INSERT INTO entries VALUES (-1)");
  expect(() => restored.snapshot()).toThrow("cannot snapshot during a transaction");
  expect(() => restored.exec("COMMIT")).toThrow("invalid");
  expect(restored.query("SELECT * FROM entries WHERE id < 0")).toEqual([]);
  restored.exec("BEGIN; INSERT INTO entries VALUES (-2); DELETE FROM entries WHERE id < 0; COMMIT");
  source.exec("INSERT INTO entries VALUES (2)");
  expect(restored.query("SELECT * FROM entries WHERE id = 2")).toEqual([]);
  restored.close();
  source.close();
  isolated.close();
});
