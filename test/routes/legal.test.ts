/**
 * The privacy policy and terms (routes/legal.tsx): served, and linked from every footer and the
 * sign-up form, only where the instance names its operator (LEGAL_NAME, LEGAL_EMAIL).
 */
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { createTestD1, testEnv } from '../fixtures/d1';
import { htmlOf } from '../fixtures/html';

const LEGAL = { LEGAL_NAME: 'Ada Operator', LEGAL_EMAIL: 'hello@hoomuch.test' };

function get(path: string, vars: Record<string, string> = {}): Promise<Response> {
  const env = testEnv(createTestD1().db, vars);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  return worker.fetch!(new Request(`https://hoomuch.test${path}`) as never, env, ctx as never) as Promise<Response>;
}

describe('/privacy and /terms', () => {
  it('are the ordinary 404 until the instance names its operator, and nothing links them', async () => {
    for (const path of ['/privacy', '/terms']) expect((await get(path)).status).toBe(404);
    expect((await get('/privacy', { LEGAL_NAME: 'Ada Operator' })).status).toBe(404);
    expect((await get('/privacy', { ...LEGAL, LEGAL_EMAIL: 'not an address' })).status).toBe(404);
    const landing = await htmlOf(await get('/'));
    expect(landing).not.toContain('href="/privacy"');
    expect(await htmlOf(await get('/signup'))).not.toContain('Terms of Service');
  });

  it('name the operator and the contact address, and say what is stored and where', async () => {
    const privacy = await htmlOf(await get('/privacy', LEGAL));
    expect(privacy).toContain('<h1 class="font-heading text-hero-sm">Privacy Policy</h1>');
    expect(privacy).toContain('Ada Operator');
    expect(privacy).toContain('href="mailto:hello@hoomuch.test"');
    expect(privacy).toContain('hoomuch.test');
    for (const fact of ['KVKK', 'GDPR', 'AES-256-GCM', 'Cloudflare', 'Resend', 'hm_session', 'hm_in', 'hm_range']) expect(privacy).toContain(fact);
    const terms = await htmlOf(await get('/terms', LEGAL));
    expect(terms).toContain('Terms of Service');
    expect(terms).toContain('Ada Operator');
    // Like TrustMRR's: no court and no postal address.
    for (const unsaid of ['courts', 'jurisdiction', 'Governing law']) expect(terms).not.toContain(unsaid);
  });

  it('are linked from the marketing footer and the sign-up form once on', async () => {
    const landing = await htmlOf(await get('/', LEGAL));
    expect(landing).toContain('href="/privacy"');
    expect(landing).toContain('href="/terms"');
    const signup = await htmlOf(await get('/signup', LEGAL));
    expect(signup).toContain('By creating an account, you agree to the');
    expect(await htmlOf(await get('/login', LEGAL))).not.toContain('By creating an account');
     // The public pages render without the session, and still link them.
    expect(await htmlOf(await get('/explore', { ...LEGAL, PUBLIC_PAGES: 'true' }))).toContain('href="/terms"');
    expect(await htmlOf(await get('/explore', { PUBLIC_PAGES: 'true' }))).not.toContain('href="/terms"');
  });
});
