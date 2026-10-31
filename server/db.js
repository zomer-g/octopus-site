// Postgres access. In production xhostd injects DATABASE_URL.
// For local testing without Postgres, LOCAL_PGLITE=<dir> uses an embedded PGlite.
import pg from "pg";
import { SCHEMA as CONTENT_SCHEMA } from "./store.js";
import { SCHEMA as TOKEN_SCHEMA } from "./tokens.js";
import { SCHEMA as VISIBILITY_SCHEMA } from "./visibility.js";

let impl;

async function init() {
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    impl = {
      query: (sql, params) => pool.query(sql, params),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const r = await fn({ query: (sql, params) => client.query(sql, params) });
          await client.query("COMMIT");
          return r;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
    };
  } else if (process.env.LOCAL_PGLITE) {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(process.env.LOCAL_PGLITE);
    impl = {
      query: (sql, params) => db.query(sql, params),
      tx: (fn) => db.transaction((t) => fn({ query: (sql, params) => t.query(sql, params) })),
    };
  } else {
    throw new Error("DATABASE_URL is not set (set LOCAL_PGLITE=.pglite for local testing)");
  }
  for (const stmt of [...SCHEMA, ...CONTENT_SCHEMA, ...TOKEN_SCHEMA, ...VISIBILITY_SCHEMA]) await impl.query(stmt);
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS editors (email text PRIMARY KEY, added_at timestamptz NOT NULL DEFAULT now(), added_by text)`,
  `CREATE TABLE IF NOT EXISTS builds (
     id bigserial PRIMARY KEY,
     started_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     status text NOT NULL,
     requested_by text,
     log text NOT NULL DEFAULT ''
   )`,
];

export const db = {
  init,
  query: (sql, params = []) => impl.query(sql, params),
  tx: (fn) => impl.tx(fn),
  async one(sql, params) {
    return (await impl.query(sql, params)).rows[0];
  },
  async all(sql, params) {
    return (await impl.query(sql, params)).rows;
  },
  async getSetting(key, fallback = null) {
    const r = await this.one("SELECT value FROM settings WHERE key = $1", [key]);
    return r ? r.value : fallback;
  },
  async setSetting(key, value) {
    await impl.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  },
};
