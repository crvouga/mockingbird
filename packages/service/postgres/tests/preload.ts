import { setDefaultTimeout } from "bun:test";

// The first oracle test in a file waits for PGlite to boot with its extensions
// (pgcrypto, pg_trgm, fuzzystrmatch, pgvector), which can pass bun's 5s default on a busy machine.
setDefaultTimeout(30_000);
