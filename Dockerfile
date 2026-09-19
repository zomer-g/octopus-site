# Octopus site: Astro static build + Node server with the /admin editor.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production ASTRO_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# archived uploads (~0.5GB) change rarely: own layer so code edits reuse it
COPY media ./media

COPY . .
# baseline site (archived content only); stored edits are applied on boot
RUN npm run build

CMD ["node", "server/index.js"]
