import { expect, test } from "bun:test";
import { Database, Snapshot } from "../../../src/index.ts";
import { errorParity, sequenceParity } from "../helpers.ts";

const EVENTS = [
  "CREATE TABLE public.events (id integer, label text)",
  "CREATE TABLE public.event_counts (total bigint)",
];

// 1. statement trigger, NEW TABLE: one firing, whole statement's rows (the reported reproduction)
sequenceParity(
  "AFTER INSERT statement trigger reads the whole statement through its NEW TABLE",
  [
    "CREATE TABLE public.events (id integer)",
    "CREATE TABLE public.event_counts (total bigint)",
    `CREATE FUNCTION public.count_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.event_counts SELECT count(*) FROM inserted;
  RETURN NULL;
END
$$`,
  ],
  [
    {
      sql: `CREATE TRIGGER count_inserted
AFTER INSERT ON public.events
REFERENCING NEW TABLE AS inserted
FOR EACH STATEMENT EXECUTE FUNCTION public.count_inserted()`,
    },
    { sql: "INSERT INTO public.events VALUES (1), (2)" },
    { sql: "INSERT INTO public.events SELECT g FROM generate_series(10, 14) AS g" },
    { sql: "SELECT total FROM public.event_counts ORDER BY total", query: true },
  ],
);

// 2. AFTER DELETE with OLD TABLE
sequenceParity(
  "AFTER DELETE statement trigger sees exactly the deleted rows once through its OLD TABLE",
  [
    ...EVENTS,
    "CREATE TABLE public.deleted_log (n bigint, ids text)",
    `CREATE FUNCTION public.log_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.deleted_log SELECT count(*), string_agg(id::text, ',' ORDER BY id) FROM gone;
  RETURN NULL;
END
$$`,
    "CREATE TRIGGER log_deleted AFTER DELETE ON public.events REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION public.log_deleted()",
    "INSERT INTO public.events VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')",
  ],
  [
    { sql: "DELETE FROM public.events WHERE id IN (2, 4)" },
    { sql: "DELETE FROM public.events WHERE id = 99" },
    { sql: "SELECT n, ids FROM public.deleted_log ORDER BY n", query: true },
    { sql: "SELECT id FROM public.events ORDER BY id", query: true },
  ],
);

// 3. AFTER UPDATE with both aliases
sequenceParity(
  "AFTER UPDATE statement trigger exposes the before and after row sets through OLD and NEW TABLE",
  [
    ...EVENTS,
    "CREATE TABLE public.audit (id integer, before_label text, after_label text)",
    `CREATE FUNCTION public.audit_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.audit SELECT o.id, o.label, n.label FROM before_rows o JOIN after_rows n ON o.id = n.id;
  RETURN NULL;
END
$$`,
    `CREATE TRIGGER audit_update AFTER UPDATE ON public.events
REFERENCING OLD TABLE AS before_rows NEW TABLE AS after_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_update()`,
    "INSERT INTO public.events VALUES (1, 'a'), (2, 'b'), (3, 'c')",
  ],
  [
    { sql: "UPDATE public.events SET label = label || '!' WHERE id < 3" },
    { sql: "UPDATE public.events SET label = 'none' WHERE id > 100" },
    { sql: "SELECT id, before_label, after_label FROM public.audit ORDER BY id", query: true },
  ],
);

// 4. quoted aliases are case-sensitive
sequenceParity(
  "quoted transition table names are case-sensitive and optional AS is accepted",
  [
    ...EVENTS,
    `CREATE FUNCTION public.count_quoted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.event_counts SELECT count(*) FROM "Fresh Rows";
  RETURN NULL;
END
$$`,
    `CREATE TRIGGER count_quoted AFTER INSERT ON public.events
REFERENCING NEW TABLE "Fresh Rows"
FOR EACH STATEMENT EXECUTE FUNCTION public.count_quoted()`,
  ],
  [
    { sql: "INSERT INTO public.events VALUES (1, 'a'), (2, 'b'), (3, 'c')" },
    { sql: "SELECT total FROM public.event_counts", query: true },
  ],
);

sequenceParity(
  "an unquoted transition table name folds to lower case",
  [
    ...EVENTS,
    `CREATE FUNCTION public.count_folded() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.event_counts SELECT count(*) FROM fresh_rows;
  RETURN NULL;
END
$$`,
    `CREATE TRIGGER count_folded AFTER INSERT ON public.events
REFERENCING NEW TABLE AS Fresh_Rows
FOR EACH STATEMENT EXECUTE FUNCTION public.count_folded()`,
  ],
  [
    { sql: "INSERT INTO public.events VALUES (1, 'a'), (2, 'b')" },
    { sql: "SELECT total FROM public.event_counts", query: true },
  ],
);

