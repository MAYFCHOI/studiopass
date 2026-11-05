import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { seedIfEmpty } from './domain/seed.js';
import { createApp } from './app.js';
import { loadAlimtalkConfig } from './notify/alimtalk.js';
import { loadTossConfig } from './toss/config.js';
import { startToss } from './toss/runner.js';
import { passNotifier } from './notify/link.js';
import type { Deps } from './routes/common.js';
if (process.env.NODE_ENV === 'production' && !process.env.SP_ORIGIN?.trim()) {
  // Without it the CSRF origin check is off and member links / alimtalk cannot be built.
  console.error('studiopass: SP_ORIGIN is required when NODE_ENV=production (e.g. SP_ORIGIN=https://studio.example.com). Not starting.');
  process.exit(1);
}
const file = process.env.SP_DB ?? 'data/studiopass.db';
mkdirSync(dirname(file), { recursive: true });
const db = openDb(file); seedIfEmpty(db);
db.prepare('delete from sessions where expires_at < ?').run(new Date().toISOString());
const alimtalk = loadAlimtalkConfig(process.env);
const deps: Deps = { db, alimtalk, secureCookies: process.env.NODE_ENV === 'production', allowedOrigin: process.env.SP_ORIGIN ?? null, staticDir: process.env.SP_STATIC };
const toss = loadTossConfig(process.env);
if (toss.enabled) deps.toss = { cfg: toss, onReceived: startToss(db, toss, passNotifier(deps)).onReceived };
const app = createApp(deps);
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787), hostname: '0.0.0.0' });
console.log(`studiopass api listening (alimtalk ${alimtalk.enabled ? 'on' : 'off'}, toss ${toss.enabled ? 'on' : 'off'})`);
