import { parity, parityTyped, queryErrorParity } from "../helpers.ts";

// #692: the inet / cidr containment, bitwise and arithmetic operators and the functions on them.

parity(
  "inet containment and overlap",
  [],
  "SELECT ('10.0.0.5'::inet << '10.0.0.0/8'::cidr)::text AS contained, '10.0.0.0/8'::cidr >>= '10.0.0.0/8'::inet AS a, '10.0.0.0/8'::inet <<= '10.0.0.0/8' AS b, '10.1.0.0/16'::inet && '10.0.0.0/8'::inet AS c, '10.0.0.0/8'::cidr >> '10.1.2.3' AS d, '10.0.0.0/8'::inet << '10.0.0.0/8' AS e, '10.0.0.5'::inet << '::1/0'::inet AS f, '2001:db8::1'::inet << '2001:db8::/32' AS g, NULL::inet << '10.0.0.0/8' AS h",
);
parity(
  "inet bitwise operators and address arithmetic",
  [],
  "SELECT ~'10.0.0.5'::inet AS a, '10.0.0.5'::inet & '255.255.0.0' AS b, '10.0.0.5'::inet | '0.0.0.255' AS c, '10.0.0.5/24'::inet + 300 AS d, '10.0.0.5'::inet - 6 AS e, '10.0.0.5'::inet - '10.0.0.1'::inet AS f, 5 + '10.0.0.5/16'::inet AS g, '10.0.0.0/8'::cidr + 1 AS h, '::1'::inet + 65535 AS i, ~'::1'::inet AS j",
);
parityTyped(
  "inet operator result types",
  [],
  "SELECT '10.0.0.0/8'::cidr + 1 AS a, '10.0.0.5'::inet - '10.0.0.1'::inet AS b, ~'10.0.0.0/8'::cidr AS c, '10.0.0.5'::inet & '255.0.0.0'::inet AS d",
);
parity(
  "inet functions on the same arithmetic",
  [],
  "SELECT inet_same_family('1.2.3.4', '::1') AS a, inet_same_family('1.2.3.4', '10.0.0.0/8') AS b, inet_merge('10.0.0.5', '10.1.0.0/16') AS c, inet_merge('192.168.1.5/24', '192.168.2.5/24') AS d, hostmask('192.168.1.5/20') AS e, hostmask('2001:db8::/120') AS f, set_masklen('192.168.1.5/24'::inet, 16) AS g, set_masklen('192.168.1.0/24'::cidr, 16) AS h, set_masklen('10.0.0.1/8'::inet, -1) AS i",
);
parity(
  "inet operators filter a table",
  [
    "CREATE TABLE hosts (id int PRIMARY KEY, addr inet)",
    "INSERT INTO hosts VALUES (1, '10.0.0.5'), (2, '10.1.2.3/16'), (3, '192.168.1.1'), (4, '::1')",
  ],
  "SELECT id FROM hosts WHERE addr << '10.0.0.0/8' OR addr <<= '::1/128' ORDER BY id",
);
queryErrorParity("inet address overflow", [], "SELECT '255.255.255.255'::inet + 1", "numeric_out_of_range");
queryErrorParity("inet address underflow", [], "SELECT '0.0.0.0'::inet - 1", "numeric_out_of_range");
queryErrorParity("inet AND of different families", [], "SELECT '1.2.3.4'::inet & '::1'::inet");
queryErrorParity("inet subtraction of different families", [], "SELECT '1.2.3.4'::inet - '::1'::inet");
queryErrorParity("inet_merge of different families", [], "SELECT inet_merge('1.2.3.4', '::1')");
queryErrorParity("set_masklen out of range", [], "SELECT set_masklen('1.2.3.4'::inet, 33)");
queryErrorParity("no inet + inet operator", [], "SELECT '1.2.3.4'::inet + '1.2.3.4'::inet", "undefined_function");
