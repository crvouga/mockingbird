# Vendored SQLLogicTest subset for sqlite-mem

Format follows [sqllogictest](https://www.sqlite.org/sqllogictest/doc/trunk/about.wiki)
(`statement ok` / `statement error` / `query <types> <sortmode>`).

Files under `test/` are a **trimmed** dialect-parity corpus (not the full upstream tree).
Expand via:

```bash
bun run scripts/import-sqllogictest.ts
```

Upstream blessing (public domain / disclaim copyright) applies to records derived from SQLite SQLLogicTest.
