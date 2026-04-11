import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildApprovalComment,
  getApprovalCheckedAt,
  isAutomationApprovalComment,
  parseApprovalComment,
  resolveApprovalCheckedAt,
} from '../scripts/lib/approval-signal.mjs'

test('buildApprovalComment creates a parseable machine marker', () => {
  const comment = buildApprovalComment({
    status: 'approved',
    sha: 'abc123',
    reason: 'eligible',
    packageEcosystem: 'npm_and_yarn',
    updateType: 'version-update:semver-minor',
    lockfileStatus: 'clear',
    checkedAt: '2026-04-10T12:00:00.000Z',
  })

  assert.equal(isAutomationApprovalComment(comment), true)

  const payload = parseApprovalComment(comment)

  assert.deepEqual(payload, {
    status: 'approved',
    sha: 'abc123',
    reason: 'eligible',
    packageEcosystem: 'npm_and_yarn',
    updateType: 'version-update:semver-minor',
    lockfileStatus: 'clear',
    checkedAt: '2026-04-10T12:00:00.000Z',
  })
})

test('parseApprovalComment ignores unrelated bodies', () => {
  assert.equal(parseApprovalComment('plain comment'), null)
  assert.equal(isAutomationApprovalComment('plain comment'), false)
})

test('resolveApprovalCheckedAt preserves the original timestamp for the same sha', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      checkedAt: '2026-04-07T12:00:00.000Z',
    },
    sha: 'abc123',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z',
  })

  assert.equal(checkedAt, '2026-04-07T12:00:00.000Z')
})

test('resolveApprovalCheckedAt resets the timestamp for a new sha', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      checkedAt: '2026-04-07T12:00:00.000Z',
    },
    sha: 'def456',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z',
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('getApprovalCheckedAt rejects missing or invalid timestamps', () => {
  assert.equal(getApprovalCheckedAt({}), null)
  assert.equal(getApprovalCheckedAt({ checkedAt: 123 }), null)
  assert.equal(getApprovalCheckedAt({ checkedAt: 'not-a-date' }), null)
  assert.equal(getApprovalCheckedAt({ checkedAt: '2026-04-10T12:00:00.000Z' }), '2026-04-10T12:00:00.000Z')
})
