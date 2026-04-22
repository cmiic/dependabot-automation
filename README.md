# Dependabot Automation

Two GitHub Actions for the Dependabot policy you have been maintaining in per-repo workflows:

- `merge/` evaluates Dependabot pull requests when they open or change
- `cron/` re-checks approved PRs and merges them directly after quarantine

The split is intentional:

- the PR action decides whether a PR is safe enough to be a candidate
- the cron action never tries to rediscover semver metadata from scratch
- npm lockfile checks only happen in the PR action, where the base and head SHAs are already available

That removes the brittle `origin/HEAD` logic from scheduled runs.

## Policy

By default the PR action:

- only acts on `dependabot[bot]` pull requests
- allows `github-actions`, `npm_and_yarn`, `devcontainers`, and `docker`
- allows only semver `patch` and `minor` updates
- requires Dependabot commit verification unless you explicitly opt out
- rejects pull requests that modify files outside the expected dependency-update surface for the detected ecosystem
- checks changed `package-lock.json` and `npm-shrinkwrap.json` files for newly introduced dependencies on `npm_and_yarn`
- fails closed on `npm_and_yarn` pull requests that modify unsupported lockfiles such as `yarn.lock` or `pnpm-lock.yaml`
- requires modern npm lockfiles with a `packages` object and treats new or unreadable lockfiles as manual review
- upserts a bot-authored approval comment tied to the current PR head SHA
- preserves the first evaluation timestamp for the current head SHA so quarantine cannot be bypassed by reruns
- carries forward the quarantine timestamp across rebases when the dependency versions are unchanged

The cron action:

- scans open Dependabot PRs directly
- verifies the latest bot-authored approval comment is `approved` for the current PR head SHA
- waits for the same quarantine period based on that approval comment timestamp
- processes candidates in approval-age order (oldest-approved first) so merges are deterministic
- takes at most one advancing action per run on the oldest actionable candidate: direct merge (`clean`), post an `@dependabot rebase` comment (`behind`), or enable auto-merge (`blocked`/`unstable`); younger candidates are left for a future run
- skips `dirty` (merge conflict) and `draft` candidates without holding up the queue, since those need human intervention
- asks Dependabot to rebase rather than updating the branch itself, so every commit on the PR stays authored and signed by Dependabot and the commit-verification invariant is preserved
- rebase requests are idempotent per head SHA, so the cron does not spam `@dependabot rebase` if the branch hasn't moved

## Wrapper Workflows

`merge` wrapper:

```yaml
name: Dependabot Auto-merge

on:
  pull_request:
    types:
      - opened
      - reopened
      - synchronize

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  automerge:
    runs-on: ubuntu-latest
    steps:
      - uses: cmiic/dependabot-automation/merge@<sha>
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

`cron` wrapper:

```yaml
name: Dependabot Auto-merge (Cron)

on:
  schedule:
    - cron: '0 20 * * *'
  workflow_dispatch: {}

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  automerge:
    runs-on: ubuntu-latest
    steps:
      - uses: cmiic/dependabot-automation/cron@<sha>
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

Shared inputs:

- `github-token`: required
- `quarantine-days`: default `3`

`merge`-only inputs:

- `allowed-ecosystems`: default `github-actions,npm_and_yarn,devcontainers,docker`
- `skip-commit-verification`: default `false`
  Setting this to `true` weakens the branch-tampering defense and should be treated as an explicit trust decision.
  Warning: Setting `skip-commit-verification: true` allows tampered PRs to be merged if an attacker hides malicious code inside expected files (e.g., modifying `package.json` scripts or adding malicious steps to `.github/workflows/*.yml`).

`cron`-only inputs:

- `merge-method`: default `squash`

## Outputs

`merge` exposes:

- `candidate`
- `quarantine-passed`
- `automerge-enabled`
- `reason`
- `package-ecosystem`
- `update-type`
- `age-days`
- `lockfile-status`

`cron` exposes:

- `processed-count`
- `quarantine-passed-count`
- `merged-count`
- `automerge-enabled-count`
- `already-enabled-count`
- `rebase-requested-count`
- `failed-count`

## Notes

- Existing open PRs are safe for cron as soon as the `merge` action evaluates them for the current head SHA.
- Cron requires the latest machine-written approval comment from `github-actions[bot]` to say `approved` for the current PR head SHA.
- The quarantine timer is anchored to the first evaluation timestamp for the dependency versions being updated, not the PR creation time. Rebases that do not change the dependency versions preserve the original timer.
- Wrapper workflows still own triggers and permissions. The repo only centralizes the behavior.
- The `merge` wrapper needs `issues: write` because approval comments are issue comments on pull requests.
- The `cron` wrapper needs `issues: write` so it can read approval comments and post `@dependabot rebase` comments when PRs fall behind.
- Rebases are eventually consistent — Dependabot picks up `@dependabot rebase` on its own schedule, so a stale PR typically takes at least two cron cycles to merge (one to request the rebase, one to merge after the merge action re-approves the new SHA). Increase cron frequency if that latency matters.
