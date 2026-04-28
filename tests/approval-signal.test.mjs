import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildApprovalComment,
  buildDependencyKey,
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
    dependencyFileStatus: 'clear',
    lockfileStatus: 'clear',
    dependencyKey: 'vue:3.5.31:3.5.32',
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
    dependencyFileStatus: 'clear',
    lockfileStatus: 'clear',
    dependencyKey: 'vue:3.5.31:3.5.32',
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

test('resolveApprovalCheckedAt preserves the timestamp when sha changes but dependencyKey matches', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      status: 'approved',
      dependencyKey: 'vue:3.5.31:3.5.32',
      checkedAt: '2026-04-07T12:00:00.000Z',
    },
    sha: 'def456',
    dependencyKey: 'vue:3.5.31:3.5.32',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z',
  })

  assert.equal(checkedAt, '2026-04-07T12:00:00.000Z')
})

test('resolveApprovalCheckedAt resets the timestamp when both sha and dependencyKey change', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      dependencyKey: 'vue:3.5.31:3.5.32',
      checkedAt: '2026-04-07T12:00:00.000Z',
    },
    sha: 'def456',
    dependencyKey: 'vue:3.5.31:3.5.33',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z',
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('resolveApprovalCheckedAt resets when dependencyKey is null on both sides', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      checkedAt: '2026-04-07T12:00:00.000Z',
    },
    sha: 'def456',
    dependencyKey: null,
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z',
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('resolveApprovalCheckedAt resets when dependencyKey matches but previous status was rejected', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      status: 'rejected',
      dependencyKey: 'vue:3.5.31:3.5.32',
      checkedAt: '2026-04-07T12:00:00.000Z',
    },
    sha: 'def456',
    dependencyKey: 'vue:3.5.31:3.5.32',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z',
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('buildDependencyKey produces a stable sorted key', () => {
  const json = JSON.stringify([
    { dependencyName: 'b-pkg', prevVersion: '1.0.0', newVersion: '1.0.1' },
    { dependencyName: 'a-pkg', prevVersion: '2.0.0', newVersion: '2.1.0' },
  ])

  assert.equal(buildDependencyKey(json), 'a-pkg:2.0.0:2.1.0,b-pkg:1.0.0:1.0.1')
})

test('buildDependencyKey returns null for invalid input', () => {
  assert.equal(buildDependencyKey(null), null)
  assert.equal(buildDependencyKey(''), null)
  assert.equal(buildDependencyKey('not-json'), null)
  assert.equal(buildDependencyKey('[]'), null)
})

test('getApprovalCheckedAt rejects missing or invalid timestamps', () => {
  assert.equal(getApprovalCheckedAt({}), null)
  assert.equal(getApprovalCheckedAt({ checkedAt: 123 }), null)
  assert.equal(getApprovalCheckedAt({ checkedAt: 'not-a-date' }), null)
  assert.equal(getApprovalCheckedAt({ checkedAt: '2026-04-10T12:00:00.000Z' }), '2026-04-10T12:00:00.000Z')
})
