// Sonar's S2871 asks for a locale-aware comparator wherever an array of
// strings is sorted. A bare `a.localeCompare(b)` would satisfy the rule and
// make things worse: it reads the runtime's default locale, so the same
// lockfile could sort differently on a developer's machine and on a runner.
// Pinning the locale keeps the ordering deterministic everywhere, which is the
// property this codebase actually needs -- one of these sorts feeds a key that
// is persisted in a pull request comment and compared on a later run.
export function compareStrings (a: string, b: string): number {
  return a.localeCompare(b, 'en')
}
