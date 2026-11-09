import { describe, expect, it } from 'vitest';
import {
  appStoreId,
  normalizeAppStoreUrl,
  normalizePlayStoreUrl,
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

describe('store links', () => {
  it('take any App Store link (or id) to its canonical form', () => {
    for (const input of [
      'https://apps.apple.com/tr/app/weigho-weight-tracker/id1234567890',
      'https://apps.apple.com/app/id1234567890?platform=iphone',
      'apps.apple.com/us/app/weigho/id1234567890/',
      'https://itunes.apple.com/us/app/id1234567890?mt=8',
      'id1234567890',
    ]) {
      expect(normalizeAppStoreUrl(input)).toBe('https://apps.apple.com/app/id1234567890');
    }
    expect(appStoreId('https://apps.apple.com/app/id1234567890')).toBe('1234567890');
  });

  it('turn away anything that is not an App Store listing', () => {
    for (const input of ['https://apps.apple.com.evil.example/app/id1234567890', 'http://apps.apple.com/app/id1234567890', 'https://apps.apple.com/us/app/weigho', 'https://example.com/id1234567890', 'javascript:alert(1)', '']) {
      expect(normalizeAppStoreUrl(input)).toBeNull();
    }
  });

  it('take a Google Play link or package name to its canonical form', () => {
    for (const input of [
      'https://play.google.com/store/apps/details?id=com.weigho.app&hl=tr',
      'play.google.com/store/apps/details?id=com.weigho.app',
      'com.weigho.app',
    ]) {
      expect(normalizePlayStoreUrl(input)).toBe('https://play.google.com/store/apps/details?id=com.weigho.app');
    }
  });

  it('turn away anything that is not a Google Play listing', () => {
    for (const input of [
      'https://play.google.com/store/apps/developer?id=Weigho',
      'https://play.google.com.evil.example/store/apps/details?id=com.weigho.app',
      'https://play.google.com/store/apps/details?id=not a package',
      'https://play.google.com/store/apps/details',
      'weigho',
      'javascript:alert(1)',
    ]) {
      expect(normalizePlayStoreUrl(input)).toBeNull();
    }
  });
});