// statement triggers fire once per statement, even for zero rows
sequenceParity(
  "statement triggers fire once per statement, including statements that change no rows",
  [
    "CREATE TABLE public.events (id integer)",
    "CREATE TABLE public.fired (tag text)",
    `CREATE FUNCTION public.note_before() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.fired VALUES ('before');
  RETURN NULL;
END
$$`,
    `CREATE FUNCTION public.note_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.fired SELECT 'after ' || count(*) FROM moved;
  RETURN NULL;
END
$$`,
    "CREATE TRIGGER a_before BEFORE UPDATE ON public.events FOR EACH STATEMENT EXECUTE FUNCTION public.note_before()",
    "CREATE TRIGGER b_after AFTER UPDATE ON public.events REFERENCING NEW TABLE AS moved FOR EACH STATEMENT EXECUTE FUNCTION public.note_after()",
  ],
  [
    { sql: "UPDATE public.events SET id = id + 1" },
    { sql: "INSERT INTO public.events VALUES (1), (2), (3)" },
    { sql: "UPDATE public.events SET id = id + 10" },
    { sql: "UPDATE public.events SET id = id + 10 WHERE id > 1000" },
    { sql: "SELECT tag FROM public.fired ORDER BY tag", query: true },
  ],
);

sequenceParity(
  "INSERT ... ON CONFLICT DO UPDATE fires INSERT and UPDATE statement triggers with their own transition rows",
  [
    "CREATE TABLE public.events (id integer PRIMARY KEY, label text)",
    "CREATE TABLE public.fired (tag text)",
    `CREATE FUNCTION public.note_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.fired SELECT 'insert ' || count(*) FROM added;
  RETURN NULL;
END
$$`,
    `CREATE FUNCTION public.note_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.fired SELECT 'update ' || count(*) FROM was JOIN became ON was.id = became.id WHERE became.label = 'new';
  RETURN NULL;
END
$$`,
    "CREATE TRIGGER note_inserted AFTER INSERT ON public.events REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION public.note_inserted()",
    "CREATE TRIGGER note_updated AFTER UPDATE ON public.events REFERENCING OLD TABLE AS was NEW TABLE AS became FOR EACH STATEMENT EXECUTE FUNCTION public.note_updated()",
    "INSERT INTO public.events VALUES (1, 'old'), (2, 'old')",
    "DELETE FROM public.fired",
  ],
  [
    {
      sql: "INSERT INTO public.events VALUES (2, 'new'), (3, 'new'), (1, 'new') ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label",
    },
    { sql: "SELECT tag FROM public.fired ORDER BY tag", query: true },
  ],
);

