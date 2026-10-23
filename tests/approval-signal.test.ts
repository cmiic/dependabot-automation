import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildApprovalComment,
  buildDependencyKey,
  getApprovalCheckedAt,
  getApprovalCooldownDays,
  hasUnappliedCooldownNotice,
  isAutomationApprovalComment,
  parseApprovalComment,
  parseFallbackCooldownDays,
  requiredApprovalAgeDays,
  resolveApprovalCheckedAt,
  resolveApprovalCooldownDays
} from '../src/lib/approval-signal.ts'

// The opening of a Dependabot pull request body for an image on a registry
// that gives no publication date.
const UNAPPLIED_COOLDOWN_BODY = [
  '> [!WARNING]',
  '> Cooldown could not be applied because no publication date was available from the registry.',
  '>',
  '',
  'Bumps [astral-sh/uv](https://github.com/astral-sh/uv) from 0.11.7 to 0.13.1.'
].join('\n')

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
    checkedAt: '2026-04-10T12:00:00.000Z'
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
    checkedAt: '2026-04-10T12:00:00.000Z'
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
      checkedAt: '2026-04-07T12:00:00.000Z'
    },
    sha: 'abc123',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z'
  })

  assert.equal(checkedAt, '2026-04-07T12:00:00.000Z')
})

test('resolveApprovalCheckedAt resets the timestamp for a new sha', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      checkedAt: '2026-04-07T12:00:00.000Z'
    },
    sha: 'def456',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z'
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('resolveApprovalCheckedAt preserves the timestamp when sha changes but dependencyKey matches', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      status: 'approved',
      dependencyKey: 'vue:3.5.31:3.5.32',
      checkedAt: '2026-04-07T12:00:00.000Z'
    },
    sha: 'def456',
    dependencyKey: 'vue:3.5.31:3.5.32',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z'
  })

  assert.equal(checkedAt, '2026-04-07T12:00:00.000Z')
})

