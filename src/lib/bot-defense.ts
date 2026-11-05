/**
 * Bot checks for the log-in and sign-up forms. Owner: Lead. See SPEC.md §8.
 *
 * - A honeypot field: hidden from people (and from assistive tech), so only a bot that fills in
 *   every input sends it. Needs no JavaScript.
 * - Cloudflare Turnstile, optional: on when both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are
 *   set. Off by default, which keeps a self-hosted instance free of third-party scripts.
 */

import type { Bindings } from '../env';

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const SITEVERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;
/** Form field the widget writes its token into (Turnstile's default name). */
export const TURNSTILE_FIELD = 'cf-turnstile-response';
/** Turnstile tokens are at most 2048 characters. */
export const TURNSTILE_TOKEN_MAX = 2048;
const SITEVERIFY_TIMEOUT_MS = 5_000;

/**
 * The honeypot's name. Something a form-filling bot can't resist, that browsers and password
 * managers have no autofill type for (and they skip `display: none` fields anyway).
 */
export const HONEYPOT_FIELD = 'website';

export type BotAction = 'login' | 'signup';

/** The widget's public site key when Turnstile is fully configured, else null. */
export function turnstileSiteKey(env: Pick<Bindings, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>): string | null {
  const site = env.TURNSTILE_SITE_KEY?.trim();
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  return site && secret ? site : null;
}

export type TurnstileResult = 'ok' | 'missing' | 'failed' | 'unavailable';

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
}

/**
 * Checks a widget token with Siteverify. Tokens are single-use and live 5 minutes. Beyond
 * `success`, the token must have been issued for this form (`action`) on this site (`hostname`),
 * so a token solved on another page or site doesn't carry over.
 * Fails closed: if Siteverify can't be reached, the form is refused and the person can retry.
 */
export async function verifyTurnstile(
  env: Pick<Bindings, 'TURNSTILE_SECRET_KEY'>,
  token: string,
  opts: { ip: string; action: BotAction; hostname: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  if (!token) return 'missing';
  if (token.length > TURNSTILE_TOKEN_MAX) return 'failed';
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY ?? '', response: token });
  if (opts.ip && opts.ip !== 'unknown') body.set('remoteip', opts.ip);
  let data: SiteverifyResponse;
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
    data = (await res.json()) as SiteverifyResponse;
  } catch (err) {
    // Never log the token or the secret; the status or error name is enough to debug an outage.
    console.error(JSON.stringify({ event: 'turnstile_unavailable', message: err instanceof Error ? err.name : 'error' }));
    return 'unavailable';
  }
  if (data.success !== true) return 'failed';
  // Cloudflare's dummy test secrets answer with action "test" and hostname "localhost" for any
  // form; production secrets reject dummy tokens, so this only ever relaxes a test setup.
  if (isTestSecret(env.TURNSTILE_SECRET_KEY ?? '')) return 'ok';
  if (data.action !== opts.action || data.hostname !== opts.hostname) return 'failed';
  return 'ok';
}

/** Cloudflare's published Turnstile test secrets (1x… passes, 2x… fails, 3x… token spent). */
function isTestSecret(secret: string): boolean {
  return /^[123]x0{30,}AA$/.test(secret.trim());
}

/** What the form says for each outcome. */
export const TURNSTILE_MESSAGES: Record<Exclude<TurnstileResult, 'ok'>, string> = {
  missing: 'Wait for the security check below the form to finish, then try again.',
  failed: 'The security check didn’t pass. Try again.',
  unavailable: 'We couldn’t run the security check just now. Try again in a minute.',
};
