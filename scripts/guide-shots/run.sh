#!/usr/bin/env bash
# Retake the teacher-guide screenshots (docs/guide/img/*.jpg) from a local server with the real catalog and fake people.
# Needs: built app (npm run build, server: npm run build), Google Chrome, ssh studiopass (read-only catalog export).
# Usage: scripts/guide-shots/run.sh   then review docs/guide/img and run scripts/publish-guide.sh
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd); export ROOT=$(cd "$D/../.." && pwd)
W=$(mktemp -d); trap 'lsof -ti:8091 | xargs kill 2>/dev/null; rm -rf "$W"' EXIT
# Products, classes, instructors and tiers only. No member or payment rows leave the server.
ssh studiopass 'cd /srv/studiopass/app && sudo docker compose exec -T -w /app/server api node -e "
const D=require(\"better-sqlite3\");const db=new D(\"/data/studiopass.db\",{readonly:true});const o={};
for (const t of [\"instructors\",\"courses\",\"products\",\"tiers\"]) o[t]=db.prepare(\"select * from \"+t).all();console.log(JSON.stringify(o));"' > "$W/catalog.json"
[ -d "$W/node_modules/playwright-core" ] || (cd "$W" && npm init -y >/dev/null && npm i -s playwright-core@1.48.2 >/dev/null)
cp "$D"/seed-api.mjs "$D"/shots.mjs "$W"/
export SP_DB="$W/sp.db" SP_MIGRATIONS="$ROOT/server/migrations" ORIGIN=http://localhost:8091
for who in "create-owner owner 원장" "create-desk desk 인포"; do SP_PASSWORD=guide-password-1 node "$ROOT/server/dist/server/src/cli.js" $who >/dev/null; done
node "$D/seed-catalog.cjs" "$SP_DB" "$W/catalog.json"
NODE_ENV=production SP_STATIC="$ROOT/dist" SP_ORIGIN="$ORIGIN" PORT=8091 node "$ROOT/server/dist/server/src/main.js" >"$W/server.log" 2>&1 &
for _ in $(seq 1 50); do curl -fs $ORIGIN/api/healthz >/dev/null 2>&1 && break; sleep 0.2; done
(cd "$W" && node seed-api.mjs && node shots.mjs "$ROOT/docs/guide/img")
