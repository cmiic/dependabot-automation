# Security Policy

This project evaluates and auto-merges Dependabot pull requests, so weaknesses
in its policy checks can have supply-chain consequences for repositories that
use it. Security reports are taken seriously.

## Supported Versions

Only the latest state of the `main` branch is supported. Consumers pin the
action by commit SHA; if a vulnerability is fixed, update your pin to a SHA
that includes the fix.

## Reporting a Vulnerability

Please report vulnerabilities privately via GitHub's private vulnerability
reporting: go to the repository's **Security** tab and choose
**Report a vulnerability**, or use this direct link:

<https://github.com/cmiic/dependabot-automation/security/advisories/new>

**Do not report security vulnerabilities through public issues, discussions,
or pull requests.**

Please include, where possible:

- A description of the issue and its impact (e.g., a way to get a pull request
  auto-merged that the policy should have rejected)
- Steps to reproduce, ideally with a minimal example repository or workflow
- Any relevant configuration (action inputs, wrapper workflow)

## What to Expect

- Acknowledgement of your report within a few days
- An assessment of the issue and, if confirmed, a fix timeline based on
  severity
- Credit in the advisory if you would like it

This is a single-maintainer project; response times are best-effort.
