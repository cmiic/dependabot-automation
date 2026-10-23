import { compareStrings } from './compare-strings.ts'

const APPROVAL_MARKER_PREFIX = '<!-- dependabot-automation:approval '
const APPROVAL_CHECKED_AT_SLACK_MS = 5 * 60 * 1000

// Dependabot's DATE_UNAVAILABLE_DESCRIPTION (dependabot-core,
// common/lib/dependabot/update_checkers/cooldown_calculation.rb). It opens the
// pull request with this notice when a cooldown was configured but the
// registry gave no publication date for at least one dependency -- GHCR among
// them -- and lets the update through without waiting.
const UNAPPLIED_COOLDOWN_NOTICE = 'Cooldown could not be applied because no publication date was available from the registry.'

interface TrustedCommentMetadata {
  created_at: string
}

interface DependencyUpdate {
  dependencyName: string
  prevVersion?: unknown
  newVersion?: unknown
}

export interface ApprovalCommentPayload {
  status?: string
  sha?: string
  reason?: string
  packageEcosystem?: string
  updateType?: string
  dependencyFileStatus?: string
  lockfileStatus?: string
  dependencyKey?: string | null
  checkedAt?: unknown
  cooldownDays?: unknown
}

export interface BuildApprovalCommentOptions {
  status: string
  sha: string
  reason: string
  packageEcosystem: string
  updateType: string
  dependencyFileStatus?: string
  lockfileStatus?: string
  dependencyKey?: string | null
  checkedAt?: string
  cooldownDays?: number
}

export interface ResolveApprovalCheckedAtOptions {
  existingPayload?: ApprovalCommentPayload | null
  existingComment?: TrustedCommentMetadata | null
  sha: string
  dependencyKey?: string | null
  fallbackCheckedAt?: string
}

function isDependencyUpdate (value: unknown): value is DependencyUpdate {
  return typeof value === 'object' && value !== null && typeof (value as DependencyUpdate).dependencyName === 'string'
}

export function buildDependencyKey (updatedDependenciesJson?: string | null): string | null {
  if (!updatedDependenciesJson) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(updatedDependenciesJson)
  } catch {
    return null
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(entry => !isDependencyUpdate(entry))) {
    return null
  }

  const entries = parsed
    .map(dep => `${dep.dependencyName}:${dep.prevVersion ?? ''}:${dep.newVersion ?? ''}`)
    .sort(compareStrings)

  return entries.join(',')
}

export function getApprovalCheckedAt (
  payload: ApprovalCommentPayload | null | undefined,
  comment?: TrustedCommentMetadata | null
): string | null {
  if (typeof payload?.checkedAt !== 'string') {
    return null
  }

  const payloadMs = Date.parse(payload.checkedAt)
  if (Number.isNaN(payloadMs)) {
    return null
  }

  if (typeof comment?.created_at === 'string') {
    const createdMs = Date.parse(comment.created_at)
    if (!Number.isNaN(createdMs) && payloadMs < createdMs - APPROVAL_CHECKED_AT_SLACK_MS) {
      return comment.created_at
    }
  }

  return payload.checkedAt
}

// Whether an earlier evaluation covered the same update: the same head, or a
// rebase of an approved pull request that left the dependency versions alone.
function isSameUpdate ({ existingPayload, sha, dependencyKey }: {
  existingPayload?: ApprovalCommentPayload | null
  sha: string
  dependencyKey: string | null
}): boolean {
  if (existingPayload?.sha === sha) {
    return true
  }

  return Boolean(dependencyKey) && existingPayload?.dependencyKey === dependencyKey && existingPayload?.status === 'approved'
}

export function resolveApprovalCheckedAt ({
  existingPayload,
  existingComment,
  sha,
  dependencyKey = null,
  fallbackCheckedAt = new Date().toISOString()
}: ResolveApprovalCheckedAtOptions): string {
  const checkedAt = getApprovalCheckedAt(existingPayload, existingComment)

  if (checkedAt && isSameUpdate({ existingPayload, sha, dependencyKey })) {
    return checkedAt
  }

  return fallbackCheckedAt
}

