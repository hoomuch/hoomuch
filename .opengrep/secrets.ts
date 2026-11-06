// Cases for secrets.yaml: `opengrep scan --test .opengrep`. `ruleid:` marks the next line as a
// finding the rule must report, `ok:` as one it must not. Never compiled or run: tsconfig.json and
// vitest.config.ts only take src/ and test/.

function logs(ctx: any, input: any, row: any, env: any, level: 'log' | 'error', err: unknown) {
  // ruleid: secret-in-log
  console.log(JSON.stringify({ event: 'verify', key: input.credentials.apiKey }));
  // ruleid: secret-in-log
  console.error(JSON.stringify({ event: 'decrypt_failed', blob: row.encryptedCredentials }));
  // ruleid: secret-in-log
  ctx.log('token', { value: input.accessToken });
  // ruleid: secret-in-log
  console[level](JSON.stringify({ event: 'boot', key: env.ENCRYPTION_KEY }));
  // ruleid: secret-in-log
  console.log(JSON.stringify({ event: 'verify', credentials }));
  // ok: secret-in-log
  console.error(JSON.stringify({ event: 'sync_failed', connectionId: row.id, message: sanitizeErrorText(String(err)) }));
  // ok: secret-in-log
  ctx.log('verify_failed', { field: 'apiKey', status: 401 });
  // ok: secret-in-log
  console.error(JSON.stringify({ event: 'mail_not_configured', missing: 'RESEND_API_KEY' }));
}

function errors(input: any) {
  if (input.bad) {
    // ruleid: secret-in-error
    throw new ProviderError('auth', `Key ${input.credentials.apiKey} was rejected`);
  }
  if (input.short) {
    // ruleid: secret-in-error
    throw new Error('bad token: ' + input.accessToken);
  }
  // ok: secret-in-error
  throw new ProviderError('auth', 'The API key was rejected.', { field: 'apiKey' });
}
