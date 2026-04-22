import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRebaseComment, parseRebaseComment } from '../scripts/lib/rebase-signal.mjs'

test('buildRebaseComment round-trips via parseRebaseComment', () => {
  const sha = 'abc1234def5678'
  const comment = buildRebaseComment(sha)
  const payload = parseRebaseComment(comment)

  assert.deepEqual(payload, { sha })
})

test('buildRebaseComment produces a comment starting with @dependabot rebase', () => {
  const comment = buildRebaseComment('abc123')
  assert.ok(comment.startsWith('@dependabot rebase'))
})

test('parseRebaseComment returns null for unrelated bodies', () => {
  assert.equal(parseRebaseComment('plain comment'), null)
  assert.equal(parseRebaseComment('@dependabot rebase'), null)
  assert.equal(parseRebaseComment(''), null)
  assert.equal(parseRebaseComment(null), null)
  assert.equal(parseRebaseComment(42), null)
})

test('parseRebaseComment returns null for a malformed marker', () => {
  assert.equal(parseRebaseComment('<!-- dependabot-automation:rebase-request not-json -->'), null)
  assert.equal(parseRebaseComment('<!-- dependabot-automation:rebase-request {"sha":"abc"} '), null)
})

test('parseRebaseComment extracts sha from a comment with surrounding text', () => {
  const inner = buildRebaseComment('abc123')
  const wrapped = `Some preamble\n${inner}\nsome suffix`
  assert.deepEqual(parseRebaseComment(wrapped), { sha: 'abc123' })
})
