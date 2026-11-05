/** Connections: list, add, detail, rename, sync, rotate key, delete, demo. Owner: Experience (routes). */

import type { Hono } from 'hono';
import { getConnectionDetail, listConnectionSummaries } from '../data/connections';
import type { ConnectionDetail } from '../data/types';
import type { AppEnv } from '../env';
import { currentUser, requireUser } from '../lib/auth';
import { redirectWithFlash } from '../lib/flash';
import { formatNumber } from '../lib/money';
import { getProviderMeta } from '../providers/registry';
import { isProviderId, type ProviderMeta } from '../providers/types';
import {
  createConnection,
  deleteConnection,
  renameConnection,
  rotateCredentials,
  triggerSync,
} from '../services/connections';
import { ConnectionDetailPage, type ConnectionDetailPageProps } from '../views/pages/connection-detail';
import { ConnectionsPage, NewConnectionPage, ProviderPickerPage } from '../views/pages/connections';
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

/** Success with caveats (e.g. a full-access key) reads as info, not a green all-clear. */
function toneFor(warnings: string[]): 'success' | 'info' {
  return warnings.length > 0 ? 'info' : 'success';
}

function withWarnings(message: string, warnings: string[]): string {
  return [message, ...warnings].join(' ');
}

function renderDetail(
  c: AppContext,
  detail: ConnectionDetail,
  opts: { rotate?: ConnectionDetailPageProps['rotate']; status?: 200 | 422 } = {},
) {
  // Never meta-refresh a page that carries form errors: the refresh would wipe them.
  const sync = opts.rotate
    ? null
    : syncState(awaitingFirstSync(detail), parsePoll(c.req.query('poll')), (n) => `/connections/${detail.id}?poll=${n}`);
  return c.html(
    <ConnectionDetailPage chrome={chrome(c)} detail={detail} sync={sync} rotate={opts.rotate} />,
    opts.status ?? 200,
  );
}

export function registerConnectionRoutes(app: Hono<AppEnv>): void {
  app.get('/connections', requireUser, async (c) => {
    const connections = await listConnectionSummaries(c.env, currentUser(c).id);
    return c.html(<ConnectionsPage chrome={chrome(c)} connections={connections} />);
  });

  // Registered before /connections/:id.
  app.get('/connections/new', requireUser, (c) => {
    const provider = c.req.query('provider');
    if (provider === undefined) return c.html(<ProviderPickerPage chrome={chrome(c)} />);
    if (!isProviderId(provider)) return c.notFound();
    return c.html(<NewConnectionPage chrome={chrome(c)} meta={getProviderMeta(provider)} />);
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
      return c.html(
        <NewConnectionPage
          chrome={chrome(c)}
          meta={meta}
          values={nonSecretValues(meta, raw, name)}
          fieldErrors={result.fieldErrors}
          error={result.error}
        />,
        422,
      );
    }
    // A first connection goes straight to the dashboard (the number is the point); later ones
    // land on their own page, where the sync status and any permission warnings live.
    const first = (await listConnectionSummaries(c.env, user.id)).length === 1;
    return redirectWithFlash(
      c,
      first ? '/dashboard?first=1' : `/connections/${result.id}`,
      toneFor(result.warnings),
      withWarnings('Connected. First numbers in a few seconds.', result.warnings),
    );
  });

  app.post('/connections/demo', requireUser, formLimit, async (c) => {
    const userId = currentUser(c).id;
    const result = await createConnection(c.env, execCtx(c), userId, 'demo', 'Demo data', {});
    if (!result.ok) return redirectWithFlash(c, '/connections', 'error', result.error);
    const first = (await listConnectionSummaries(c.env, userId)).length === 1;
    return redirectWithFlash(
      c,
      first ? '/dashboard?first=1' : '/dashboard',
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
    if (!name) return redirectWithFlash(c, back, 'error', 'Enter a name.');
    const ok = await renameConnection(c.env, currentUser(c).id, id, name);
    if (!ok) return c.notFound();
    return redirectWithFlash(c, back, 'success', 'Renamed.');
  });

  app.post('/connections/:id/sync', requireUser, formLimit, async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.notFound();
    const back = `/connections/${id}`;
    const r = await triggerSync(c.env, currentUser(c).id, id);
    if (!r.ok) return redirectWithFlash(c, back, 'error', r.error);
    if (!r.result.ok) return redirectWithFlash(c, back, 'error', r.result.error ?? 'Sync failed. Try again in a minute.');
    const n = r.result.events;
    return redirectWithFlash(c, back, 'success', `Synced. ${formatNumber(n)} revenue ${n === 1 ? 'event' : 'events'} processed.`);
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
    const result = await rotateCredentials(c.env, execCtx(c), user.id, id, raw);
    if (!result.ok) {
      return renderDetail(c, detail, {
        rotate: { error: result.error, fieldErrors: result.fieldErrors, values: nonSecretValues(meta, raw) },
        status: 422,
      });
    }
    return redirectWithFlash(c, back, toneFor(result.warnings), withWarnings('Key replaced. Syncing with the new key.', result.warnings));
  });

  app.post('/connections/:id/delete', requireUser, formLimit, async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.notFound();
    const form = await readForm(c);
    if (form.text('confirm', 8) !== 'yes') {
      return redirectWithFlash(c, `/connections/${id}`, 'error', 'Tick the confirmation box to delete this connection.');
    }
    const ok = await deleteConnection(c.env, currentUser(c).id, id);
    if (!ok) return c.notFound();
    return redirectWithFlash(c, '/connections', 'success', 'Connection deleted.');
  });
}
