// Generate the Astro inputs straight from a WXR file (used for the image build
// and local development, when there is no database):
//   node server/generate-cli.js [file.xml]
import { readFileSync } from "node:fs";
import { parseWxr } from "./wxr.js";
import { generate, loadConfig, loadRenderCache } from "./generate.js";

const root = process.cwd();
const config = loadConfig(root);
const file = process.argv[2] || config.baseline;
const site = parseWxr(readFileSync(file, "utf-8"));
const stats = generate(site, root, { ...config, renderCache: loadRenderCache(root) });
console.log(`generated from ${file}:`, JSON.stringify({ ...stats, skipped: stats.skipped.length }));
if (stats.skipped.length) console.log("skipped (reserved or duplicate address):", stats.skipped.join(", "));