// pg_trigger carries the names
sequenceParity(
  "pg_trigger records the transition table names",
  [
    ...EVENTS,
    `CREATE FUNCTION public.noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
    "CREATE TRIGGER t_ins AFTER INSERT ON public.events REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION public.noop()",
    "CREATE TRIGGER t_upd AFTER UPDATE ON public.events REFERENCING OLD TABLE AS o NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION public.noop()",
    "CREATE TRIGGER t_del AFTER DELETE ON public.events REFERENCING OLD TABLE o FOR EACH STATEMENT EXECUTE FUNCTION public.noop()",
    "CREATE TRIGGER t_plain AFTER DELETE ON public.events FOR EACH STATEMENT EXECUTE FUNCTION public.noop()",
  ],
  [{ sql: "SELECT tgname, tgoldtable, tgnewtable FROM pg_trigger ORDER BY tgname", query: true }],
);

// 5. invalid combinations
const NOOP = [
  "CREATE TABLE events (id int, label text)",
  "CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
];
const invalid: Array<[string, string, string]> = [
  [
    "BEFORE trigger",
    "CREATE TRIGGER x BEFORE INSERT ON events REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "42P17",
  ],
  [
    "more than one event",
    "CREATE TRIGGER x AFTER INSERT OR UPDATE ON events REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "0A000",
  ],
  [
    "column list",
    "CREATE TRIGGER x AFTER UPDATE OF label ON events REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "0A000",
  ],
  [
    "OLD TABLE on INSERT",
    "CREATE TRIGGER x AFTER INSERT ON events REFERENCING OLD TABLE AS o FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "42P17",
  ],
  [
    "NEW TABLE on DELETE",
    "CREATE TRIGGER x AFTER DELETE ON events REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "42P17",
  ],
  [
    "the same name for OLD and NEW",
    "CREATE TRIGGER x AFTER UPDATE ON events REFERENCING OLD TABLE AS t NEW TABLE AS t FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "42P17",
  ],
  [
    "NEW TABLE twice",
    "CREATE TRIGGER x AFTER UPDATE ON events REFERENCING NEW TABLE AS a NEW TABLE AS b FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "42P17",
  ],
  [
    "OLD TABLE twice",
    "CREATE TRIGGER x AFTER UPDATE ON events REFERENCING OLD TABLE AS a OLD TABLE AS b FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "42P17",
  ],
  [
    "ROW variables",
    "CREATE TRIGGER x AFTER UPDATE ON events REFERENCING OLD ROW AS r FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "0A000",
  ],
  [
    "TRUNCATE",
    "CREATE TRIGGER x AFTER TRUNCATE ON events REFERENCING OLD TABLE AS o FOR EACH STATEMENT EXECUTE FUNCTION noop()",
    "0A000",
  ],
];
for (const [name, sql] of invalid) {
  errorParity(`REFERENCING is rejected for ${name}`, NOOP, sql);
}

test("rejected REFERENCING clauses name PostgreSQL's SQLSTATE and install no trigger", () => {
  const db = new Database();
  for (const sql of NOOP) db.exec(sql);
  for (const [, sql, code] of invalid) {
    expect(() => db.exec(sql), sql).toThrow(expect.objectContaining({ code }));
  }
  expect(db.query("SELECT count(*)::int AS n FROM pg_trigger")).toEqual([{ n: 0 }]);
});

test("a constraint trigger takes no REFERENCING clause", () => {
  const db = new Database();
  for (const sql of NOOP) db.exec(sql);
  expect(() =>
    db.exec(
      "CREATE CONSTRAINT TRIGGER x AFTER INSERT ON events REFERENCING NEW TABLE AS n FOR EACH ROW EXECUTE FUNCTION noop()",
    ),
  ).toThrow(expect.objectContaining({ code: "42601" }));
});

test("a FOR EACH ROW trigger with transition tables fails loud instead of dropping the clause", () => {
  const db = new Database();
  for (const sql of NOOP) db.exec(sql);
  expect(() =>
    db.exec("CREATE TRIGGER x AFTER INSERT ON events REFERENCING NEW TABLE AS n FOR EACH ROW EXECUTE FUNCTION noop()"),
  ).toThrow(expect.objectContaining({ code: "0A000" }));
  expect(db.query("SELECT count(*)::int AS n FROM pg_trigger")).toEqual([{ n: 0 }]);
});

// 6. scoped per database, and survives a snapshot round trip
const SCOPED = [
  "CREATE TABLE events (id integer)",
  "CREATE TABLE event_counts (total bigint)",
  `CREATE FUNCTION count_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO event_counts SELECT count(*) FROM inserted;
  RETURN NULL;
END
$$`,
  "CREATE TRIGGER count_inserted AFTER INSERT ON events REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION count_inserted()",
];

test("transition-table triggers are scoped to their database", () => {
  const withTrigger = new Database();
  const plain = new Database();
  for (const sql of SCOPED) withTrigger.exec(sql);
  plain.exec("CREATE TABLE events (id integer)");
  plain.exec("CREATE TABLE event_counts (total bigint)");
  withTrigger.exec("INSERT INTO events VALUES (1), (2)");
  plain.exec("INSERT INTO events VALUES (1), (2), (3)");
  expect(withTrigger.query("SELECT total::int AS total FROM event_counts")).toEqual([{ total: 2 }]);
  expect(plain.query("SELECT total FROM event_counts")).toEqual([]);
});

test("transition-table triggers survive a snapshot encode and decode", () => {
  const source = new Database();
  for (const sql of SCOPED) source.exec(sql);
  const restored = Snapshot.decode(source.snapshot().encode()).open();
  restored.exec("INSERT INTO events VALUES (1), (2), (3)");
  expect(restored.query("SELECT total::int AS total FROM event_counts")).toEqual([{ total: 3 }]);
  expect(restored.query("SELECT tgname, tgnewtable FROM pg_trigger")).toEqual([
    { tgname: "count_inserted", tgnewtable: "inserted" },
  ]);
  // the source is untouched by what the restored copy did
  expect(source.query("SELECT total FROM event_counts")).toEqual([]);
});
