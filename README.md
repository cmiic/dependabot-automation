# Dependabot Automation

Two GitHub Actions for the Dependabot policy you have been maintaining in per-repo workflows:

- `merge/` evaluates Dependabot pull requests when they open or change
- `cron/` re-checks approved PRs and enables auto-merge after quarantine

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
- checks changed `package-lock.json` and `npm-shrinkwrap.json` files for newly introduced dependencies on `npm_and_yarn`
- requires modern npm lockfiles with a `packages` object and treats new or unreadable lockfiles as manual review
- upserts a bot-authored approval comment tied to the current PR head SHA
- preserves the first evaluation timestamp for the current head SHA so quarantine cannot be bypassed by reruns

The cron action:

- scans open Dependabot PRs directly
- verifies the latest bot-authored approval comment is `approved` for the current PR head SHA
- waits for the same quarantine period based on that approval comment timestamp
- is the only action that enables auto-merge

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
  issues: read
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
- `merge-method`: default `merge`

`merge`-only inputs:

- `allowed-ecosystems`: default `github-actions,npm_and_yarn,devcontainers,docker`
- `skip-commit-verification`: default `true`

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
- `automerge-enabled-count`
- `already-enabled-count`
- `failed-count`

## Notes

- Existing open PRs are safe for cron as soon as the `merge` action evaluates them for the current head SHA.
- Cron requires the latest machine-written approval comment from `github-actions[bot]` to say `approved` for the current PR head SHA.
- The quarantine timer is anchored to the approval comment timestamp for the current head SHA, not the PR creation time.
- Wrapper workflows still own triggers and permissions. The repo only centralizes the behavior.
- The `merge` wrapper needs `issues: write` because approval comments are issue comments on pull requests.
- The `cron` wrapper needs `issues: read` so it can inspect approval comments.
