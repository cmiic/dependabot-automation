const APPROVAL_MARKER_PREFIX = '<!-- dependabot-automation:approval '

export function getApprovalCheckedAt(payload) {
  if (typeof payload?.checkedAt !== 'string') {
    return null
  }

  if (Number.isNaN(Date.parse(payload.checkedAt))) {
    return null
  }

  return payload.checkedAt
}

export function resolveApprovalCheckedAt({
  existingPayload,
  sha,
  fallbackCheckedAt = new Date().toISOString(),
}) {
  const checkedAt = getApprovalCheckedAt(existingPayload)

  if (existingPayload?.sha === sha && checkedAt) {
    return checkedAt
  }

  return fallbackCheckedAt
}

export function buildApprovalComment({
  status,
  sha,
  reason,
  packageEcosystem,
  updateType,
  lockfileStatus,
  checkedAt = new Date().toISOString(),
}) {
  const payload = JSON.stringify({
    status,
    sha,
    reason,
    packageEcosystem,
    updateType,
    lockfileStatus,
    checkedAt,
  })

  const humanStatus = status === 'approved' ? 'approved' : 'not approved'

  return [
    `${APPROVAL_MARKER_PREFIX}${payload} -->`,
    '',
    `Dependabot auto-merge evaluation for \`${sha}\`: ${humanStatus}.`,
    '',
    `- Status: \`${status}\``,
    `- Head SHA: \`${sha}\``,
    `- Reason: \`${reason}\``,
    `- Ecosystem: \`${packageEcosystem || 'unknown'}\``,
    `- Update type: \`${updateType || 'unknown'}\``,
    `- Lockfile status: \`${lockfileStatus || 'skipped'}\``,
    `- Checked at: \`${checkedAt}\``,
  ].join('\n')
}

export function parseApprovalComment(body) {
  if (typeof body !== 'string' || !body.startsWith(APPROVAL_MARKER_PREFIX)) {
    return null
  }

  const suffix = ' -->'
  const endIndex = body.indexOf(suffix, APPROVAL_MARKER_PREFIX.length)
  if (endIndex === -1) {
    return null
  }

  try {
    return JSON.parse(body.slice(APPROVAL_MARKER_PREFIX.length, endIndex))
  } catch {
    return null
  }
}

export function isAutomationApprovalComment(body) {
  return typeof body === 'string' && body.startsWith(APPROVAL_MARKER_PREFIX)
}
