import { queryErrorParity } from "../helpers.ts";

queryErrorParity("REGEXP calls the missing regexp function", [], "SELECT 'value' REGEXP '^v'");
queryErrorParity("NOT REGEXP calls the missing regexp function", [], "SELECT 'value' NOT REGEXP '^x'");
