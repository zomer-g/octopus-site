// Fetch a URL that came from imported data without letting it reach the
// server's own network (SSRF): public http(s) addresses only, re-checked on
// every redirect, with a size cap.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 200 * 1024 * 1024;

function isPrivateIp(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true; // unique-local, link-local
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT / overlay networks
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("address not allowed");
}

export async function safeFetch(url, { timeoutMs = 120000, headers = {} } = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(current);
    const r = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      current = new URL(r.headers.get("location"), current).href;
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (Number(r.headers.get("content-length")) > MAX_BYTES) throw new Error("file too large");
    const chunks = [];
    let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error("file too large");
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), contentType: r.headers.get("content-type") || undefined };
  }
  throw new Error("too many redirects");
}
