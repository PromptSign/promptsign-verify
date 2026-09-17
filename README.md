# promptsign-verify

Check that the AI instruction files in a repo, meaning skills, agent
definitions, `CLAUDE.md` and `AGENTS.md`, still carry a valid signature from the
publisher you expect, on every pull request.

```yaml
permissions:
  contents: read          # that is all, because verifying needs no identity

steps:
  - uses: actions/checkout@v4
  - uses: PromptSign/promptsign-verify@v1
    with:
      path: skills/vendored-skill
```

No `id-token`, no secret, no network beyond fetching the Sigstore roots. So
unlike signing, **this runs on pull requests from forks**, where the untrusted
change is the thing you want checked.

## Pinning

`@v1` follows the latest `v1.x` release, so fixes arrive without editing your
workflow. It is a moving tag, which means whoever can push to this repository
decides what runs in your CI. Two tighter options, in increasing order of
strength:

```yaml
  - uses: PromptSign/promptsign-verify@v1.0.0                      # exact release
  - uses: PromptSign/promptsign-verify@8b0e6f2...  # v1.0.0        # exact commit
```

A tag can be moved and a commit SHA cannot, so the SHA is the one to use when
this check is what stands between a pull request and your main branch.
Dependabot and Renovate both update SHA pins and keep the version in the
trailing comment current.

## The two jobs it does

**As a consumer**, gate the third-party skills you vendor. A fork of a popular
skill with three extra lines in `SKILL.md` is hard to spot in review, and a
signature check is not fooled by it:

```yaml
- uses: PromptSign/promptsign-verify@v1
  with:
    path: .claude/skills
    tree: true
    identity: https://github.com/obra/*/.github/workflows/*
```

