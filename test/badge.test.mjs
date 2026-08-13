// node --test
//
// The badge is a claim printed on other people's READMEs, so what is tested here
// is mostly what it must refuse to say: no signer named on a failure, no green
// for anything unproven, and no unescaped report text reaching the SVG.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

process.env.PROMPTSIGN_ACTION_NO_MAIN = '1';
const { badgeText, badgeSvg, shortIdentity, textWidth, renderBadge } = await import('../scripts/badge.mjs');
const { tally } = await import('../scripts/verify.mjs');

// Real `promptsign verify --json` output, captured from a signed artifact rather
// than written by hand. The rest of this file invents its report objects, which
// would keep passing if the verifier renamed a field and every badge silently
// went grey. Regenerate with:
//   promptsign verify ./promptsign-plugin --json --no-pin-updates
const REAL_SIGNED = JSON.parse(readFileSync(new URL('./fixtures/signed-report.json', import.meta.url), 'utf8'));

const GREEN = '#2ea44f';
const YELLOW = '#dfb317';
const RED = '#e05d44';
const GREY = '#9f9f9f';

const WORKFLOW_ID = 'https://github.com/PromptSign/promptsign-plugin/.github/workflows/sign.yml@refs/heads/main';

const signed = (identity, over = {}) => ({
  target: 'skills/a',
  name: 'a',
  signed: true,
  identity,
  action: 'pass',
  findings: [],
  ...over,
});
const unsigned = { target: 'skills/b', name: 'b', signed: false, action: 'warn', findings: [] };
const broken = { target: 'skills/c', name: 'c', signed: true, identity: WORKFLOW_ID, action: 'fail', findings: [] };

const textOf = (results) => badgeText(results, tally(results));

describe('shortIdentity', () => {
  test('reduces a keyless workflow identity to the repository that owns it', () => {
    assert.equal(shortIdentity(WORKFLOW_ID), 'github.com/PromptSign/promptsign-plugin');
  });

  test('keeps an email identity as it is', () => {
    assert.equal(shortIdentity('someone@example.com'), 'someone@example.com');
  });

  test('survives an identity that is not a URL at all', () => {
    assert.equal(shortIdentity('not a url'), 'not a url');
  });

  test('truncates rather than letting the badge grow without bound', () => {
    const long = `https://github.com/${'o'.repeat(80)}/r/.github/workflows/s.yml@refs/heads/main`;
    assert.ok(shortIdentity(long).length <= 40);
    assert.ok(shortIdentity(long).endsWith('…'));
  });

  test('empty identity yields empty, never the string "null"', () => {
    assert.equal(shortIdentity(null), '');
    assert.equal(shortIdentity(undefined), '');
  });
});

