import { describe, expect, it } from 'vitest';
import { checkCommitMessage, MAX_HEADER } from '../../scripts/commit-msg.mjs';

const passes = (message: string) => expect(checkCommitMessage(message)).toEqual([]);
const fails = (message: string, hint: RegExp) => {
  const errors = checkCommitMessage(message);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.join('\n')).toMatch(hint);
};

describe('commit-msg: messages that follow Conventional Commits', () => {
  it('takes type, optional scope and description', () => {
    passes('feat: show what happened on any day in a calendar');
    passes('fix(lemonsqueezy): stop paging when the budget runs out');
    passes('build(deps): update recharts and wrangler to their latest releases');
    passes('docs: mention Stripe restricted keys');
  });

  it('takes a breaking change, with ! and with the footer', () => {
    passes('feat(sync)!: read the sync schedule from wrangler.jsonc');
    passes('feat(sync)!: read the schedule\n\nBREAKING CHANGE: move it into triggers.crons.');
    passes('feat: read the schedule\n\nBREAKING-CHANGE: move it into triggers.crons.');
  });

  it('takes a body and footers after blank lines', () => {
    passes('fix(stripe): count trials as zero MRR\n\nTrials were counted at full price.\n\nRefs: #12');
  });

  it('ignores what git strips: comments, the -v diff, blank edges, trailing spaces', () => {
    passes('\n\ndocs: fix a typo  \n# Please enter the commit message for your changes.\n#\n');
    passes(
      'fix: keep the cursor\n# ------------------------ >8 ------------------------\nnot a header\n',
    );
  });

  it('lets through messages git writes itself, and autosquash markers', () => {
    passes("Merge branch 'main' into security-review");
    passes('Revert "feat: add a calendar"\n\nThis reverts commit 0bc83bb.');
    passes('fixup! feat: add a calendar');
    passes('squash! feat: add a calendar');
    passes('amend! feat: add a calendar');
  });

  it('leaves an empty message to git', () => {
    passes('');
    passes('# only a comment\n');
  });

  it(`takes a first line of exactly ${MAX_HEADER} characters, counting letters, not bytes`, () => {
    passes(`fix: ${'a'.repeat(MAX_HEADER - 5)}`);
    passes(`fix: ${'ş'.repeat(MAX_HEADER - 5)}`);
  });
});

describe('commit-msg: messages it turns down, and the hint it gives', () => {
  it('a plain sentence with no type', () => {
    fails('Add a calendar to the dashboard', /type\(scope\): description/);
    fails('feat (ui): add a button', /type\(scope\): description/);
  });

  it('a type in capitals, or one that is not on the list', () => {
    fails('Feat: add a calendar', /lowercase: "feat"/);
    fails('feature: add a calendar', /"feature" isn't a type/);
    fails('wip: calendar', /"wip" isn't a type/);
  });

  it('an empty or malformed scope', () => {
    fails('feat(): add a calendar', /empty "\(\)"/);
    fails('feat(Dashboard): add a calendar', /scope "Dashboard"/);
    fails('feat(dash board): add a calendar', /scope "dash board"/);
  });

  it('a missing description, or the wrong spacing after the colon', () => {
    fails('feat:', /add a description/);
    fails('feat: ', /add a description/);
    fails('feat:add a calendar', /one space after the colon/);
    fails('feat:  add a calendar', /one space after the colon/);
  });

  it('a full stop at the end', () => {
    fails('feat: add a calendar.', /full stop/);
  });

  it(`a first line longer than ${MAX_HEADER} characters`, () => {
    fails(`fix: ${'a'.repeat(MAX_HEADER - 4)}`, new RegExp(`${MAX_HEADER + 1} characters`));
  });

  it('a body with no blank line before it', () => {
    fails('fix: count trials\nTrials were counted at full price.', /blank line/);
  });

  it('a breaking-change footer not in capitals', () => {
    fails('feat!: read the schedule\n\nBreaking change: move it.', /in capitals/);
    fails('feat!: read the schedule\n\nbreaking-change: move it.', /in capitals/);
  });
});
