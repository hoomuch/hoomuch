/** Connections: list, add, detail, rename, sync, rotate key, delete, demo. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { getConnectionDetail, listConnectionSummaries } from '../data/connections';
import type { ConnectionDetail } from '../data/types';
import type { AppEnv } from '../env';
import { currentUser, requireUser } from '../lib/auth';
import { redirectWithFlash } from '../lib/flash';
import { getProviderMeta } from '../providers/registry';
import { isProviderId, type ProviderMeta } from '../providers/types';
import {
  createConnection,
  deleteConnection,
  renameConnection,
  rotateCredentials,
  startSync,
} from '../services/connections';
import type { ConnectionDetailPageProps, ManualSyncState } from '../views/pages/connection-detail';
import {
  awaitingFirstSync,
  chrome,
  execCtx,
  formLimit,
  isUuid,
  parsePoll,
  readForm,
  syncState,
  type AppContext,
  type FormFields,
} from './util';
import { renderPage } from '../views/render';

/** services/connections cleans names down to 60 chars; this only bounds the input. */
const NAME_INPUT_MAX = 200;
/** registry.splitInput rejects values > 4096 chars with a clear message; this only bounds the input. */
const FIELD_INPUT_MAX = 8192;

/** Only the field names the provider declares; unknown form keys never reach the services. */
function collectFields(meta: ProviderMeta, form: FormFields): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const f of meta.fields) raw[f.name] = form.text(f.name, FIELD_INPUT_MAX);
  return raw;
}

/** Values safe to echo back into a form after an error: never a secret field. */
function nonSecretValues(meta: ProviderMeta, raw: Record<string, string>, name?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (name !== undefined) out['name'] = name;
  for (const f of meta.fields) {
    if (!f.secret && raw[f.name]) out[f.name] = raw[f.name]!;
  }
  return out;
}

function withWarnings(message: string, warnings: string[]): string {
  return [message, ...warnings].join(' ');
}

/** `?sync=` holds the moment a manual sync was requested (ms); anything else is ignored. */
function parseRequestedAt(v: string | undefined): number | null {
  return v && /^\d{12,14}$/.test(v) ? Number(v) : null;
}

/**
 * A sync the user started (Sync now, Replace key) runs in the background. The page refreshes
 * until a run that started at or after the request has finished, then shows how it went.
 */
function manualSyncState(c: AppContext, detail: ConnectionDetail, poll: number): ManualSyncState | null {
  const requestedAt = parseRequestedAt(c.req.query('sync'));
  if (requestedAt === null || awaitingFirstSync(detail)) return null;
  const why = c.req.query('why') === 'key' ? 'key' : 'sync';
  const run = detail.recentRuns.find((r) => r.startedAt >= requestedAt);
  if (run && run.finishedAt !== null && detail.status !== 'syncing') return { state: 'done', why, run };
  const keep = `sync=${requestedAt}${why === 'key' ? '&why=key' : ''}`;
  const sync = syncState(true, poll, (n) => `/connections/${detail.id}?${keep}&poll=${n}`)!;
  return { state: 'running', why, sync };
}

function renderDetail(
  c: AppContext,
  detail: ConnectionDetail,
  opts: { rotate?: ConnectionDetailPageProps['rotate']; status?: 200 | 422 } = {},
) {
  const poll = parsePoll(c.req.query('poll'));
  // Never meta-refresh a page that carries form errors: the refresh would wipe them.
  const sync = opts.rotate
    ? null
    : syncState(awaitingFirstSync(detail), poll, (n) => `/connections/${detail.id}?poll=${n}`);
  const manual = opts.rotate ? null : manualSyncState(c, detail, poll);
  return renderPage(c, 'connectionDetail', {
      chrome: chrome(c),
      detail,
      sync,
      manual,
      manageOpen: c.req.query('manage') === 'open',
      rotate: opts.rotate,
    }, opts.status ?? 200);
}

