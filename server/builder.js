// Rebuilds the static site with the database overlay applied, then swaps it in.
// Workspace: <root>/.build (a copy of the source with overlay applied)
// Output:    <root>/.builds/<id>  (served once complete)
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.js";
import { generate, loadConfig, loadRenderCache } from "./generate.js";
import { loadSite } from "./store.js";

let ROOT;
let current; // directory currently served
let running = null; // promise of the running build
let queued = null; // { by } when another build was requested meanwhile
const listeners = new Set();

export function initBuilder(root, initialDir) {
  ROOT = root;
  current = initialDir;
}
export const currentDir = () => current;
export const isBuilding = () => !!running;
export const onSwap = (fn) => listeners.add(fn);

/** Ask for a rebuild. Requests during a build coalesce into one follow-up build. */
export function requestBuild(by) {
  if (running) {
    queued = { by };
    return;
  }
  running = runBuild(by)
    .catch((e) => console.error("build failed:", e))
    .finally(() => {
      running = null;
      if (queued) {
        const next = queued;
        queued = null;
        requestBuild(next.by);
      }
    });
}

function run(cmd, args, cwd, log) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" } });
    const push = (d) => log.push(d.toString());
    p.stdout.on("data", push);
    p.stderr.on("data", push);
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} exited with ${code}`))));
  });
}

async function prepareWorkspace() {
  const ws = join(ROOT, ".build");
  rmSync(join(ws, "src"), { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  cpSync(join(ROOT, "src"), join(ws, "src"), { recursive: true });
  for (const f of ["astro.config.mjs", "package.json", "tsconfig.json"]) cpSync(join(ROOT, f), join(ws, f));
  mkdirSync(join(ws, "public"), { recursive: true });
  if (existsSync(join(ROOT, "public"))) cpSync(join(ROOT, "public"), join(ws, "public"), { recursive: true });
  if (!existsSync(join(ws, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(ws, "node_modules"), "junction");

  // everything the site shows comes from the database (WordPress-shaped)
  const stats = generate(await loadSite(), ws, { ...(await siteOptions()), renderCache: renderCache() });
  return { ws, stats };
}

let cacheData;
const renderCache = () => (cacheData ??= loadRenderCache(ROOT));

/** Generator options: site.config.json defaults, overridden by DB settings. */
export async function siteOptions() {
  const config = loadConfig(ROOT);
  const s = (await db.getSetting("site_options")) ?? {};
  return { ...config, ...s, extraRedirects: { ...(config.extraRedirects ?? {}), ...(s.extraRedirects ?? {}) } };
}

async function runBuild(by) {
  const { id } = await db.one("INSERT INTO builds (status, requested_by) VALUES ('running', $1) RETURNING id", [by ?? null]);
  const log = [];
  const out = join(ROOT, ".builds", String(id));
  try {
    const { ws, stats } = await prepareWorkspace();
    log.push(`generated: ${JSON.stringify({ ...stats, skipped: stats.skipped.length })}
`);
    const node = process.execPath;
    await run(node, [join(ROOT, "node_modules/astro/bin/astro.mjs"), "build", "--root", ws, "--outDir", out], ws, log);
    await run(node, [join(ROOT, "node_modules/pagefind/lib/runner/bin.cjs"), "--site", out], ws, log);
    cpSync(join(ws, "src/data/routes.json"), join(out, "_routes.json"));
    const previous = current;
    current = out;
    listeners.forEach((fn) => fn(out));
    await db.query("UPDATE builds SET status = 'success', finished_at = now(), log = $2 WHERE id = $1", [id, tail(log)]);
    cleanup(previous);
  } catch (e) {
    log.push(String(e));
    await db.query("UPDATE builds SET status = 'failed', finished_at = now(), log = $2 WHERE id = $1", [id, tail(log)]);
    rmSync(out, { recursive: true, force: true });
    throw e;
  }
}

const tail = (log) => log.join("").replace(/\x1b\[[0-9;]*m/g, "").slice(-20000);

function cleanup(keep) {
  const dir = join(ROOT, ".builds");
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p !== current && p !== keep) rmSync(p, { recursive: true, force: true });
  }
}
