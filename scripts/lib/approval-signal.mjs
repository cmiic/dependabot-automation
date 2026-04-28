const APPROVAL_MARKER_PREFIX = '<!-- dependabot-automation:approval '

export function buildDependencyKey(updatedDependenciesJson) {
  if (!updatedDependenciesJson) {
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(updatedDependenciesJson)
  } catch {
    return null
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null
  }

  if (parsed.some((dep) => typeof dep?.dependencyName !== 'string')) {
    return null
  }

  const entries = parsed
    .map((dep) => `${dep.dependencyName}:${dep.prevVersion ?? ''}:${dep.newVersion ?? ''}`)
    .sort()

  return entries.join(',')
}

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
  dependencyKey = null,
  fallbackCheckedAt = new Date().toISOString(),
}) {
  const checkedAt = getApprovalCheckedAt(existingPayload)

  if (!checkedAt) {
    return fallbackCheckedAt
  }

  if (existingPayload?.sha === sha) {
    return checkedAt
  }

  if (dependencyKey && existingPayload?.dependencyKey === dependencyKey && existingPayload?.status === 'approved') {
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
  dependencyFileStatus,
  lockfileStatus,
  dependencyKey = null,
  checkedAt = new Date().toISOString(),
}) {
  const resolvedDependencyFileStatus = dependencyFileStatus || lockfileStatus || 'skipped'
  const resolvedLockfileStatus = lockfileStatus || resolvedDependencyFileStatus
  const payload = JSON.stringify({
    status,
    sha,
    reason,
    packageEcosystem,
    updateType,
    dependencyFileStatus: resolvedDependencyFileStatus,
    lockfileStatus: resolvedLockfileStatus,
    dependencyKey,
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
    `- Dependency file status: \`${resolvedDependencyFileStatus}\``,
    `- Lockfile status: \`${resolvedLockfileStatus}\``,
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
