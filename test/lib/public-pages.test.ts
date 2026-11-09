import { describe, expect, it } from 'vitest';
import {
  countsPublicly,
  isValidHandle,
  isValidSlug,
  normalizeWebsite,
  normalizeXHandle,
  publicPagesEnabled,
  slugFromName,
} from '../../src/lib/public-pages';

describe('public page rules', () => {
  it('are off unless the instance says "true"', () => {
    expect(publicPagesEnabled(undefined)).toBe(false);
    expect(publicPagesEnabled({})).toBe(false);
    expect(publicPagesEnabled({ PUBLIC_PAGES: '' })).toBe(false);
    expect(publicPagesEnabled({ PUBLIC_PAGES: '1' })).toBe(false);
    expect(publicPagesEnabled({ PUBLIC_PAGES: ' true ' })).toBe(true);
  });

  it('take slugs of 3 to 40 lowercase letters, digits and single inner hyphens', () => {
    for (const ok of ['abc', 'acme-notes', 'a1b', 'x'.repeat(40)]) expect(isValidSlug(ok), ok).toBe(true);
    for (const bad of ['ab', 'Acme', '-acme', 'acme-', 'ac--me', 'ac_me', 'x'.repeat(41), 'açme']) expect(isValidSlug(bad), bad).toBe(false);
  });

  it('suggest a slug from a name', () => {
    expect(slugFromName('Acme Notes!')).toBe('acme-notes');
    expect(slugFromName('Çiçek Işık Şeker')).toBe('cicek-isik-seker');
    expect(slugFromName('  --  ')).toBe('');
    expect(slugFromName('x'.repeat(39) + ' y')).toBe('x'.repeat(39));
  });

  it('keep websites to https, adding it to a bare domain', () => {
    expect(normalizeWebsite('acme.com')).toBe('https://acme.com/');
    expect(normalizeWebsite('https://acme.com/pricing')).toBe('https://acme.com/pricing');
    for (const bad of ['http://acme.com', 'javascript:alert(1)', 'https://user:pw@acme.com', 'localhost', 'https://', 'a'.repeat(201)]) {
      expect(normalizeWebsite(bad), bad).toBeNull();
    }
  });

  it('take handles of 3 to 30 characters, never a reserved one', () => {
    for (const ok of ['taha', 'acme_hq', 'indie-maker', 'a1b']) expect(isValidHandle(ok), ok).toBe(true);
    for (const bad of ['ab', 'Taha', '_acme', 'admin', 'hoomuch', 'x'.repeat(31)]) expect(isValidHandle(bad), bad).toBe(false);
  });

  it('read an X username from a handle or a profile URL', () => {
    expect(normalizeXHandle('@acme_hq')).toBe('acme_hq');
    expect(normalizeXHandle('https://x.com/acme_hq')).toBe('acme_hq');
    expect(normalizeXHandle('twitter.com/acme?lang=en')).toBe('acme');
    expect(normalizeXHandle('acme.com')).toBeNull();
    expect(normalizeXHandle('x'.repeat(16))).toBeNull();
  });

  it('never count demo data or a test-mode key', () => {
    expect(countsPublicly('stripe', false)).toBe(true);
    expect(countsPublicly('stripe', true)).toBe(false);
    expect(countsPublicly('demo', false)).toBe(false);
  });
});
