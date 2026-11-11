import type { Db } from "../ports/db.js"

/** One statement per entry — the `Db` port runs a single statement per call, like a real pg client. */
const STATEMENTS = [
  `CREATE TABLE users (
    id uuid PRIMARY KEY,
    provider text NOT NULL,
    subject text NOT NULL,
    email text,
    name text,
    picture text,
    role text NOT NULL DEFAULT 'patient',
    notifications boolean NOT NULL DEFAULT true,
    phone text,
    phone_channel text NOT NULL DEFAULT 'sms',
    notify_email boolean NOT NULL DEFAULT true,
    notify_text boolean NOT NULL DEFAULT true,
    notify_push boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
  )`,
  `CREATE TABLE sign_in_codes (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    code_hash text NOT NULL,
    link_hash text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE push_devices (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id),
    platform text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE lab_tests (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    price_cents integer NOT NULL,
    catalog_test_id text NOT NULL
  )`,
  `CREATE TABLE orders (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id),
    status text NOT NULL,
    checkout_session_id text UNIQUE NOT NULL,
    lab_order_id text,
    interpretation text,
    results_json text NOT NULL DEFAULT '[]',
    reviewed_at timestamptz,
    review_note text,
    reviewer text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE order_events (
    id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders (id),
    status text NOT NULL, detail text NOT NULL, actor text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE audit_events (
    id uuid PRIMARY KEY, actor text NOT NULL, action text NOT NULL, target text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE order_items (
    id uuid PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders (id),
    lab_test_id uuid NOT NULL REFERENCES lab_tests (id),
    price_cents integer NOT NULL
  )`,
]

export const migrate = async (db: Db): Promise<void> => {
  for (const statement of STATEMENTS) await db.query(statement)
}
