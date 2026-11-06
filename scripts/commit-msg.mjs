// Checks a commit message against Conventional Commits 1.0.0
// (https://www.conventionalcommits.org/en/v1.0.0/) and the rules in CONTRIBUTING.md under
// "Commit messages". `.githooks/commit-msg` runs it with the path of the message file; it exits 1
// and says what's wrong when the message doesn't pass.
//
// No dependencies on purpose: commitlint would bring in dozens of packages, and the rules are short
// enough to read here.
//
//   <type>[(<scope>)][!]: <description>     the first line, at most 72 characters
//                                           a blank line
//   [body]
//                                           a blank line
//   [footers]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TYPES = ['feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'style', 'build', 'ci', 'chore', 'revert'];
export const MAX_HEADER = 72;

// Messages git writes itself, and the markers `git rebase --autosquash` looks for.
const PASS_THROUGH = [/^Merge /, /^Revert "/, /^(fixup|squash|amend)! /];

const HEADER = /^(?<type>[^\s():!]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?:(?<rest>.*)$/;
const SCOPE = /^[a-z0-9][a-z0-9-]*$/;
const BREAKING = /^BREAKING[ -]CHANGE: \S/;
const EXAMPLE = '"feat(dashboard): show what happened on any day in a calendar"';

/** The lines git keeps: no comments, nothing below `git commit -v`'s scissors line, no blank edges. */
function clean(message) {
  const lines = [];
  for (const line of message.split(/\r?\n/)) {
    if (/^# -+ >8 -+$/.test(line)) break;
    if (line.startsWith('#')) continue;
    lines.push(line.trimEnd());
  }
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

/** What's wrong with a commit message. An empty list means it passes. */
export function checkCommitMessage(message) {
  const lines = clean(message);
  // Git aborts an empty commit on its own, with a clearer message than ours.
  if (lines.length === 0) return [];
  const [header] = lines;
  if (PASS_THROUGH.some((re) => re.test(header))) return [];

  const errors = [];
  const m = HEADER.exec(header);
  if (!m?.groups) {
    errors.push(`the first line must look like "type(scope): description", e.g. ${EXAMPLE}`);
  } else {
    const { type, scope, rest } = m.groups;
    if (!TYPES.includes(type)) {
      errors.push(
        TYPES.includes(type.toLowerCase())
          ? `write the type in lowercase: "${type.toLowerCase()}"`
          : `"${type}" isn't a type; use one of ${TYPES.join(', ')}`,
      );
    }
    if (scope === '') {
      errors.push('drop the empty "()", or put a scope in it');
    } else if (scope !== undefined && !SCOPE.test(scope)) {
      errors.push(`the scope "${scope}" must be one lowercase word, such as "stripe" or "dashboard"`);
    }
    const description = rest.trim();
    if (description === '') {
      errors.push('add a description after the colon');
    } else if (!/^ \S/.test(rest)) {
      errors.push('put exactly one space after the colon');
    }
    if (description.endsWith('.')) errors.push('drop the full stop at the end of the first line');
  }

  const length = [...header].length;
  if (length > MAX_HEADER) {
    errors.push(`the first line is ${length} characters; keep it to ${MAX_HEADER} and move the detail into the body`);
  }
  if (lines.length > 1 && lines[1] !== '') {
    errors.push('leave a blank line between the first line and the body');
  }
  for (const line of lines.slice(1)) {
    if (/^breaking[ -]change\b/i.test(line) && !BREAKING.test(line)) {
      errors.push(`write the footer as "BREAKING CHANGE: what to do", in capitals: "${line}"`);
    }
  }
  return errors;
}

// Run by the hook: check the file git hands over.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/commit-msg.mjs <commit message file>');
    process.exit(2);
  }
  const message = readFileSync(file, 'utf8');
  const errors = checkCommitMessage(message);
  if (errors.length > 0) {
    console.error(
      [
        '',
        'Commit message rejected: it must follow Conventional Commits.',
        '',
        `    ${clean(message)[0]}`,
        '',
        ...errors.map((e) => `  - ${e}`),
        '',
        '  Format: <type>[(<scope>)][!]: <description>',
        `  Types:  ${TYPES.join(' ')}`,
        '  Rules:  CONTRIBUTING.md, "Commit messages"',
        '',
        '  Your message is kept. Fix it and commit again with:',
        `    git commit -e -F ${file}`,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}
