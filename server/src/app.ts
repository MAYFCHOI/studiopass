import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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

export const BODY_LIMIT = 2 * 1024 * 1024;

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('/api/*', bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ error: 'TOO_LARGE' }, 413) }));
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
    // Hashed build assets never change under one name; HTML must be revalidated so a deploy takes effect at once.
    app.use('*', async (c, next) => {
      await next();
      if (c.req.path.startsWith('/assets/') && c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
      else if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) c.header('Cache-Control', 'no-cache');
      if (c.req.path.startsWith('/m/')) c.header('Referrer-Policy', 'no-referrer'); // the member token is in the path
    });
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
