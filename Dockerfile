# Proviso: one Next.js app. The verifier drives headless Chromium through
# Playwright, so the base image is Playwright's own: it ships Chromium and
# every system library Chromium needs, for exactly one Playwright version.
# Keep this tag equal to the `playwright` version in pnpm-lock.yaml (1.65.0).
# The image's Node.js is 26; better-sqlite3 13 has no prebuilt binary for it
# and compiles during install, so the image needs make and a C++ compiler.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# The pnpm version from package.json "packageManager".
RUN npm install -g pnpm@11.7.0

WORKDIR /app

# Dependencies first, so source edits do not reinstall them. Dev dependencies
# stay installed: `next build` type-checks with TypeScript, and the start
# command runs scripts/db-init.ts and scripts/db-seed.ts through tsx.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production
# The server listens on $PORT (Render sets it), or 3000 when PORT is unset.
EXPOSE 3000

# SQLite (data/clause.db) and evidence screenshots (data/evidence/) are
# written under /app/data. Mount a persistent volume there or both are lost
# whenever the container is replaced.
#
# The container runs as root, as the Playwright image does by default;
# Playwright launches Chromium with --no-sandbox and --disable-dev-shm-usage.
#
# On every start (safe to rerun, and required when /app/data is empty or was
# wiped): create or migrate the database, upsert the two demo identities from
# DEMO_PAYER_EMAIL / DEMO_WORKER_EMAIL (seeding fails if either is unset, and
# the container stops), then serve on all interfaces.
CMD ["sh", "-c", "pnpm db:init && pnpm db:seed && exec ./node_modules/.bin/next start -H 0.0.0.0 -p \"${PORT:-3000}\""]
