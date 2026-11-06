/**
 * Outgoing mail through Resend's HTTP API: one plain `fetch`, no SDK. Owner: Lead. See SPEC.md §8.
 *
 * Off unless RESEND_API_KEY is set, so a self-hosted instance without mail keeps working as
 * before (no verification step). Nothing here ever logs the recipient, the message or the key.
 */

import type { Bindings } from '../env';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAIL_TIMEOUT_MS = 10_000;

export type MailEnv = Pick<Bindings, 'RESEND_API_KEY' | 'MAIL_FROM'>;

/** True when the instance can send mail, which also switches email verification on. */
export function mailEnabled(env: Pick<Bindings, 'RESEND_API_KEY'>): boolean {
  return Boolean(env.RESEND_API_KEY?.trim());
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends one message. True when Resend accepted it; false on any failure (not configured, network,
 * timeout, non-2xx), so callers can tell the person to try again. Resend's error `name` is a fixed
 * code (e.g. `validation_error`) and safe to log; its `message` can quote the address, so it isn't.
 */
export async function sendMail(env: MailEnv, msg: MailMessage, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!key || !from) {
    console.error(JSON.stringify({ event: 'mail_not_configured', missing: key ? 'MAIL_FROM' : 'RESEND_API_KEY' }));
    return false;
  }
  try {
    const res = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        // Resend refuses requests without one (403).
        'user-agent': 'hoomuch',
      },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
    });
    if (res.ok) return true;
    let name: string | undefined;
    try {
      const body = (await res.json()) as { name?: unknown };
      if (typeof body.name === 'string' && /^[a-z_]{1,64}$/.test(body.name)) name = body.name;
    } catch {
      // not JSON: the status says enough
    }
    console.error(JSON.stringify({ event: 'mail_failed', status: res.status, ...(name ? { code: name } : {}) }));
    return false;
  } catch (err) {
    console.error(JSON.stringify({ event: 'mail_failed', message: err instanceof Error ? err.name : 'error' }));
    return false;
  }
}
