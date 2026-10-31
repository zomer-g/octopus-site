// Temporary API tokens, so an agent or a script can add drafts and files
// without a browser sign-in. An editor creates one in /admin; only its SHA-256
// is stored, and it works until it expires or is revoked.
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.js";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS api_tokens (
     id bigserial PRIMARY KEY,
     name text NOT NULL,
     token_hash text NOT NULL UNIQUE,
     scope text NOT NULL DEFAULT 'drafts',
     created_by text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     revoked_at timestamptz,
     last_used_at timestamptz
   )`,
];

export const MAX_HOURS = 24 * 30;
const hash = (t) => createHash("sha256").update(t).digest("hex");

/** A new token; the plain value is returned once and never stored. */
export async function createToken({ name, hours, createdBy }) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), MAX_HOURS);
  const token = `oct_${randomBytes(32).toString("base64url")}`;
  const row = await db.one(
    `INSERT INTO api_tokens (name, token_hash, created_by, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))
     RETURNING id, name, scope, created_by, created_at, expires_at`,
    [String(name || "").trim().slice(0, 80) || "token", hash(token), createdBy, h],
  );
  return { ...row, token };
}

export const listTokens = () =>
  db.all(
    `SELECT id, name, scope, created_by, created_at, expires_at, revoked_at, last_used_at,
            (revoked_at IS NULL AND expires_at > now()) AS active
     FROM api_tokens ORDER BY id DESC LIMIT 100`,
  );

export const revokeToken = (id) => db.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);

/** The user a bearer token acts as, or null when it is unknown, expired or revoked. */
export async function userForToken(token) {
  if (!/^oct_[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const row = await db.one(
    `UPDATE api_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     RETURNING id, name, scope, created_by`,
    [hash(token)],
  );
  if (!row) return null;
  return { email: row.created_by, name: `token: ${row.name}`, sub: `token:${row.id}`, token: { id: Number(row.id), name: row.name, scope: row.scope } };
}
