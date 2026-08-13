#!/usr/bin/env node
// The body of the promptsign-verify action: build a policy from the inputs, run
// the verifier, and turn its JSON into annotations, a job summary and outputs.
//
// Inputs arrive as PS_* environment variables (action.yml maps them), so this
// runs outside Actions unchanged, which is how it is tested.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderBadge } from './badge.mjs';

const env = process.env;
const TMP = env.RUNNER_TEMP || os.tmpdir();
const BIN = env.PROMPTSIGN_BIN || 'promptsign';
const bool = (v) => String(v ?? '').trim() === 'true';

// GitHub's issuer, used when an identity is pinned without naming an IdP.
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';

function appendTo(file, text) {
  if (file) fs.appendFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
}

const setOutput = (k, v) => appendTo(env.GITHUB_OUTPUT, `${k}=${v}`);
const summary = (text) => appendTo(env.GITHUB_STEP_SUMMARY, text);

/** `identity` / `issuer` / `strict` are sugar for a small policy file.
 *
 *  Note the vocabulary: a rule's action is off | warn | enforce, and only
 *  `enforce` turns a violation into a failure. One rule covers both "must be
 *  signed" and "must be signed by X". That is why pinning an identity
 *  necessarily also rejects unsigned artifacts: there is no level at which a
 *  wrong signer fails but a missing signature does not. An issuer on its own
 *  constrains the same way, requiring that someone from that issuer signed.
 */
export function buildPolicy({ policy, identity, issuer, strict }) {
  if (policy) return { file: policy, generated: null };

  // Nothing constrained: fall through to whatever policy the repo already has
  // (.promptsign/policy.json, or the built-in default). Broken and tampered
  // artifacts still fail, which is integrity rather than policy.
  if (!identity && !issuer && !strict) return { file: null, generated: null };

  const rule = { pattern: '*', action: 'enforce' };
  if (identity) rule.identity = identity;
  // An explicit issuer is used as given. GitHub's is filled in only to complete
  // an identity, because an identity from an unexpected issuer is a different
  // signer wearing the same name.
  if (identity || issuer) rule.issuer = issuer || GITHUB_ISSUER;
  // Trust-on-first-use on a throwaway runner would accept whichever signer
  // appeared first and record nothing. In CI, trust is stated up front.
  rule.tofu = false;

  return {
    file: path.join(TMP, 'promptsign-policy.json'),
    generated: { schema: 'promptsign/policy/v1', default: 'enforce', rules: [rule] },
  };
}

/** Paths are newline-separated so that a path may contain spaces. */
export function parsePaths(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** verify emits one object and verify-tree emits an array. Normalise to a list. */
export function normalize(chunks) {
  const out = [];
  for (const chunk of chunks) {
    const text = chunk.trim();
    if (!text) continue;
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  }
  return out;
}

export function tally(results) {
  const failed = results.filter((r) => r.action === 'fail').length;
  const warned = results.filter((r) => r.action === 'warn').length;
  const unsigned = results.filter((r) => r.signed === false).length;
  return {
    total: results.length,
    failed,
    warned,
    unsigned,
    result: failed > 0 ? 'fail' : warned > 0 ? 'warn' : 'pass',
  };
}

const messages = (r, levels) =>
  (r.findings || [])
    .filter((f) => levels.includes(f.level))
    .map((f) => f.message)
    .join('; ');

export function annotations(results) {
  const lines = [];
  for (const r of results.filter((r) => r.action === 'fail')) {
    lines.push(`::error file=${r.target}::PromptSign: ${messages(r, ['error'])}`);
  }
  for (const r of results.filter((r) => r.action === 'warn')) {
    lines.push(`::warning file=${r.target}::PromptSign: ${messages(r, ['error', 'warn'])}`);
  }
  return lines;
}

export function summaryTable(results, counts) {
  const icon = { fail: '❌', warn: '⚠️', pass: '✅' };
  const rows = results.map((r) => {
    const name = `\`${r.name || r.target}\`${r.version ? ` \`${r.version}\`` : ''}`;
    // A bundle that fails to verify has signed:true but no established signer.
    // Naming one there would report an identity that nothing has proven.
    let signer = '*unsigned*';
    if (r.signed && r.identity) signer = `\`${r.identity}\``;
    else if (r.signed && r.keyid) signer = `\`key ${String(r.keyid).slice(0, 16)}…\``;
    else if (r.signed) signer = '*signer not established*';
    return `| ${icon[r.action] || ''} | ${name} | ${signer} |`;
  });

  const lines = [
    '### PromptSign verification',
    '',
    `\`${counts.total}\` artifact(s) checked. Worst result **${counts.result}**: ` +
      `${counts.failed} failed, ${counts.warned} warned, ${counts.unsigned} unsigned.`,
    '',
    '| | Artifact | Signer |',
    '|---|---|---|',
    ...rows,
  ];

  if (counts.failed > 0) {
    lines.push(
      '',
      'A failure means the bytes on disk are not what was signed, or the signer is not',
      'allowed by policy. It does not mean the content is malicious, so check what changed.',
    );
  }
  if (counts.unsigned > 0 && counts.failed === 0) {
    lines.push(
      '',
      `${counts.unsigned} artifact(s) carry no signature, so their origin cannot be checked.`,
      'That is not a finding against them. Most of the ecosystem is still unsigned.',
    );
  }
  return lines.join('\n');
}

