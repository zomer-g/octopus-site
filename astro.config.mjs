import { defineConfig } from "astro/config";
import { existsSync, createReadStream } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const mediaDir = fileURLToPath(new URL("./media", import.meta.url));

// Archived uploads live in media/ (served by server/ in production) so every
// rebuild does not copy ~0.5GB of files. This serves them in `astro dev` too.
const serveMedia = {
  name: "serve-media",
  hooks: {
    "astro:server:setup": ({ server }) => {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url || "").split("?")[0]);
        if (!path.startsWith("/wp-content/")) return next();
        const file = normalize(join(mediaDir, path));
        if (!file.startsWith(mediaDir) || !existsSync(file)) return next();
        createReadStream(file).pipe(res);
      });
    },
  },
};

export default defineConfig({
  site: "https://octopus.org.il",
  trailingSlash: "always",
  build: { format: "directory" },
  integrations: [serveMedia],
});
