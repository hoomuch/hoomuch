/** 404 and 500 handlers. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../env';
import { loggablePath } from '../services/webhooks';
import { renderPage } from '../views/render';

export function registerErrorHandlers(app: Hono<AppEnv>): void {
  app.notFound((c) =>
    renderPage(c, 'notFound', { chrome: { user: c.get('user') ?? null, flash: c.get('flash') ?? null } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // Path + message only: never bodies, headers, cookies or secrets (a webhook URL's token is cut).
    console.error(
      JSON.stringify({ event: 'unhandled_error', path: loggablePath(new URL(c.req.url).pathname), message: String(err) }),
    );
    return renderPage(c, 'serverError', { chrome: { user: c.get('user') ?? null, flash: null } }, 500);
  });
}