/** verify exits 2 when an artifact fails: a verdict, not an error, and the JSON
 *  is on stdout either way. Any other non-zero status means the verifier itself
 *  broke, which must never be reported as "nothing failed". */
function run(args) {
  const r = spawnSync(BIN, args, { encoding: 'utf8' });
  if (r.error) {
    console.log(`::error::promptsign could not be run: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0 && r.status !== 2) {
    console.log(
      `::error::promptsign exited ${r.status}. That is a verifier error, not a verification failure.`,
    );
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status || 1);
  }
  return r.stdout;
}

function main() {
  const targets = parsePaths(env.PS_PATHS);
  if (targets.length === 0) {
    console.log('::error::promptsign-verify: no paths given');
    process.exit(1);
  }

  const { file, generated } = buildPolicy({
    policy: env.PS_POLICY?.trim(),
    identity: env.PS_IDENTITY?.trim(),
    issuer: env.PS_ISSUER?.trim(),
    strict: bool(env.PS_STRICT),
  });
  if (generated) {
    fs.writeFileSync(file, `${JSON.stringify(generated, null, 2)}\n`);
    console.log(`Policy in effect:\n${JSON.stringify(generated, null, 2)}`);
  }

  // --no-pin-updates: pins written on a runner vanish with it, and writing them
  // would silently establish trust in whatever happened to sign first.
  const common = ['--json', '--no-pin-updates', ...(file ? ['--policy', file] : [])];
  const chunks = bool(env.PS_TREE)
    ? [run(['verify-tree', ...targets, ...common])]
    : targets.map((t) => run(['verify', t, ...common]));

  const results = normalize(chunks);
  const counts = tally(results);
  const report = path.join(TMP, 'promptsign-report.json');
  fs.writeFileSync(report, `${JSON.stringify(results, null, 2)}\n`);

  for (const line of annotations(results)) console.log(line);
  summary(summaryTable(results, counts));

  // Written whatever the verdict, including a failing one. A badge left behind
  // from the last good run is a stale green claim on a repo that no longer
  // verifies, which is worse than showing the failure.
  const badge = env.PS_BADGE?.trim();
  if (badge) {
    fs.mkdirSync(path.dirname(path.resolve(badge)), { recursive: true });
    fs.writeFileSync(badge, renderBadge(results, counts));
    console.log(`Badge written to ${badge}`);
    setOutput('badge', badge);
  }

  setOutput('result', counts.result);
  setOutput('failed', counts.failed);
  setOutput('unsigned', counts.unsigned);
  setOutput('report', report);

  process.exit(counts.failed > 0 ? 1 : 0);
}

// Importable for tests; only the action runs it.
if (env.PROMPTSIGN_ACTION_NO_MAIN !== '1') main();
