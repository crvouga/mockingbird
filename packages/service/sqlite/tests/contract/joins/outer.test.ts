import { parity } from "../helpers.ts";

const data = [
  "CREATE TABLE users(id INTEGER, name TEXT)",
  "CREATE TABLE posts(id INTEGER, user_id INTEGER, title TEXT)",
  "INSERT INTO users VALUES (1,'Ada'),(2,'Bob'),(3,'Cy')",
  "INSERT INTO posts VALUES (10,1,'A'),(11,1,'B'),(12,2,'C'),(13,NULL,'D')",
];

parity(
  "RIGHT JOIN null-extends missing left matches",
  data,
  "SELECT u.name, p.title FROM users u RIGHT JOIN posts p ON p.user_id = u.id ORDER BY p.id",
);

parity(
  "FULL OUTER JOIN includes unmatched from both sides",
  data,
  "SELECT u.name, p.title FROM users u FULL OUTER JOIN posts p ON p.user_id = u.id ORDER BY COALESCE(u.id, 99), p.id",
);
