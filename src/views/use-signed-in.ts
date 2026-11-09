/**
 * Whether this browser has a session, on pages rendered without it (the public pages). Owner:
 * Experience (pages).
 *
 * False on the server and on the first client render, so hydration matches; true after it when the
 * signed-in hint is there (lib/signed-in.ts). Only for what the page offers (Dashboard instead of
 * Log in, charts opened without a click on the lock): it proves nothing, and the server checks the
 * session on every request that needs one.
 */

import { useEffect, useState } from 'react';
import { hasSignedInHint } from '../lib/signed-in';

export function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(hasSignedInHint(document.cookie)), []);
  return signedIn;
}
