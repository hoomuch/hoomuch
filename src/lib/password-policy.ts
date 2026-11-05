/**
 * Password length limits, shared by lib/auth (the rules) and the auth/settings pages (form hints).
 * Kept free of imports on purpose: the pages ship to the browser, and importing lib/auth there
 * would pull server code (session SQL, hashing) into the client bundle.
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;