**As a publisher**, prove your own release still verifies before you ship it.
That is the same gate the promptsign release workflow runs on its own binaries.
Pair it with [`promptsign-sign`](https://github.com/PromptSign/promptsign-sign):
sign on release, verify on every PR.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `path` | *required* | What to verify, **one path per line**. Files or directories. |
| `tree` | `false` | Walk the paths as roots and report every signable artifact found, including well-known instruction files that are unsigned. Use this for a directory of vendored skills. |
| `identity` | none | The signer identity signatures must match, glob allowed: `https://github.com/OWNER/*/.github/workflows/*`. **Implies `strict`**, because an unsigned artifact cannot have the required identity. |
| `issuer` | GitHub's, when `identity` is set | The OIDC issuer signatures must come from. Set it for other IdPs. On its own it requires that *somebody* from that issuer signed, so it **implies `strict`** too. |
| `strict` | `false` | Fail on unsigned artifacts too, not only broken ones. |
| `policy` | none | Your own `policy.json`. Takes precedence over the three inputs above, which exist only to save you writing one. |
| `badge` | none | Write a README badge SVG to this path, rendered from this run. See [Badge](#badge). |
| `cli-version` | `v0.3.0` | Which [promptsign release](https://github.com/PromptSign/promptsign-cli/releases) to install. Pin it. |

## Outputs

| Output | What it is |
|---|---|
| `result` | Worst outcome across everything checked: `pass`, `warn`, or `fail`. |
| `failed` | How many artifacts failed verification. |
| `unsigned` | How many carry no signature at all. |
| `report` | Path to the full JSON report on the runner. |
| `badge` | Path to the badge SVG, when `badge` was set. |

## Badge

Set `badge` to a path and the action writes an SVG rendered from the run it
performed, naming the identity it established:

![PromptSign: signed by github.com/OWNER/REPO](docs/badge-example.svg)

```yaml
- uses: PromptSign/promptsign-verify@v1
  with:
    path: skills/
    tree: true
    badge: skills/.promptsign/badge.svg

- name: Keep the badge current
  run: |
    git add skills/.promptsign/badge.svg
    git diff --quiet --cached || {
      git -c user.name=github-actions -c user.email=github-actions@github.com \
        commit -m 'Update the PromptSign badge'
      git push
    }
```

Then reference it from your README, pointing the link wherever you like:

```markdown
[![PromptSign](skills/.promptsign/badge.svg)](https://promptsign.ai/verified)
```

**Write the badge under the signed root's `.promptsign/`, not into `.github/`.** A manifest
covers every file under the root it was made from, except the host-owned skip set, and
`.promptsign/` is in that set while `.github/` is not. If you sign a repository root and
then commit a badge to `.github/`, you have changed a file the signature covers, and the
branch fails verification until the next release re-signs it. There is no `--exclude`
flag, by design, so the carriage directory is where the badge goes. Anywhere outside the
signed root works too.

For the same reason, run the verify step **before** the commit that publishes the
signature, not after it. `.promptsign/` being excluded is what makes the tree you checked
and the tree you commit the same tree.

**The file is yours.** Nothing is hosted by PromptSign, no image is fetched from
us or from a badge service when someone reads your README, and the badge keeps
working if this project disappears. It also means no third party learns who is
reading your repository.

Three choices worth explaining:

- **It names the signer** rather than showing a bare checkmark, because *signed*
  must never be read as *safe*. A green badge says these bytes came from that
  identity, and says nothing about what they do.
- **It never names a signer on a failure**, and never names a *cause* either. A
  bundle that fails to verify still carries an identity field, and printing it
  would credit a publisher the verifier had refused to establish. The badge says
  "verification failed" rather than "signature invalid", because a failure can
  also mean the signer is not allowed by policy, or that a pinned signer changed.
  Both happen with a valid signature.
- **It is written on failing runs too.** Skipping the write would leave the last
  green badge in place on a repo that no longer verifies, which is worse than
  showing the failure.

The action renders it from a real verification rather than composing it from a
URL, so nobody can paste it onto a repo that was never signed. It is still only
as current as the last run, so treat it as a signpost to `promptsign verify`,
never as a substitute for it.

## What fails the job, and what doesn't

**Fails.** The bytes on disk are not what was signed, the signature is invalid,
the signer is not allowed by the policy in effect, or a previously pinned signer
changed. This is the case worth blocking a merge for.

**Warns, by default.** The artifact has no signature. Nearly everything in the
ecosystem is unsigned today, so a repo adopting this action should not be blocked
on day one. Set `strict: true`, or pin an `identity`, once your own dependencies
are signed and you want the gate to be real.

### The annotations you will see

Annotations land on the Files-changed tab, and every run also writes a job
summary listing each artifact, its version, and the identity that signed it.

| Annotation | What it means |
|---|---|
| `::error` on an artifact | That artifact failed. One per failing artifact. |
| `::warning` on an artifact | That artifact warned, which in practice means it is unsigned. |
| `Process completed with exit code 1` | GitHub's own annotation for the step that failed. It appears once whenever `result` is `fail`, alongside the per-artifact errors. It is not a separate problem, and there is no way to suppress it. |

Error and warning annotations for the same artifact carry the **same text**. If
you run the action twice over one artifact, once strict and once not, the two
read as a duplicate even though one is an error and the other a warning.

> **This repository's own CI shows 2 errors and 1 warning on a green run, and
> that is the expected state.** The `self-check` job runs the action twice over
> one fixture left unsigned on purpose: once with `strict: true`, which produces an
> error annotation plus the exit-code-1 annotation, and once with the defaults,
> which produces a warning. The job is green because what it asserts is the
> verdict of each run, not that each run succeeded. A green badge carrying those
> three annotations means the action is working.

## Two things worth knowing

**A signature is not a safety verdict.** It proves origin and integrity: these
exact bytes, from that identity, unchanged. A signed skill can still be a bad
skill. Review and scanning are the safety layer, and they need a stable identity
to attach a verdict to, which is what this gives them.

**Pin an identity, or the check is weaker than it looks.** Without `identity`,
"signed" only means *somebody* signed it. Trust-on-first-use cannot help here:
this action always passes `--no-pin-updates`, because pins written on a throwaway
runner vanish with it, and writing them would trust whatever signed first without
telling you. In CI, you state trust up front or you do not have it.

## Supply chain

The action downloads the promptsign release archive and checks it against the
release's `SHA256SUMS` before running it. Every archive is also published with a
detached PromptSign signature for anyone bootstrapping trust by hand. See the
[installation notes](https://github.com/PromptSign/promptsign-cli).

The action keeps trust material, TOFU pins, and the user-level policy under
`$RUNNER_TEMP` for the duration of the job. A run then depends only on the
repository and the inputs, and no `policy.json` left in the home directory of a
self-hosted runner can decide it.

Linux runners only, on x86_64 or arm64. macOS and Windows runners can call the
CLI directly, and the [release page](https://github.com/PromptSign/promptsign-cli/releases) has binaries for both.

## Learn more

Pair this with [`promptsign-sign`](https://github.com/PromptSign/promptsign-sign) to sign on release and verify on every pull request.
Full docs, including the npm SDK and the Claude Code plugin, are on the [Integrate](https://promptsign.ai/integrate?c=actions-listing) page.

## License

Apache-2.0.
