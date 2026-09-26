import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE users(id INTEGER,name TEXT)",
  "CREATE TABLE posts(id INTEGER,user_id INTEGER,title TEXT)",
  "INSERT INTO users VALUES (1,'Ada'),(2,'Bob'),(3,'Cy')",
  "INSERT INTO posts VALUES (10,1,'A'),(11,1,'B'),(12,2,'C'),(13,NULL,'D')",
];

parity(
  "CROSS JOIN creates cartesian product",
  data,
  "SELECT u.id uid,p.id pid FROM users u CROSS JOIN posts p ORDER BY uid,pid",
);
parity(
  "INNER JOIN returns matching rows",
  data,
  "SELECT u.name,p.title FROM users u INNER JOIN posts p ON p.user_id=u.id ORDER BY p.id",
);
parity(
  "LEFT JOIN null-extends missing matches",
  data,
  "SELECT u.name,p.title FROM users u LEFT JOIN posts p ON p.user_id=u.id ORDER BY u.id,p.id",
);
parity(
  "join aliases qualify duplicate column names",
  data,
  "SELECT u.id AS user_id,p.id AS post_id FROM users AS u JOIN posts AS p ON u.id=p.user_id ORDER BY post_id",
);
