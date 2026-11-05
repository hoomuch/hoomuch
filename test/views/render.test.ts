/**
 * Server rendering: the whole document, the hydration payload and its escaping.
 * Owner: Experience (design).
 */

import { describe, expect, it } from 'vitest';
import { serializePayload } from '../../src/views/page-root';
import { renderDocument } from '../../src/views/render';
import { FIXTURE_CONNECTIONS, FIXTURE_NOW } from '../../src/views/fixtures';
import { HOUR } from '../../src/lib/time';

const chrome = { user: null, flash: null };

function payloadOf(html: string): { name: string; props: Record<string, unknown>; now: number } {
  const m = html.match(/<script id="hm-page" type="application\/json">([\s\S]*?)<\/script>/);
  expect(m, 'payload block').not.toBeNull();
  return JSON.parse(m![1]!);
}

describe('renderDocument', () => {
  it('renders a full document with the module bundle and the page payload', () => {
    const html = renderDocument('auth', { chrome, mode: 'login', signupOpen: true }, FIXTURE_NOW);
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(html).toContain('<script type="module" src="/client/entry.js"></script>');
    const payload = payloadOf(html);
    expect(payload.name).toBe('auth');
    expect(payload.now).toBe(FIXTURE_NOW);
    expect(payload.props).toEqual({ chrome, mode: 'login', signupOpen: true });
    // The payload sits after the page, at the end of <body>.
    expect(html.indexOf('id="hm-page"')).toBeGreaterThan(html.indexOf('</footer>'));
  });

  it('keeps user-controlled text from closing the payload script', () => {
    const email = '</script><script>alert(1)</script>';
    const html = renderDocument('auth', { chrome, mode: 'login', signupOpen: true, email, error: 'Nope.' }, FIXTURE_NOW);
    // Only the bundle and the payload block: no script was injected.
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(payloadOf(html).props.email).toBe(email);
  });

  it('dates relative times with the request clock, so the browser hydrates the same text', () => {
    // A page that shows a relative time and leaves `now` to the request clock (no `now` prop).
    // The old version of this test rendered the 404 page, which has no relative time at all.
    const connections = [FIXTURE_CONNECTIONS[0]!]; // last synced FIXTURE_NOW − 4 min
    const at = (now: number) => renderDocument('connections', { chrome, connections }, now);
    const html = at(FIXTURE_NOW);
    expect(payloadOf(html).now).toBe(FIXTURE_NOW);
    expect(html).toMatch(/<time [^>]*>4 min ago<\/time>/);
    // Same props, later request: the label follows the clock handed in, not the process clock.
    expect(at(FIXTURE_NOW + 2 * HOUR)).toMatch(/<time [^>]*>2 h ago<\/time>/);
  });
});

describe('serializePayload', () => {
  it('escapes "<" and the JS line separators, and still round-trips', () => {
    const value = { a: '</script>', b: `x${String.fromCharCode(0x2028)}y${String.fromCharCode(0x2029)}z` };
    const json = serializePayload(value);
    expect(json).not.toContain('<');
    expect(json).not.toContain(String.fromCharCode(0x2028));
    expect(json).not.toContain(String.fromCharCode(0x2029));
    expect(JSON.parse(json)).toEqual(value);
  });
});
