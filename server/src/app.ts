import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { type AppEnv, type Deps } from './routes/common.js';
import { authRoutes, originGuard, sessionMiddleware } from './routes/auth.js';
import { publicRoutes } from './routes/public.js';
import { bootstrapRoutes } from './routes/bootstrap.js';
import { memberRoutes } from './routes/members.js';
import { paymentRoutes } from './routes/payments.js';
import { ownerRoutes } from './routes/owner.js';
export type { Deps } from './routes/common.js';

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('/api/*', originGuard(deps));
  app.use('/api/*', sessionMiddleware(deps));
  app.route('/api', publicRoutes(deps));
  app.route('/api/auth', authRoutes(deps));
  app.route('/api', bootstrapRoutes(deps));
  app.route('/api', memberRoutes(deps));
  app.route('/api', paymentRoutes(deps));
  app.route('/api', ownerRoutes(deps));
  app.all('/api/*', (c) => c.json({ error: 'NOT_FOUND' }, 404));

  if (deps.staticDir) {
    const dir = deps.staticDir;
    // serveStatic only takes a cwd-relative root.
    const root = relative(process.cwd(), dir) || '.';
    const page = (f: string) => { let html: string | null = null; return () => (html ??= readFileSync(join(dir, f), 'utf8')); };
    const memberHtml = page('member.html'), indexHtml = page('index.html');
    app.get('/m/*', (c) => c.html(memberHtml()));
    app.use('*', serveStatic({ root }));
    app.get('*', (c) => c.html(indexHtml()));
  }

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'INTERNAL' }, 500);
  });
  return app;
}
