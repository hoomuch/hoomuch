/**
 * Throwaway-inbox check for sign-up. Owner: Lead. See SPEC.md §8.
 * The list is vendored (lib/disposable-domains.ts, refreshed with `npm run domains:update`), so the
 * check is a Set lookup: no network call on the request path.
 */

import { DISPOSABLE_DOMAINS } from './disposable-domains';

let blocked: Set<string> | null = null;

/** Built on first use: only sign-up needs it, so other requests never pay for the parse. */
function blocklist(): Set<string> {
  blocked ??= new Set(DISPOSABLE_DOMAINS.split('\n').filter(Boolean));
  return blocked;
}

/**
 * True when the address is at a disposable-mail domain, or at any subdomain of one
 * (`x@inbox.mailinator.com` matches `mailinator.com`). The bare TLD is never checked.
 */
export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const labels = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '').split('.');
  const list = blocklist();
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