export function registerConnectionRoutes(app: Hono<AppEnv>): void {
  app.get('/connections', requireUser, async (c) => {
    const connections = await listConnectionSummaries(c.env, currentUser(c).id);
    return renderPage(c, 'connections', { chrome: chrome(c), connections });
  });

  // Registered before /connections/:id.
  app.get('/connections/new', requireUser, (c) => {
    const provider = c.req.query('provider');
    if (provider === undefined) return renderPage(c, 'providerPicker', { chrome: chrome(c) });
    if (!isProviderId(provider)) return c.notFound();
    return renderPage(c, 'newConnection', { chrome: chrome(c), meta: getProviderMeta(provider) });
  });

  app.post('/connections', requireUser, formLimit, async (c) => {
    const user = currentUser(c);
    const form = await readForm(c);
    const provider = form.text('provider', 32);
    if (!isProviderId(provider)) {
      return redirectWithFlash(c, '/connections/new', 'error', 'Pick a provider to connect.');
    }
    const meta = getProviderMeta(provider);
    const name = form.text('name', NAME_INPUT_MAX);
    const raw = collectFields(meta, form);

    const result = await createConnection(c.env, execCtx(c), user.id, provider, name || undefined, raw);
    if (!result.ok) {
      return renderPage(c, 'newConnection', {
          chrome: chrome(c),
          meta,
          values: nonSecretValues(meta, raw, name),
          fieldErrors: result.fieldErrors,
          error: result.error,
        }, 422);
    }
    // A first real connection goes straight to the dashboard (the number is the point); later
    // ones land on their own page. Either way the sync notice there confirms it, so there's no
    // "Connected." flash on top; only caveats (a full-access key, a missing permission) get one.
    const all = await listConnectionSummaries(c.env, user.id);
    const real = all.filter((x) => x.provider !== 'demo');
    const first = provider !== 'demo' && real.length === 1;
    // The first real connection replaces demo data, so the totals are real money from here on.
    // Demo data is one click to add back; a demo added after real connections is left alone.
    const demos = first ? all.filter((x) => x.provider === 'demo') : [];
    for (const d of demos) await deleteConnection(c.env, user.id, d.id);
    const to = first ? `/dashboard?first=1${demos.length > 0 ? '&demo=removed' : ''}` : `/connections/${result.id}`;
    return result.warnings.length > 0
      ? redirectWithFlash(c, to, 'info', result.warnings.join(' '))
      : c.redirect(to, 303);
  });

  app.post('/connections/demo', requireUser, formLimit, async (c) => {
    const userId = currentUser(c).id;
    const result = await createConnection(c.env, execCtx(c), userId, 'demo', 'Demo data', {});
    if (!result.ok) return redirectWithFlash(c, '/connections', 'error', result.error);
    // No ?first=1: the celebration is for real numbers. The flash is this event's one message.
    return redirectWithFlash(
      c,
      '/dashboard',
      'success',
      withWarnings('Demo data added. It’s fake money, but the math is real.', result.warnings),
    );
  });

  app.get('/connections/:id', requireUser, async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.notFound();
    const detail = await getConnectionDetail(c.env, currentUser(c), id);
    if (!detail) return c.notFound();
    return renderDetail(c, detail);
  });

  app.post('/connections/:id/rename', requireUser, formLimit, async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.notFound();
    const form = await readForm(c);
    const name = form.text('name', NAME_INPUT_MAX);
    const back = `/connections/${id}`;
    // Errors reopen the Manage section, where the form is.
    if (!name) return redirectWithFlash(c, `${back}?manage=open`, 'error', 'Enter a name.');
    const ok = await renameConnection(c.env, currentUser(c).id, id, name);
    if (!ok) return c.notFound();
    return redirectWithFlash(c, back, 'success', 'Saved.');
  });

  app.post('/connections/:id/sync', requireUser, formLimit, async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.notFound();
    const back = `/connections/${id}`;
    // Returns at once; the page shows the sync running and then its result (no 20 s wait).
    const r = await startSync(c.env, execCtx(c), currentUser(c).id, id);
    if (!r.ok) return redirectWithFlash(c, back, 'error', r.error);
    return c.redirect(`${back}?sync=${r.requestedAt}`, 303);
  });

  app.post('/connections/:id/rotate', requireUser, formLimit, async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.notFound();
    const user = currentUser(c);
    const detail = await getConnectionDetail(c.env, user, id);
    if (!detail) return c.notFound();
    const meta = getProviderMeta(detail.provider);
    const back = `/connections/${id}`;
    if (meta.fields.length === 0) return redirectWithFlash(c, back, 'error', 'This connection has no key to replace.');

    const raw = collectFields(meta, await readForm(c));
    const requestedAt = Date.now();
    const result = await rotateCredentials(c.env, execCtx(c), user.id, id, raw);
    if (!result.ok) {
      return renderDetail(c, detail, {
        rotate: { error: result.error, fieldErrors: result.fieldErrors, values: nonSecretValues(meta, raw) },
        status: 422,
      });
    }
    // The page's sync notice says "Key replaced." and follows the sync; a flash only for caveats.
    const to = `${back}?sync=${requestedAt}&why=key`;
    return result.warnings.length > 0 ? redirectWithFlash(c, to, 'info', result.warnings.join(' ')) : c.redirect(to, 303);
  });

  app.post('/connections/:id/delete', requireUser, formLimit, async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.notFound();
    const user = currentUser(c);
    const form = await readForm(c);
    const detail = await getConnectionDetail(c.env, user, id);
    if (!detail) return c.notFound();
    // Demo data is one click to add back, so removing it needs no confirmation: it offers an
    // Undo instead. A real connection's key and history can't come back, so it keeps the box.
    if (detail.provider === 'demo') {
      await deleteConnection(c.env, user.id, id);
      const to = form.text('back', 16) === '/dashboard' ? '/dashboard' : '/connections';
      return redirectWithFlash(c, to, 'success', 'Demo data removed.', { label: 'Add it back', action: '/connections/demo' });
    }
    if (form.text('confirm', 8) !== 'yes') {
      return redirectWithFlash(c, `/connections/${id}?manage=open`, 'error', 'Tick the box to confirm.');
    }
    const ok = await deleteConnection(c.env, user.id, id);
    if (!ok) return c.notFound();
    return redirectWithFlash(c, '/connections', 'success', 'Connection deleted.');
  });
}