describe('badgeText', () => {
  test('names the signer when everything passed', () => {
    const { message, color } = textOf([signed(WORKFLOW_ID)]);
    assert.equal(message, 'signed by github.com/PromptSign/promptsign-plugin');
    assert.equal(color, GREEN);
  });

  // The failing result still carries an identity field. Printing it would credit
  // a publisher the verifier explicitly refused to establish.
  test('a failure never names a signer', () => {
    const { message, color } = textOf([broken]);
    assert.equal(message, 'verification failed');
    assert.equal(color, RED);
    assert.ok(!message.includes('PromptSign/promptsign-plugin'));
  });

  test('a partial failure counts rather than naming', () => {
    const { message, color } = textOf([signed(WORKFLOW_ID), broken]);
    assert.equal(message, '1 of 2 failed');
    assert.equal(color, RED);
  });

  // Observed for real: verifying a correctly signed artifact against a machine
  // whose pin still names the previous ref fails on the pin, not the signature.
  // Calling that "signature invalid" would be alarming and wrong.
  test('a policy or pin failure is not reported as an invalid signature', () => {
    const pinned = {
      ...REAL_SIGNED,
      action: 'fail',
      findings: [{ level: 'error', message: 'TOFU pin mismatch for "promptsign"' }],
    };
    const { message } = textOf([pinned]);
    assert.equal(message, 'verification failed');
    assert.ok(!/signature/i.test(message), 'must not blame the signature for a policy failure');
  });

  test('unsigned is grey and says so', () => {
    const { message, color } = textOf([unsigned]);
    assert.equal(message, 'unsigned');
    assert.equal(color, GREY);
  });

  // "signed by X" alongside an unsigned artifact would speak for that one too.
  test('a mix of signed and unsigned reports the count, not the signer', () => {
    const { message, color } = textOf([signed(WORKFLOW_ID), unsigned]);
    assert.equal(message, '1 of 2 signed');
    assert.equal(color, YELLOW);
  });

  test('warnings keep the signer but drop the green', () => {
    const { message, color } = textOf([signed(WORKFLOW_ID, { action: 'warn' })]);
    assert.equal(message, 'signed by github.com/PromptSign/promptsign-plugin');
    assert.equal(color, YELLOW);
  });

  test('several publishers are counted, since only one name would fit', () => {
    const results = [signed(WORKFLOW_ID), signed('https://github.com/other/repo/.github/workflows/s.yml@refs/heads/main')];
    assert.equal(textOf(results).message, 'signed by 2 publishers');
  });

  test('the same publisher twice is still one publisher', () => {
    const results = [signed(WORKFLOW_ID), signed(WORKFLOW_ID)];
    assert.equal(textOf(results).message, 'signed by github.com/PromptSign/promptsign-plugin');
  });

  // The green path is the one CI cannot reach: the only fixture there is
  // unsigned, so nothing on a runner ever exercises naming a real signer. This
  // is the guard against the verifier renaming a field and every signed repo's
  // badge quietly going grey while the invented fixtures above stay green.
  test('real verifier output for a signed artifact names its signer, in green', () => {
    const { message, color } = textOf([REAL_SIGNED]);
    assert.equal(message, 'signed by github.com/PromptSign/promptsign-plugin');
    assert.equal(color, GREEN);
  });

  test('an empty report claims nothing', () => {
    const { message, color } = textOf([]);
    assert.equal(message, 'nothing checked');
    assert.equal(color, GREY);
  });

  // signed:true with no identity is the local-key case: a real signature whose
  // signer is a bare public key, so there is no name to print.
  test('signed without an established identity is not reported as signed by anyone', () => {
    const { message } = textOf([signed(null)]);
    assert.equal(message, 'unsigned');
  });
});

describe('badgeSvg', () => {
  const svg = badgeSvg({ message: 'signed by github.com/o/r', color: GREEN });

  test('is a standalone SVG with no external reference', () => {
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(!svg.includes('<image'));
    assert.ok(!svg.includes('http://www.w3.org/1999/xlink'));
    // Anything fetched at render time would be stripped by GitHub's image proxy.
    assert.ok(!/href="https?:/.test(svg));
  });

  test('carries the full claim for a screen reader', () => {
    assert.ok(svg.includes('aria-label="PromptSign: signed by github.com/o/r"'));
    assert.ok(svg.includes('<title>PromptSign: signed by github.com/o/r</title>'));
  });

  test('is wide enough for its text', () => {
    const width = Number(svg.match(/width="(\d+)"/)[1]);
    assert.ok(width >= textWidth('PromptSign') + textWidth('signed by github.com/o/r'));
  });

  // Identity text originates in a certificate, so it is not ours to trust.
  test('escapes report text instead of letting it close a tag', () => {
    const hostile = badgeSvg({ message: '"><script>alert(1)</script>', color: GREEN });
    assert.ok(!hostile.includes('<script>'));
    assert.ok(hostile.includes('&lt;script&gt;'));
  });

  test('renderBadge produces the SVG for a report', () => {
    assert.match(renderBadge([signed(WORKFLOW_ID)], tally([signed(WORKFLOW_ID)])), /^<svg /);
  });
});
