# Dependabot Automation

Two GitHub Actions for a Dependabot auto-merge policy:

- `merge/` evaluates Dependabot pull requests when they open or change, and writes an approval signal tied to the head SHA
- `cron/` re-checks approved PRs on a schedule and merges them once they have spent the quarantine period approved

Responsibilities are split so the PR action owns the semver/lockfile/file-surface checks (where base and head SHAs are known) and the cron action only decides when to merge already-approved candidates.

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
- preserves the first evaluation timestamp for the current head SHA, so quarantine is not reset by re-runs of the action
- carries forward the quarantine timestamp across rebases when the dependency versions are unchanged

The cron action:

- scans open Dependabot PRs directly
- verifies the latest bot-authored approval comment is `approved` for the current PR head SHA
- waits for the same quarantine period based on that approval comment timestamp
- walks candidates in approval-age order (oldest-approved first) and takes at most one advancing action per run on the oldest candidate it can actually advance: direct merge (`clean`) or enable auto-merge (`blocked`/`unstable`)
- steps over candidates the cron cannot advance on its own without holding up the queue: `behind` (waits for Dependabot's own rebase schedule), `dirty` (merge conflict, human needed), `draft`, and `unknown`/null (transient, retried next run)
- when a PR already has auto-merge enabled but the branch is `behind`, the cron disables auto-merge to protect the approval invariant (otherwise the rebased SHA could auto-merge before the cron re-validates approval) and holds the pipeline for that one run; on subsequent runs the same PR is just `behind` without auto-merge, so the queue flows past it again
- never posts comments, updates branches, or otherwise mutates the PR's commit history — this preserves the Dependabot commit-verification invariant and keeps the required token scopes minimal (the default `GITHUB_TOKEN` is enough)

### Cron decision matrix

| `auto_merge` | `mergeable_state`                | Cron action                          | Holds queue for this run? |
| ------------ | -------------------------------- | ------------------------------------ | ------------------------- |
| unset        | `clean`                          | direct merge                         | yes                       |
| unset        | `clean` (merge 405/409)          | wait for Dependabot to rebase        | no                        |
| unset        | `blocked` / `unstable`           | enable auto-merge                    | yes                       |
| unset        | `behind`                         | wait for Dependabot to rebase        | no                        |
| unset        | `dirty`                          | skip (human-resolved merge conflict) | no                        |
| unset        | `draft`                          | skip                                 | no                        |
| unset        | `unknown` / null                 | skip (transient, retried next run)   | no                        |
| set          | `behind`                         | disable auto-merge, then wait        | yes                       |
| set          | `dirty`                          | skip (human-resolved merge conflict) | no                        |
| set          | `clean` / `blocked` / `unstable` | none (already in flight)             | yes                       |

"Holds queue for this run" means `pipelineBusy = true`: subsequent, younger candidates are skipped this run. A `no` means the cron moves on to the next-oldest candidate in the same run.

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
- `failed-count`

## Notes

- Cron requires the latest machine-written approval comment from `github-actions[bot]` to say `approved` for the current PR head SHA.
- The quarantine timer is anchored to the first evaluation timestamp for the dependency versions being updated, not the PR creation time. Rebases that do not change the dependency versions preserve the original timer.
- Wrapper workflows own triggers and permissions; this repository owns the evaluation and merge behavior.
- The `merge` wrapper needs `issues: write` because approval comments are issue comments on pull requests.
- The `cron` wrapper only needs `issues: read` so it can inspect approval comments. It does not post any comments itself.
- Stale PRs are left to Dependabot's own rebase schedule. Worst-case latency on a `behind` PR is one Dependabot rebase cycle plus one cron cycle. Increase cron frequency (or tighten `dependabot.yml` update cadence) if that matters for your repo.
- Some PRs can sit open indefinitely if nothing advances them — for example, a lingering `dirty` merge conflict, a `behind` PR in a repo where Dependabot auto-rebase is disabled or has stopped, or a PR `blocked` on a permanently failing required check. The cron does not try to recover these; it logs the state and steps over them so the rest of the queue keeps flowing. Resolving the underlying issue is a human decision.
