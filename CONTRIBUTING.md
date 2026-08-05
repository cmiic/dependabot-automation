# Contributing

Thanks for your interest in improving this project. It is a pair of GitHub
Actions (`merge/` and `cron/`) implementing a Dependabot auto-merge policy —
see the [README](README.md) for how they work.

## Before you start

- For bug reports and feature ideas, please open an issue first using the
  provided templates.
- For anything beyond a small fix, open an issue to discuss the change before
  investing time in a pull request. Policy behavior (what gets auto-merged and
  when) is deliberately conservative, and changes to it need discussion.
- Never report security vulnerabilities in public issues — see
  [SECURITY.md](SECURITY.md).

## Development setup

Requires Node.js 24 or later.

```bash
npm ci
```

## Making changes

1. Create a branch and make your change.
2. Run the checks:

   ```bash
   npm run typecheck
   npm test
   npm run lint
   ```

3. If you changed files under `src/` or runtime dependencies in
   `package.json`, rebuild the committed bundles and include them in your
   commit:

   ```bash
   npm run build
   ```

   CI runs `npm run check:dist` and fails if `dist/` does not match the
   current source tree.

4. If your change affects behavior, inputs, or outputs, update the
   [README](README.md) accordingly.

## Pull requests

- Target the `main` branch.
- Keep pull requests focused on a single change.
- Fill in the pull request template; the checklist mirrors the steps above.
