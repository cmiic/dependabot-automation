const APPROVAL_MARKER_PREFIX = '<!-- dependabot-automation:approval '

export function resolveApprovalCheckedAt({
  existingPayload,
  sha,
  fallbackCheckedAt = new Date().toISOString(),
}) {
  if (
    existingPayload?.sha === sha &&
    typeof existingPayload.checkedAt === 'string' &&
    !Number.isNaN(Date.parse(existingPayload.checkedAt))
  ) {
    return existingPayload.checkedAt
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