test('resolveApprovalCheckedAt resets the timestamp when both sha and dependencyKey change', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      dependencyKey: 'vue:3.5.31:3.5.32',
      checkedAt: '2026-04-07T12:00:00.000Z'
    },
    sha: 'def456',
    dependencyKey: 'vue:3.5.31:3.5.33',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z'
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('resolveApprovalCheckedAt resets when dependencyKey is null on both sides', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      checkedAt: '2026-04-07T12:00:00.000Z'
    },
    sha: 'def456',
    dependencyKey: null,
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z'
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('resolveApprovalCheckedAt resets when dependencyKey matches but previous status was rejected', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      status: 'rejected',
      dependencyKey: 'vue:3.5.31:3.5.32',
      checkedAt: '2026-04-07T12:00:00.000Z'
    },
    sha: 'def456',
    dependencyKey: 'vue:3.5.31:3.5.32',
    fallbackCheckedAt: '2026-04-10T12:00:00.000Z'
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('buildDependencyKey produces a stable sorted key', () => {
  const json = JSON.stringify([
    { dependencyName: 'b-pkg', prevVersion: '1.0.0', newVersion: '1.0.1' },
    { dependencyName: 'a-pkg', prevVersion: '2.0.0', newVersion: '2.1.0' }
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

test('getApprovalCheckedAt clamps backdated payload to comment.created_at', () => {
  const clamped = getApprovalCheckedAt(
    { checkedAt: '2024-01-01T00:00:00.000Z' },
    { created_at: '2026-04-10T12:00:00.000Z' }
  )

  assert.equal(clamped, '2026-04-10T12:00:00.000Z')
})

test('getApprovalCheckedAt preserves payload within clock-skew slack', () => {
  const checkedAt = getApprovalCheckedAt(
    { checkedAt: '2026-04-10T11:58:00.000Z' },
    { created_at: '2026-04-10T12:00:00.000Z' }
  )

  assert.equal(checkedAt, '2026-04-10T11:58:00.000Z')
})

test('getApprovalCheckedAt ignores malformed comment.created_at and falls back to payload', () => {
  const checkedAt = getApprovalCheckedAt(
    { checkedAt: '2026-04-07T12:00:00.000Z' },
    { created_at: 'not-a-date' }
  )

  assert.equal(checkedAt, '2026-04-07T12:00:00.000Z')
})

test('getApprovalCheckedAt without comment metadata behaves as before', () => {
  assert.equal(
    getApprovalCheckedAt({ checkedAt: '2024-01-01T00:00:00.000Z' }),
    '2024-01-01T00:00:00.000Z'
  )
})

test('resolveApprovalCheckedAt clamps backdated payload on same-sha path', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      checkedAt: '2024-01-01T00:00:00.000Z'
    },
    existingComment: { created_at: '2026-04-10T12:00:00.000Z' },
    sha: 'abc123',
    fallbackCheckedAt: '2026-04-11T12:00:00.000Z'
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('resolveApprovalCheckedAt clamps backdated payload on dependency-key carry-forward', () => {
  const checkedAt = resolveApprovalCheckedAt({
    existingPayload: {
      sha: 'abc123',
      status: 'approved',
      dependencyKey: 'vue:3.5.31:3.5.32',
      checkedAt: '2024-01-01T00:00:00.000Z'
    },
    existingComment: { created_at: '2026-04-10T12:00:00.000Z' },
    sha: 'def456',
    dependencyKey: 'vue:3.5.31:3.5.32',
    fallbackCheckedAt: '2026-04-11T12:00:00.000Z'
  })

  assert.equal(checkedAt, '2026-04-10T12:00:00.000Z')
})

test('hasUnappliedCooldownNotice finds Dependabot\'s warning in a pull request body', () => {
  assert.equal(hasUnappliedCooldownNotice(UNAPPLIED_COOLDOWN_BODY), true)
  assert.equal(hasUnappliedCooldownNotice(UNAPPLIED_COOLDOWN_BODY.replaceAll('\n', '\r\n')), true)
})

test('hasUnappliedCooldownNotice still matches the warning re-wrapped across quote lines', () => {
  const rewrapped = [
    '> [!WARNING]',
    '> Cooldown could not be applied because no publication',
    '>   date was available from the registry.'
  ].join('\n')

  assert.equal(hasUnappliedCooldownNotice(rewrapped), true)
})

test('hasUnappliedCooldownNotice ignores bodies without the warning', () => {
  assert.equal(hasUnappliedCooldownNotice('Bumps [vue](https://github.com/vuejs/core) from 3.5.31 to 3.5.32.'), false)
  assert.equal(hasUnappliedCooldownNotice('> [!WARNING]\n> Cooldown could not be applied.'), false)
  assert.equal(hasUnappliedCooldownNotice(''), false)
  assert.equal(hasUnappliedCooldownNotice(null), false)
  assert.equal(hasUnappliedCooldownNotice(undefined), false)
})

test('parseFallbackCooldownDays defaults to Dependabot\'s three days and reads whole days', () => {
  assert.equal(parseFallbackCooldownDays(undefined), 3)
  assert.equal(parseFallbackCooldownDays(''), 3)
  assert.equal(parseFallbackCooldownDays('0'), 0)
  assert.equal(parseFallbackCooldownDays(' 7 '), 7)
})

test('parseFallbackCooldownDays rejects anything but a whole number of days', () => {
  for (const raw of ['-1', '1.5', 'three', '3d']) {
    assert.throws(() => parseFallbackCooldownDays(raw), /fallback-cooldown-days must be a whole number of days/, raw)
  }
})

test('getApprovalCooldownDays reads missing as zero and refuses unreadable values', () => {
  assert.equal(getApprovalCooldownDays({}), 0)
  assert.equal(getApprovalCooldownDays(null), 0)
  assert.equal(getApprovalCooldownDays({ cooldownDays: 0 }), 0)
  assert.equal(getApprovalCooldownDays({ cooldownDays: 3 }), 3)

  for (const cooldownDays of [-1, 1.5, '3', null, Number.NaN]) {
    assert.equal(getApprovalCooldownDays({ cooldownDays }), null, String(cooldownDays))
  }
})

test('requiredApprovalAgeDays waits out the cooldown before the quarantine', () => {
  assert.equal(requiredApprovalAgeDays({ quarantineDays: 1, cooldownDays: 3 }), 4)
  assert.equal(requiredApprovalAgeDays({ quarantineDays: 1, cooldownDays: 0 }), 1)
})

test('buildApprovalComment records cooldown days only when some were added', () => {
  const options = {
    status: 'approved',
    sha: 'abc123',
    reason: 'eligible',
    packageEcosystem: 'docker',
    updateType: 'version-update:semver-minor',
    dependencyKey: 'astral-sh/uv:0.11.7:0.13.1',
    checkedAt: '2026-10-17T21:23:54.764Z'
  }

  const flagged = buildApprovalComment({ ...options, cooldownDays: 3 })
  assert.equal(parseApprovalComment(flagged)?.cooldownDays, 3)
  assert.match(flagged, /- Cooldown: not applied by Dependabot, `3` day\(s\) added before the quarantine/)

  const unflagged = buildApprovalComment({ ...options, cooldownDays: 0 })
  assert.equal(Object.hasOwn(parseApprovalComment(unflagged) ?? {}, 'cooldownDays'), false)
  assert.doesNotMatch(unflagged, /Cooldown:/)
})

test('resolveApprovalCooldownDays takes the detected days for a new update', () => {
  assert.equal(resolveApprovalCooldownDays({ sha: 'abc', detectedCooldownDays: 3 }), 3)
  assert.equal(resolveApprovalCooldownDays({ sha: 'abc', detectedCooldownDays: 0 }), 0)
  assert.equal(resolveApprovalCooldownDays({
    existingPayload: { status: 'approved', sha: 'old', dependencyKey: 'uv:0.11.7:0.13.1', cooldownDays: 3 },
    sha: 'new',
    dependencyKey: 'uv:0.11.7:0.13.2',
    detectedCooldownDays: 0
  }), 0)
})

test('resolveApprovalCooldownDays keeps the days for the same update when the warning disappears', () => {
  const existingPayload = { status: 'approved', sha: 'abc', dependencyKey: 'uv:0.11.7:0.13.1', cooldownDays: 3 }

  assert.equal(resolveApprovalCooldownDays({ existingPayload, sha: 'abc', detectedCooldownDays: 0 }), 3)
  assert.equal(resolveApprovalCooldownDays({ existingPayload, sha: 'rebased', dependencyKey: 'uv:0.11.7:0.13.1', detectedCooldownDays: 0 }), 3)
  assert.equal(resolveApprovalCooldownDays({ existingPayload, sha: 'abc', detectedCooldownDays: 5 }), 5)
})

test('resolveApprovalCooldownDays does not carry days across a rejected rebase or an unreadable value', () => {
  assert.equal(resolveApprovalCooldownDays({
    existingPayload: { status: 'rejected', sha: 'old', dependencyKey: 'uv:0.11.7:0.13.1', cooldownDays: 3 },
    sha: 'rebased',
    dependencyKey: 'uv:0.11.7:0.13.1',
    detectedCooldownDays: 0
  }), 0)
  assert.equal(resolveApprovalCooldownDays({
    existingPayload: { status: 'approved', sha: 'abc', cooldownDays: 'three' },
    sha: 'abc',
    detectedCooldownDays: 3
  }), 3)
})
