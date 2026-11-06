// Cases for providers.yaml: `opengrep scan --test .opengrep`. `ruleid:` marks the next line as a
// finding the rule must report, `ok:` as one it must not. Never compiled or run: tsconfig.json and
// vitest.config.ts only take src/ and test/.

async function writes(ctx: any, spec: any) {
  // ruleid: provider-write-method
  await ctx.fetch(spec.url, { method: 'DELETE', headers: spec.headers });
  // ruleid: provider-write-method
  await ctx.fetch(spec.url, { headers: spec.headers, method: 'patch' });
  // ruleid: provider-post-outside-http
  await ctx.fetch(spec.url, { method: 'POST', body: '{}' });
  // ok: provider-write-method, provider-post-outside-http
  await ctx.fetch(spec.url, { method: 'GET' });
  // ok: provider-post-outside-http
  await fetchJson(ctx, { url: spec.url, readQuery: { period: 'day' } });
}

async function network(ctx: any, url: string) {
  // ruleid: provider-global-fetch
  await fetch(url);
  // ruleid: provider-global-fetch
  await globalThis.fetch(url);
  // ok: provider-global-fetch
  await ctx.fetch(url);
}

class Prices {
  // ok: provider-global-fetch
  private async fetch(id: string) {
    return id;
  }
  async get(id: string) {
    // ok: provider-global-fetch
    return this.fetch(id);
  }
}

function clocks(ctx: any, ms: number) {
  // ruleid: provider-wall-clock
  const a = Date.now();
  // ruleid: provider-wall-clock
  const b = new Date();
  // ok: provider-wall-clock
  const c = new Date(ms);
  // ok: provider-wall-clock
  const d = new Date(ctx.now);
  return [a, b, c, d];
}
