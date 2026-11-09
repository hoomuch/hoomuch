/**
 * The instance's privacy policy and terms (GET /privacy, /terms). Owner: Lead.
 *
 * The texts in views/pages/legal.tsx are hoomuch.com's: an individual operator in Türkiye, under
 * the KVKK (and the GDPR where it applies). They name no court or postal address. They're shown only when the instance names its operator (LEGAL_NAME) and
 * a contact address (LEGAL_EMAIL); an instance run by someone else, somewhere else, leaves both
 * unset and publishes its own.
 */

import type { Bindings } from '../env';

export interface LegalOperator {
  /** Who runs the service, as the texts name them, e.g. "Taha Bozdemir". */
  name: string;
  /** Where privacy requests and notices go, e.g. "hello@hoomuch.com". */
  email: string;
}

/** The operator the legal pages name; null when the instance doesn't publish them. */
export function legalOperator(env: Pick<Bindings, 'LEGAL_NAME' | 'LEGAL_EMAIL'>): LegalOperator | null {
  const name = env.LEGAL_NAME?.trim();
  const email = env.LEGAL_EMAIL?.trim();
  return name && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { name, email } : null;
}
