// node --test
//
// The verifier itself is tested in promptsign-core. What is tested here is the
// part that only exists in this action: policy construction from the inputs,
// and turning a report into a verdict, annotations and a summary.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.PROMPTSIGN_ACTION_NO_MAIN = '1';
const { buildPolicy, parsePaths, normalize, tally, annotations, summaryTable } = await import(
  '../scripts/verify.mjs'
);

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const fail = { target: 'skills/a', name: 'a', signed: true, identity: null, keyid: null, action: 'fail', findings: [{ level: 'error', message: 'invalid signature' }] };
const unsigned = { target: 'skills/b', name: 'b', signed: false, action: 'warn', findings: [{ level: 'warn', message: 'unsigned artifact "b" (rule: *)' }] };
const ok = { target: 'skills/c', name: 'c', version: '1.2.0', signed: true, identity: 'https://github.com/o/r/.github/workflows/p.yml@refs/heads/main', action: 'pass', findings: [] };

describe('buildPolicy', () => {
  test('no constraints leaves the repo policy alone', () => {
    assert.deepEqual(buildPolicy({}), { file: null, generated: null });
  });

  test('an explicit policy file wins over the sugar', () => {
    const r = buildPolicy({ policy: 'my/policy.json', identity: 'x', strict: true });
    assert.equal(r.file, 'my/policy.json');
    assert.equal(r.generated, null);
  });

  test('strict alone enforces "must be signed" without pinning a signer', () => {
    const { generated } = buildPolicy({ strict: true });
    assert.equal(generated.default, 'enforce');
    assert.deepEqual(generated.rules, [{ pattern: '*', action: 'enforce', tofu: false }]);
  });

  test('an identity implies enforce and defaults the issuer to GitHub', () => {
    const { generated } = buildPolicy({ identity: 'https://github.com/o/*' });
    assert.deepEqual(generated.rules[0], {
      pattern: '*',
      action: 'enforce',
      identity: 'https://github.com/o/*',
      issuer: GITHUB_ISSUER,
      tofu: false,
    });
  });

  test('an explicit issuer is kept', () => {
    const { generated } = buildPolicy({ identity: 'a@b.com', issuer: 'https://accounts.google.com' });
    assert.equal(generated.rules[0].issuer, 'https://accounts.google.com');
  });

  // An issuer alone is a real constraint: signed by anyone from that IdP.
  // Ignoring it would silently verify nothing while the workflow looks strict.
  test('an issuer alone constrains, without pinning one identity', () => {
    const { generated } = buildPolicy({ issuer: 'https://accounts.google.com' });
    assert.deepEqual(generated.rules, [
      { pattern: '*', action: 'enforce', issuer: 'https://accounts.google.com', tofu: false },
    ]);
  });

  test('tofu is always off, because a throwaway runner must not establish trust', () => {
    for (const input of [{ strict: true }, { identity: 'x' }]) {
      assert.equal(buildPolicy(input).generated.rules[0].tofu, false);
    }
  });
});

describe('parsePaths', () => {
  test('splits on newlines and keeps spaces inside a path', () => {
    assert.deepEqual(parsePaths(' skills/a \n\nmy skills/b\r\n'), ['skills/a', 'my skills/b']);
  });
  test('empty input yields nothing', () => {
    assert.deepEqual(parsePaths(''), []);
    assert.deepEqual(parsePaths(undefined), []);
  });
});

describe('normalize', () => {
  test('accepts a single object, an array, and several chunks together', () => {
    const out = normalize([JSON.stringify(fail), JSON.stringify([unsigned, ok]), '  ']);
    assert.deepEqual(out.map((r) => r.name), ['a', 'b', 'c']);
  });
});

describe('tally', () => {
  test('the worst outcome wins', () => {
    assert.equal(tally([ok, unsigned, fail]).result, 'fail');
    assert.equal(tally([ok, unsigned]).result, 'warn');
    assert.equal(tally([ok]).result, 'pass');
    assert.equal(tally([]).result, 'pass');
  });

  test('counts are per category', () => {
    assert.deepEqual(tally([ok, unsigned, fail]), {
      total: 3, failed: 1, warned: 1, unsigned: 1, result: 'fail',
    });
  });
});

describe('annotations', () => {
  test('failures are errors, warnings are warnings, passes are silent', () => {
    const lines = annotations([ok, unsigned, fail]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^::error file=skills\/a::PromptSign: invalid signature$/);
    assert.match(lines[1], /^::warning file=skills\/b::PromptSign: unsigned artifact "b"/);
    assert.equal(annotations([ok]).length, 0);
  });
});

describe('summaryTable', () => {
  test('names the signer for a verified artifact, with its version', () => {
    const s = summaryTable([ok], tally([ok]));
    assert.match(s, /`c` `1\.2\.0`/);
    assert.match(s, /workflows\/p\.yml@refs\/heads\/main/);
  });

  test('a failed bundle claims no signer', () => {
    const s = summaryTable([fail], tally([fail]));
    assert.match(s, /signer not established/);
    assert.doesNotMatch(s, /local key/);
  });

  test('unsigned is reported without implying wrongdoing', () => {
    const s = summaryTable([unsigned], tally([unsigned]));
    assert.match(s, /\*unsigned\*/);
    assert.match(s, /Most of the ecosystem is still unsigned/);
  });

  test('the "check what changed" note appears only when something failed', () => {
    assert.match(summaryTable([fail], tally([fail])), /check what changed/);
    assert.doesNotMatch(summaryTable([ok], tally([ok])), /check what changed/);
  });
});
