import { errorParity } from "../helpers.ts";

errorParity("zeroblob at SQLITE_MAX_LENGTH fails TOOBIG", [], "SELECT zeroblob(2147483647)");
errorParity("randomblob at SQLITE_MAX_LENGTH fails TOOBIG", [], "SELECT randomblob(2147483647)");
