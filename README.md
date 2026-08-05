# Dependabot Automation

Two GitHub Actions for a Dependabot auto-merge policy:

- `merge/` evaluates Dependabot pull requests when they open or change, and writes an approval signal tied to the head SHA
- `cron/` re-checks approved PRs on a schedule and merges them once they have spent the quarantine period approved

Responsibilities are split so the PR action owns the semver/lockfile/file-surface checks (where base and head SHAs are known) and the cron action only decides when to merge already-approved candidates.

## Policy

By default the PR action:

- only acts on `dependabot[bot]` pull requests
- allows `github_actions`, `npm_and_yarn`, `devcontainers`, `docker`, `uv`, and `pip`
- allows only semver `patch` and `minor` updates
- requires Dependabot commit verification unless you explicitly opt out
- rejects pull requests that modify files outside the expected dependency-update surface for the detected ecosystem
- checks changed `package-lock.json` and `npm-shrinkwrap.json` files for newly introduced dependencies on `npm_and_yarn`
- fails closed on `npm_and_yarn` pull requests that modify unsupported lockfiles such as `yarn.lock` or `pnpm-lock.yaml`
- requires at least one changed supported npm lockfile for `npm_and_yarn`; missing, deleted, new, or unreadable supported lockfiles are manual review
- allows only `pyproject.toml` and `uv.lock` for `uv` pull requests and requires a changed `uv.lock`
- checks changed `uv.lock` files for newly introduced dependencies on `uv`
- treats new, deleted, unreadable, or malformed `uv.lock` files as manual review
- checks changed pip requirement files for newly introduced dependencies on `pip` only when the parser can compare them safely
- treats dependency removals, requirement variant changes, added or removed complex installable lines, new or deleted requirement files, unreadable files, and ambiguous text files under `requirements/` whose contents are not recognizable as requirements syntax or contain unparseable lines as manual review
- treats `pip` support as requirements/constraints-file-only; changes to `pyproject.toml`, `setup.py`, `setup.cfg`, `Pipfile`, `Pipfile.lock`, `poetry.lock`, or other Python packaging files require manual review
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
  contents: read
  pull-requests: write

jobs:
  automerge:
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: cmiic/dependabot-automation/merge@<sha>
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          quarantine-days: "1"
```

The job-level `dependabot[bot]` gate is not strictly required — the action itself ignores non-Dependabot pull requests — but it skips the runner spin-up on every human PR, and it is a small extra safeguard: if this repository were ever compromised and you reference the action by tag or branch instead of a pinned SHA, the action code would not execute on your non-Dependabot PRs at all.

`cron` wrapper:

```yaml
name: Dependabot Auto-merge (Cron)

on:
  schedule:
    - cron: '0 20 * * *'
  workflow_dispatch: {}

permissions:
  contents: write
  pull-requests: write

jobs:
  automerge:
    runs-on: ubuntu-latest
    steps:
      - uses: cmiic/dependabot-automation/cron@<sha>
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          quarantine-days: "1"
```

### Combined wrapper (optional, lower latency)

Without this, an approved PR whose quarantine has passed waits for the next scheduled cron run even when a rebase has just re-validated it. To merge on the PR event itself, run the cron action as a second step of the `merge` wrapper, gated on the evaluation result:

```yaml
name: Dependabot Auto-merge

on:
  pull_request:
    types:
      - opened
      - reopened
      - synchronize

permissions:
  contents: write # the cron step merges via the pull request merge endpoint
  pull-requests: write

jobs:
  automerge:
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - id: evaluate
        uses: cmiic/dependabot-automation/merge@<sha>
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          quarantine-days: "1"

      - if: steps.evaluate.outputs.quarantine-passed == 'true'
        uses: cmiic/dependabot-automation/cron@<sha>
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          quarantine-days: "1"
```

Notes on this pattern:

- The typical trigger path is a Dependabot rebase (`synchronize`) after quarantine has passed: the evaluation carries the quarantine timestamp forward, `quarantine-passed` is `true`, and the cron step advances the queue immediately instead of waiting for the schedule. On `opened`, quarantine has not passed yet, so the cron step is skipped.
- Keep the scheduled `cron` wrapper as well. Quarantine expiry is a time event, not a PR event: a PR that sees no further pushes or rebases after its quarantine passes is only picked up by the schedule.
- The inline cron step uses the same queue semantics as the scheduled one: it advances the oldest approved candidate it can actually advance, which may be a different PR than the one that triggered the run. With several PRs piled up, each Dependabot event advances one.
- Concurrent runs (several PR events close together, or overlap with the scheduled cron) are tolerated: a losing direct merge surfaces as 405/409 and is stepped over, and enabling auto-merge is idempotent.
- This grants `contents: write` to a `pull_request`-triggered workflow, unlike the evaluation-only `merge` wrapper which needs just `contents: read`. The `dependabot[bot]` gate and Dependabot commit verification are the controls standing between that token and a tampered branch — do not combine this pattern with `skip-commit-verification: true`.

## Inputs

Shared inputs:

- `github-token`: required
- `quarantine-days`: default `3`
  Since July 2026, Dependabot version updates apply a 3-day package cooldown by default before a PR is even opened, so new releases are already at least three days old on arrival. Stacking the full default quarantine on top of that mostly adds latency; `quarantine-days: "1"` (as in the examples above) is usually enough. Note that security updates skip the cooldown, so the quarantine is still the only delay for those. The default remains `3` so existing setups keep their behavior unchanged; expect it to be lowered in a future major version.

`merge`-only inputs:

- `allowed-ecosystems`: default `github_actions,npm_and_yarn,devcontainers,docker,uv,pip`
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
- `dependency-file-status`
- `lockfile-status` (legacy alias for `dependency-file-status`)

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
- The action runtime is shipped as committed ESM bundles under `dist/`; consuming repositories do not need to provide `package.json` or `package-lock.json` for this action to bootstrap.
- On GitHub.com, pull request comment reads and writes used by this action work with the `pull-requests` permission, so separate `issues:*` scopes are not required for these wrapper workflows.
- On GitHub.com, the `merge` wrapper needs `contents: read` to inspect the checked-out PR head and fetch the base SHA for policy checks.
- On GitHub.com, the `cron` wrapper still needs `contents: write` because the pull request merge endpoint is gated by repository contents write access.
- Stale PRs are left to Dependabot's own rebase schedule. Worst-case latency on a `behind` PR is one Dependabot rebase cycle plus one cron cycle. Increase cron frequency (or tighten `dependabot.yml` update cadence) if that matters for your repo.
- Some PRs can sit open indefinitely if nothing advances them — for example, a lingering `dirty` merge conflict, a `behind` PR in a repo where Dependabot auto-rebase is disabled or has stopped, or a PR `blocked` on a permanently failing required check. The cron does not try to recover these; it logs the state and steps over them so the rest of the queue keeps flowing. Resolving the underlying issue is a human decision.

## Maintainers

- After changing files under `src/` or runtime dependencies in `package.json`, run `npm run typecheck`, `npm test`, and `npm run build`, then commit the updated files under `dist/`.
- CI runs `npm run check:dist` to ensure the committed bundles match the current source tree.
