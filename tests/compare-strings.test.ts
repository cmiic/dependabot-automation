import assert from 'node:assert/strict'
import test from 'node:test'

import { compareStrings } from '../src/lib/compare-strings.ts'

test('compareStrings orders by locale collation rather than by UTF-16 code unit', () => {
  // The default Array.prototype.sort() puts every capital ahead of every
  // lowercase letter, so Django and Flask would sort before django. A
  // locale-aware comparator interleaves them, which is the whole reason this
  // helper exists.
  assert.deepEqual(
    ['Django', 'django', 'Flask', 'a-pkg', 'ab'].sort(compareStrings),
    ['a-pkg', 'ab', 'django', 'Django', 'Flask']
  )
})

test('compareStrings pins the locale so the ordering cannot follow the environment', () => {
  // Regression guard: a bare a.localeCompare(b) would still satisfy Sonar's
  // S2871 while reading the runtime's default locale, which would let the same
  // input sort differently on a developer machine and on a runner. One of the
  // call sites feeds buildDependencyKey, whose output is persisted in a pull
  // request comment and compared on a later run, so a drifting order there
  // would silently invalidate an existing approval.
  const sample = ['Django', 'django', 'Flask', 'a-pkg', 'ab', 'PyYAML', 'pyyaml']
  const expected = [...sample].sort(compareStrings)

  for (const locale of ['de-DE', 'tr-TR', 'en-US', 'sv-SE']) {
    const previous = process.env.LANG
    process.env.LANG = locale
    try {
      assert.deepEqual([...sample].sort(compareStrings), expected, `ordering changed under LANG=${locale}`)
    } finally {
      if (previous === undefined) {
        delete process.env.LANG
      } else {
        process.env.LANG = previous
      }
    }
  }
})

test('compareStrings is antisymmetric and reflexive over the shapes we sort', () => {
  const sample = ['a-pkg', 'ab', 'a.b', 'pkg1', 'pkg10', 'Django', 'django', '@scope/pkg', 'requests:2.31.0:2.32.0']

  for (const a of sample) {
    assert.equal(compareStrings(a, a), 0, `${a} should equal itself`)

    for (const b of sample) {
      // Summing avoids the -0 that negating Math.sign(0) would produce, which
      // assert/strict treats as distinct from 0.
      assert.equal(
        Math.sign(compareStrings(a, b)) + Math.sign(compareStrings(b, a)),
        0,
        `comparison of ${a} and ${b} is not antisymmetric`
      )
    }
  }
})
