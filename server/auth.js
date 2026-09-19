// Sign-in through the xhostd identity gateway (Google). The gateway sets the
// __Host-xhost_id cookie (RS256 JWT); every request still reaches us, so this
// check is the only thing guarding /admin and /api.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { db } from "./db.js";

const COOKIE = "__Host-xhost_id";
const ISSUER = "https://auth.xhostd.com";
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/xhost-auth/jwks`));

// Local testing only: never active when DATABASE_URL is set (i.e. on xhostd).
const DEV_EMAIL = !process.env.DATABASE_URL && process.env.DEV_ADMIN_EMAIL;

function cookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function currentUser(req) {
  if (DEV_EMAIL) return { email: DEV_EMAIL, name: "dev", sub: "dev" };
  const token = cookie(req, COOKIE);
  if (!token) return null;
  try {
    const host = (req.headers.host || "").split(":")[0];
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: host, // the channel hostname or custom domain the browser used
      algorithms: ["RS256"],
      clockTolerance: 60,
      requiredClaims: ["exp", "sub", "email"],
    });
    return { email: String(payload.email).toLowerCase(), name: payload.name, sub: payload.sub };
  } catch (e) {
    console.warn("identity cookie rejected:", e.code || e.message);
    return null;
  }
}

/** Editors = ADMIN_EMAILS env (always allowed) + the editors table. */
export async function isEditor(email) {
  const env = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (env.includes(email)) return true;
  return !!(await db.one("SELECT 1 FROM editors WHERE email = $1", [email]));
}

export const loginUrl = (returnTo = "/admin/") => `/xhost-auth/login?return_to=${encodeURIComponent(returnTo)}`;
