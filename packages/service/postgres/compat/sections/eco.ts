import { type CatalogSection, section } from "../scenario-types.ts";

const E = "ecosystem" as const;

export const ECO_SECTION: CatalogSection = section("ECO", "Ecosystem / ORM smoke", true, [
  ["prisma-01", "Prisma-style information_schema.columns introspection", E],
  ["drizzle-01", "Drizzle-style pg_catalog column and type introspection", E],
  ["kysely-01", "Kysely-style table listing from pg_class", E],
  ["knex-01", "knex-style CRUD round trip with RETURNING", E],
  ["typeorm-01", "TypeORM-style constraint introspection", E],
  ["mig-01", "migration-runner transactional DDL", E],
  ["crud-01", "ORM-style serial primary key insert flow", E],
  ["intro-01", "schema listing from information_schema.tables", E],
  ["intro-02", "sequence discovery via pg_sequences", E],
  ["param-01", "driver-style positional parameter binding", E],
]);