export function hasUnappliedCooldownNotice (body: string | null | undefined): boolean {
  if (typeof body !== 'string') {
    return false
  }

  // The notice sits in a `> [!WARNING]` block; drop the quote markers and
  // collapse whitespace so a re-wrapped body still matches.
  const text = body.replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ').toLowerCase()

  return text.includes(UNAPPLIED_COOLDOWN_NOTICE.toLowerCase())
}

export function parseFallbackCooldownDays (raw: string | null | undefined): number {
  const value = (raw ?? '').trim()

  if (value === '') {
    return 3
  }

  // A long enough run of digits parses to Infinity, which the approval comment
  // would store as null -- a value the cron skips instead of a run that fails.
  const days = /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN

  if (!Number.isSafeInteger(days)) {
    throw new Error(`fallback-cooldown-days must be a whole number of days, got "${value}"`)
  }

  return days
}

// Missing means the approval predates the field, or no cooldown was added, and
// counts as zero. Anything else that is not a whole number of days is null, so
// a caller can refuse to merge on a value it cannot read.
export function getApprovalCooldownDays (payload: ApprovalCommentPayload | null | undefined): number | null {
  const value = payload?.cooldownDays

  if (value === undefined) {
    return 0
  }

  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

// The cooldown Dependabot could not apply is waited out first, then the
// quarantine on top: the same sequence a release goes through when Dependabot
// holds it back for the cooldown before opening the pull request.
export function requiredApprovalAgeDays ({ quarantineDays, cooldownDays }: { quarantineDays: number, cooldownDays: number }): number {
  return quarantineDays + cooldownDays
}

// Sticky for the same update, like the approval timestamp: once a pull request
// was flagged, a rebase that drops the notice from the body does not shorten
// the wait for the versions it was flagged for.
export function resolveApprovalCooldownDays ({
  existingPayload,
  sha,
  dependencyKey = null,
  detectedCooldownDays
}: {
  existingPayload?: ApprovalCommentPayload | null
  sha: string
  dependencyKey?: string | null
  detectedCooldownDays: number
}): number {
  if (!isSameUpdate({ existingPayload, sha, dependencyKey })) {
    return detectedCooldownDays
  }

  return Math.max(getApprovalCooldownDays(existingPayload) ?? 0, detectedCooldownDays)
}

export function buildApprovalComment ({
  status,
  sha,
  reason,
  packageEcosystem,
  updateType,
  dependencyFileStatus,
  lockfileStatus,
  dependencyKey = null,
  checkedAt = new Date().toISOString(),
  cooldownDays = 0
}: BuildApprovalCommentOptions): string {
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
    // Only written when set, so every other approval keeps its earlier shape.
    ...(cooldownDays > 0 ? { cooldownDays } : {})
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
    ...(cooldownDays > 0 ? [`- Cooldown: not applied by Dependabot, \`${cooldownDays}\` day(s) added before the quarantine`] : [])
  ].join('\n')
}

export function parseApprovalComment (body: string | null | undefined): ApprovalCommentPayload | null {
  if (typeof body !== 'string' || !body.startsWith(APPROVAL_MARKER_PREFIX)) {
    return null
  }

  const suffix = ' -->'
  const endIndex = body.indexOf(suffix, APPROVAL_MARKER_PREFIX.length)
  if (endIndex === -1) {
    return null
  }

  try {
    return JSON.parse(body.slice(APPROVAL_MARKER_PREFIX.length, endIndex)) as ApprovalCommentPayload
  } catch {
    return null
  }
}

export function isAutomationApprovalComment (body: string | null | undefined): boolean {
  return typeof body === 'string' && body.startsWith(APPROVAL_MARKER_PREFIX)
}
