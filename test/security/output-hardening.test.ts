/**
 * Output-side regressions from the OWASP review (2026-11-05): the chart <style> sink only takes
 * safe tokens and colours, and a connection's page payload never carries a secret field.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ChartContainer, type ChartConfig } from '../../src/components/ui/chart';
import { getConnectionDetail } from '../../src/data/connections';
import { createTestD1, seedConnection, seedUser, testEnv, type TestD1 } from '../fixtures/d1';

function chartHtml(config: ChartConfig, id?: string): string {
  return renderToStaticMarkup(createElement(ChartContainer, { config, id, children: createElement('svg') }));
}

describe('chart <style> block', () => {
  it('still writes plain colour variables', () => {
    const html = chartHtml({ mrr: { color: '#0b6' }, revenue: { color: 'var(--chart-2)' } }, 'main');
    expect(html).toContain('--color-mrr: #0b6;');
    expect(html).toContain('--color-revenue: var(--chart-2);');
  });

  it('drops a key that would break out of the <style> element', () => {
    const html = chartHtml({ 'a;}</style><script>alert(1)</script><style>{': { color: 'red' } }, 'main');
    expect(html).not.toContain('</style><script>');
    expect(html).not.toContain('<script');
  });

  it('drops a colour that would inject CSS', () => {
    const html = chartHtml({ mrr: { color: 'red;} body{background:url(https://evil.example/?leak)' } }, 'main');
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('body{');
  });

  it('drops theme colours that are not plain colours', () => {
    const html = chartHtml({ mrr: { theme: { light: '#fff', dark: '</style><b>x</b>' } } }, 'main');
    expect(html).toContain('--color-mrr: #fff;');
    expect(html).not.toContain('<b>');
  });

  it('writes nothing for an unsafe chart id', () => {
    const html = chartHtml({ mrr: { color: '#0b6' } }, 'x] , body { display:none } [y');
    expect(html).not.toContain('<style');
  });
});

describe('connection detail payload', () => {
  let t: TestD1 | null = null;
  afterEach(() => {
    t?.sqlite.close();
    t = null;
  });

  it('never includes a secret field, even if one ended up in config', async () => {
    t = createTestD1();
    seedUser(t, { id: 'u1' });
    seedConnection(t, {
      id: 'c1',
      userId: 'u1',
      provider: 'stripe',
      config: { apiKey: 'rk_live_51ShouldNeverRender', reportingCurrency: 'EUR' },
    });
    const detail = await getConnectionDetail(testEnv(t.db), { id: 'u1', email: 'u1@example.com', baseCurrency: 'USD' }, 'c1');
    expect(detail?.config).toEqual({ reportingCurrency: 'EUR' });
    expect(JSON.stringify(detail)).not.toContain('rk_live_51ShouldNeverRender');
  });
});
