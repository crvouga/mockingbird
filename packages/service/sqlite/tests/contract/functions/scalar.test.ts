import { parity } from "../helpers.ts";

parity("numeric scalar functions", [], "SELECT abs(-7) a,round(2.345,2) b,round(2.6) c");
parity(
  "NULL selection functions",
  [],
  "SELECT coalesce(NULL,NULL,'x') a,ifnull(NULL,'y') b,nullif(3,3) c,nullif(3,4) d",
);
parity(
  "typeof and length inspect values",
  [],
  "SELECT typeof(1) a,typeof(1.5) b,typeof('x') c,length('hé') d,length(X'0011') e",
);
parity(
  "case and trimming string functions",
  [],
  "SELECT lower('AbC') a,upper('AbC') b,trim('  hi  ') c,ltrim('xxhi','x') d,rtrim('hiyy','y') e",
);
parity(
  "substring and replacement functions",
  [],
  "SELECT substr('abcdef',2,3) a,substr('abcdef',-2) b,replace('a-b-a','a','x') c",
);
parity(
  "hex and quote expose SQL representations",
  [],
  "SELECT hex('Az') a,quote('O''Reilly') b,quote(NULL) c,quote(X'00FF') d",
);
