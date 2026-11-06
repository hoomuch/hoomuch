#!/usr/bin/env node
// Runs the security scanners over this repository, on your machine:
//
//   npm run security
//
//   gitleaks      secrets in the git history and in uncommitted changes, with .gitleaks.toml. The
//                 pre-commit hook runs it on every commit as well.
//   OSV-Scanner   known vulnerabilities in the dependencies pinned in package-lock.json
//   Opengrep      hoomuch's own rules (.opengrep/, checked against their test cases first) and the
//                 community JavaScript and TypeScript security rules, over src/ and scripts/
//   zizmor        the GitHub Actions workflows and dependabot.yml in .github/
//
// The scanners are programs of their own, not npm dependencies; this script says how to install
// any that's missing. It runs all four, then exits 1 if any of them found something or couldn't run.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const INSTALL = {
  gitleaks: 'brew install gitleaks, or https://github.com/gitleaks/gitleaks/releases',
  'osv-scanner': 'brew install osv-scanner, or https://google.github.io/osv-scanner/installation/',
  opengrep: 'https://github.com/opengrep/opengrep#installation',
  zizmor: 'brew install zizmor, or pipx install zizmor',
};

// opengrep/opengrep-rules: Semgrep's community rules from before their licence change. Pinned, so a
// scan only changes when this line does; fetched once into node_modules/.cache.
const RULES_REPO = 'https://github.com/opengrep/opengrep-rules.git';
const RULES_COMMIT = 'f1d2b562b414783763fd02a6ed2736eaed622efa';
const RULES_DIR = join('node_modules', '.cache', 'opengrep-rules');

// Community rules that are wrong for this codebase as a whole. A one-off false positive gets a
// `// nosemgrep: <rule> -- <why>` comment on the line above it instead, so the rule keeps watching
// the rest of the code.
const SKIPPED_RULES = {
  'react-href-var': 'every href is a path the app builds, and React 19 refuses javascript: URLs',
  'prohibit-jquery-html': "there's no jQuery; it fires on Hono's c.html()",
  'html-in-template-string': 'pages are React; the one HTML string, the verification email, escapes what it interpolates',
};

/** Runs a command with its output on the terminal; returns the exit code. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

/** A command's trimmed stdout, or '' when it fails or isn't installed. */
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : '';
}

function installed(cmd) {
  return spawnSync(cmd, ['--help'], { stdio: 'ignore' }).error === undefined;
}

function gitleaks() {
  const flags = ['--redact', '--no-banner', '--log-level', 'warn', '--verbose'];
  // Every commit, then what's staged, then what isn't. Files git doesn't track yet are scanned by
  // the pre-commit hook once they're staged.
  const history = run('gitleaks', ['git', ...flags, '.']);
  const staged = run('gitleaks', ['git', '--pre-commit', '--staged', ...flags, '.']);
  const unstaged = run('gitleaks', ['git', '--pre-commit', ...flags, '.']);
  if (history + staged + unstaged === 0) console.log('No secrets in the history or the uncommitted changes.');
  return history || staged || unstaged;
}

function osvScanner() {
  return run('osv-scanner', ['scan', 'source', '--recursive', '.']);
}

/** The community security rule files for JavaScript and TypeScript, fetched on first use. */
function communityRules() {
  if (capture('git', ['-C', RULES_DIR, 'rev-parse', 'HEAD']) !== RULES_COMMIT) {
    console.log(`Fetching the community rules (opengrep-rules@${RULES_COMMIT.slice(0, 7)}) into ${RULES_DIR}`);
    rmSync(RULES_DIR, { recursive: true, force: true });
    mkdirSync(RULES_DIR, { recursive: true });
    const git = (...args) => run('git', ['-C', RULES_DIR, ...args]);
    if (git('init', '-q') || git('fetch', '-q', '--depth', '1', RULES_REPO, RULES_COMMIT) || git('checkout', '-q', 'FETCH_HEAD')) {
      rmSync(RULES_DIR, { recursive: true, force: true });
      throw new Error('could not fetch the community rules');
    }
  }
  return ['javascript', 'typescript'].flatMap((lang) =>
    readdirSync(join(RULES_DIR, lang), { recursive: true })
      .filter((f) => f.endsWith('.yaml') && f.split(sep).includes('security'))
      .filter((f) => !(basename(f, '.yaml') in SKIPPED_RULES))
      .map((f) => join(RULES_DIR, lang, f)),
  );
}

function opengrep() {
  // Each rule file in .opengrep/ has its cases next to it (providers.yaml, providers.ts). A rule
  // that misses its cases would make the scan below quietly pass, so they run first.
  let failed = false;
  const ruleFiles = readdirSync('.opengrep').filter((f) => f.endsWith('.yaml'));
  for (const file of ruleFiles) {
    const stem = basename(file, '.yaml');
    const cases = [`.opengrep/${stem}.ts`, `.opengrep/${stem}.tsx`].find((f) => existsSync(f));
    if (!cases) {
      console.log(`.opengrep/${file} has no test cases (.opengrep/${stem}.ts or .tsx)`);
      failed = true;
      continue;
    }
    const r = spawnSync('opengrep', ['scan', '--test', '--config', `.opengrep/${file}`, cases], { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stdout.write(r.stdout + r.stderr);
      console.log(`.opengrep/${file} doesn't pass its test cases in ${cases}`);
      failed = true;
    }
  }
  if (failed) return 1;
  console.log(`hoomuch rules: ${ruleFiles.join(', ')} pass their test cases.`);

  const rules = ['.opengrep', ...communityRules()];
  console.log(`Skipping community rules: ${Object.keys(SKIPPED_RULES).join(', ')} (reasons in scripts/security.mjs).`);
  const status = run('opengrep', ['scan', '--quiet', '--error', '--disable-version-check', ...rules.flatMap((r) => ['--config', r]), 'src', 'scripts']);
  if (status === 0) console.log(`No findings in src/ or scripts/ (${rules.length - 1} community rule files and .opengrep/).`);
  return status;
}

function zizmor() {
  // Online audits (known-vulnerable actions, impostor commits) need a GitHub token.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || capture('gh', ['auth', 'token']);
  if (!token) console.log('No GitHub token (GH_TOKEN, or `gh auth login`): the online audits are skipped.');
  const args = ['--no-progress', ...(token ? [] : ['--offline']), '.github'];
  return run('zizmor', args, { env: token ? { ...process.env, GH_TOKEN: token } : process.env });
}

const STEPS = [
  ['gitleaks', 'secrets', gitleaks],
  ['osv-scanner', 'vulnerable dependencies', osvScanner],
  ['opengrep', 'code patterns', opengrep],
  ['zizmor', 'GitHub Actions', zizmor],
];

const results = [];
for (const [tool, what, step] of STEPS) {
  console.log(`\n==> ${tool}: ${what}\n`);
  if (!installed(tool)) {
    console.log(`${tool} isn't installed: ${INSTALL[tool]}`);
    results.push([tool, 'not installed']);
    continue;
  }
  let status;
  try {
    status = step();
  } catch (err) {
    console.log(`${tool}: ${err instanceof Error ? err.message : String(err)}`);
    status = 1;
  }
  results.push([tool, status === 0 ? 'ok' : `failed (exit ${status}), see above`]);
}

console.log('\n==> summary\n');
for (const [tool, result] of results) console.log(`  ${tool.padEnd(12)} ${result}`);
console.log('');
process.exit(results.every(([, result]) => result === 'ok') ? 0 : 1);
